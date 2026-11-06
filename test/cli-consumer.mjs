import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { consumerPackages, consumerTemporaryRoot, archiveDependencies, archiveOverrides } from './consumer-packages.mjs'

const directory = await mkdtemp(join(consumerTemporaryRoot, 'liti-cli-consumer-'))
const run = (command, args, cwd = directory) => {
    console.log(`CLI consumer: ${command} ${args.join(' ')}`)
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
}
const archives = await consumerPackages(directory, run)
const native = JSON.parse(await readFile(new URL('./fixtures/vitehub/package.json', import.meta.url), 'utf8'))
await writeFile(
    join(directory, 'package.json'),
    JSON.stringify(
        {
            name: 'liti-cli-packed-consumer',
            private: true,
            type: 'module',
            workspaces: [],
            packageManager: 'bun@1.4.4',
            dependencies: {
                ...native.dependencies,
                ...archiveDependencies(archives, ['@litijs/model', 'liti', '@litijs/blog']),
            },
            devDependencies: native.devDependencies,
            ...archiveOverrides(archives, 'bun'),
        },
        null,
        2,
    ),
)
await writeFile(
    join(directory, 'nuxt.config.ts'),
    `// Preserve the application's explicit native settings.\nexport default defineNuxtConfig({compatibilityDate:'2026-10-26',modules:[['vite-hub/nuxt',{preset:'node',auth:false,console:false,agent:false,schedule:false}]],devtools:{enabled:false},app:{head:{title:'CLI consumer'}}})\n`,
)
await writeFile(
    join(directory, 'tsconfig.json'),
    await readFile(new URL('./fixtures/vitehub/tsconfig.json', import.meta.url)),
)
console.log(`Packed CLI consumer: ${directory}`)
run('bun', ['install'])
const cli = ['node_modules/liti/dist/cli/index.js']
assert.ok(run(process.execPath, [...cli, '--help']).includes('never applies migrations'))
const original = await readFile(join(directory, 'nuxt.config.ts'), 'utf8')
assert.ok(run(process.execPath, [...cli, 'init', '--dry-run']).includes('Dry run: no files'))
assert.equal(await readFile(join(directory, 'nuxt.config.ts'), 'utf8'), original)
assert.equal(existsSync(join(directory, 'server/content.ts')), false)
run(process.execPath, [...cli, 'init'])
const model = await readFile(join(directory, 'server/models/posts.ts'), 'utf8'),
    content = await readFile(join(directory, 'server/content.ts'), 'utf8')
assert.match(model, /authorize:\s*\(\)\s*=>\s*false/u)
assert.match(content, /defineContent\(\{extends:cms/u)
assert.ok((await readFile(join(directory, 'nuxt.config.ts'), 'utf8')).includes('CLI consumer'))
const require = createRequire(join(directory, 'package.json'))
const installed = JSON.parse(await readFile(require.resolve('liti/package.json'), 'utf8'))
const required = JSON.parse(await readFile(join(directory, 'node_modules/liti/dist/patches/required.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
for (const [target, path] of Object.entries(required)) {
    assert.equal(manifest.patchedDependencies[target], path)
    assert.deepEqual(
        await readFile(join(directory, path)),
        await readFile(join(directory, 'node_modules/liti/dist/patches', path.split('/').at(-1))),
    )
}
run(process.execPath, [...cli, 'init'])
assert.equal(await readFile(join(directory, 'server/models/posts.ts'), 'utf8'), model)
assert.equal(await readFile(join(directory, 'server/content.ts'), 'utf8'), content)
const database = join(directory, '.vitehub/data/database/sqlite.db')
assert.equal(existsSync(database), false)
run(process.execPath, [...cli, 'generate'])
assert.equal(existsSync(database), false, 'The real official generator must not create a database')
run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'typecheck'])
await access(join(directory, '.nuxt/types/liti.d.ts'))
const commit = installed.dependencies['@litijs/model'].match(/@([a-f0-9]{40})$/u)?.[1]
if (commit) {
    run(process.execPath, [...cli, 'add', 'blog'])
    assert.match(await readFile(join(directory, 'nuxt.config.ts'), 'utf8'), /@litijs\/blog\/nuxt/u)
    run(process.execPath, [...cli, 'remove', 'blog'])
    assert.doesNotMatch(await readFile(join(directory, 'nuxt.config.ts'), 'utf8'), /@litijs\/blog\/nuxt/u)
    run(process.execPath, [...cli, 'upgrade', '--to', commit])
    const upgraded = JSON.parse(await readFile(require.resolve('liti/package.json'), 'utf8'))
    assert.equal(upgraded.dependencies['vite-hub'], installed.dependencies['vite-hub'])
    assert.equal(upgraded.dependencies['@litijs/model'], installed.dependencies['@litijs/model'])
} else {
    assert.ok(run(process.execPath, [...cli, 'add', 'blog', '--dry-run']).includes('@litijs/blog'))
    assert.ok(
        run(process.execPath, [...cli, 'upgrade', '--to', installed.version, '--dry-run']).includes(
            `liti@${installed.version}`,
        ),
    )
    console.log(
        'Local tarballs: add/upgrade plans only; actual cohort install is checked with commit-specific previews.',
    )
}
assert.equal(await readFile(join(directory, 'server/models/posts.ts'), 'utf8'), model)
assert.equal(await readFile(join(directory, 'server/content.ts'), 'utf8'), content)
assert.equal(existsSync(database), false)
console.log(
    'PASS packed CLI explicit/idempotent init, identical consumer root patches, generated types and no database mutation',
)
