import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { consumerPackages } from './consumer-packages.mjs'
import { stopProcess } from './stop-process.ts'
import { verifyNativeDeclarations } from './declarations.ts'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url)),
    consumer = process.env.LITI_VITE_CONSUMER
        ? resolve(process.env.LITI_VITE_CONSUMER)
        : await mkdtemp(join(tmpdir(), 'liti-model-vite-'))
assert.ok(consumer.startsWith(resolve(tmpdir(), 'liti-model-vite-')), 'Reuse only the isolated Vite test consumer')
const run = (command, args, cwd = consumer) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
    if (command !== 'tar') console.log(result.stdout)
    return result.stdout
}
const archives = await consumerPackages(consumer, run)
const modelArchive = `model-${createHash('sha256')
    .update(await readFile(archives['@litijs/model']))
    .digest('hex')
    .slice(0, 16)}.tgz`
await cp(archives['@litijs/model'], join(consumer, modelArchive))
await cp(resolve(root, 'test/fixtures/model-vite'), consumer, { recursive: true })
await cp(resolve(root, 'test/fixtures/vitehub/patches'), join(consumer, 'patches'), { recursive: true })
const native = JSON.parse(await readFile(resolve(root, 'test/fixtures/vitehub/package.json'), 'utf8'))
const patchedDependencies = { ...native.patchedDependencies }
delete patchedDependencies['nitropack@2.13.5']
await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
        {
            name: 'liti-model-vite-consumer',
            private: true,
            type: 'module',
            workspaces: [],
            packageManager: 'bun@1.4.4',
            dependencies: {
                '@litijs/model': `file:./${modelArchive}`,
                'vite-hub': native.dependencies['vite-hub'],
                nitro: '3.0.260903-beta',
                h3: '2.0.1-rc.33',
                'drizzle-orm': '0.45.4',
                zod: '4.6.7',
                'comark-content': '0.4.1',
            },
            devDependencies: { vite: '8.3.5', typescript: '6.0.3', '@types/node': '26.6.5', 'drizzle-kit': '0.31.11' },
            patchedDependencies,
        },
        null,
        2,
    ),
)
await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
        extends: ['vite-hub/tsconfig'],
        compilerOptions: {
            target: 'ES2024',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            types: ['node'],
        },
        include: ['server/**/*.ts', 'vite.config.ts'],
    }),
)
console.log(`Nuxt-free native Model consumer: ${consumer}`)
run('bun', ['install'])
assert.equal(existsSync(join(consumer, 'node_modules/nuxt')), false, 'The standalone runtime must not install Nuxt')
const database = join(consumer, '.vitehub/data/database/sqlite.db')
const databaseBefore = existsSync(database) ? await readFile(database) : null
run(process.execPath, ['node_modules/vite-hub/dist/bin.js', 'types', 'prepare'])
await verifyNativeDeclarations(consumer, 'tsconfig.json', [
    'vite-hub',
    'vite-hub/content',
    'vite-hub/database/drizzle',
    'vite-hub/workspace',
    'nitro',
    'h3',
])
run(process.execPath, ['node_modules/vite-hub/dist/bin.js', 'db', 'generate'])
assert.deepEqual(
    existsSync(database) ? await readFile(database) : null,
    databaseBefore,
    'Generation must not create or change the database',
)
run(process.execPath, ['node_modules/vite-hub/dist/bin.js', 'db', 'migrate'])
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'])
await access(join(consumer, '.output/server/index.mjs'))
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const { port } = probe.address()
await new Promise((done, reject) => probe.close((error) => (error ? reject(error) : done())))
const origin = `http://127.0.0.1:${port}`,
    token = crypto.randomUUID()
for (const mode of ['production', 'development']) {
    const child = spawn(
        process.execPath,
        mode === 'production'
            ? ['.output/server/index.mjs']
            : ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        {
            cwd: consumer,
            env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LITI_PROBE_TOKEN: token },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        },
    )
    let logs = ''
    child.stdout.on('data', (value) => {
        logs += value
    })
    child.stderr.on('data', (value) => {
        logs += value
    })
    try {
        let ready = false
        for (let attempt = 0; attempt < 100; attempt++) {
            if (child.exitCode !== null) throw new Error(`Standalone server exited:\n${logs}`)
            try {
                if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) {
                    ready = true
                    break
                }
            } catch {}
            await new Promise((done) => setTimeout(done, 100))
        }
        assert.ok(ready, logs)
        assert.equal((await fetch(`${origin}/api/model`, { method: 'POST' })).status, 403)
        const result = await fetch(`${origin}/api/model`, {
            method: 'POST',
            headers: { 'x-liti-probe': token },
            signal: AbortSignal.timeout(60000),
        })
        assert.equal(result.status, 200, `${await result.clone().text()}\n${logs}`)
        for (const check of (await result.json()).checks) console.log(`PASS ${check}`)
        if (mode === 'development') {
            const health = join(consumer, 'server/api/health.get.ts'),
                original = await readFile(health, 'utf8')
            try {
                await writeFile(health, original.replace('ok: true', 'ok: true, reloaded: true'))
                let reloaded = false
                for (let attempt = 0; attempt < 100; attempt++) {
                    await new Promise((done) => setTimeout(done, 100))
                    try {
                        if (
                            (await (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).json())
                                .reloaded
                        ) {
                            reloaded = true
                            break
                        }
                    } catch {}
                }
                assert.ok(reloaded, `Native dev server did not reload the edited route:\n${logs}`)
                console.log('PASS Nuxt-free native Vite dev server and server-route HMR')
            } finally {
                await writeFile(health, original)
            }
        }
    } finally {
        await stopProcess(child)
    }
}
