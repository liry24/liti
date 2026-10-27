import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as checks from './verify-http.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(root, '.output/server')
const config = JSON.parse(await readFile(resolve(serverRoot, 'wrangler.json'), 'utf8'))
assert.ok(
    config.d1_databases.some((database) => database.binding === 'DB' && database.database_id.startsWith('00000000-')),
)
assert.ok(config.r2_buckets.some((bucket) => bucket.binding === 'BLOB'))
assert.ok(config.compatibility_flags.includes('nodejs_compat'))
assert.ok(!config.compatibility_flags.includes('no_nodejs_compat_v2'))
assert.ok(config.triggers.crons.includes('* * * * *'))
const token = crypto.randomUUID()
config.main = resolve(serverRoot, config.main)
config.assets.directory = resolve(serverRoot, config.assets.directory)
for (const database of config.d1_databases) database.migrations_dir = resolve(serverRoot, database.migrations_dir)
config.vars = { ...config.vars, LITI_PROBE_TOKEN: token }
await mkdir(resolve(root, '.vitehub'), { recursive: true })
const testRoot = await mkdtemp(resolve(root, '.vitehub/worker-probe-'))
const configPath = resolve(testRoot, 'wrangler.json')
await writeFile(configPath, JSON.stringify(config))
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js')
const persistence = resolve(testRoot, 'state')
const migrate = spawnSync(
    process.execPath,
    [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--config', configPath, '--persist-to', persistence],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' } },
)
assert.equal(migrate.status, 0, `${migrate.stdout}\n${migrate.stderr}`)

const portProbe = createServer()
portProbe.listen(0, '127.0.0.1')
await once(portProbe, 'listening')
const { port } = portProbe.address()
await new Promise((done, reject) => portProbe.close((error) => (error ? reject(error) : done())))
const origin = `http://127.0.0.1:${port}`
const inspectorProbe = createServer()
inspectorProbe.listen(0, '127.0.0.1')
await once(inspectorProbe, 'listening')
const inspectorPort = inspectorProbe.address().port
await new Promise((done, reject) => inspectorProbe.close((error) => (error ? reject(error) : done())))
let child
let logs = ''
const start = async () => {
    child = spawn(
        process.execPath,
        [
            wrangler,
            'dev',
            '--local',
            '--test-scheduled',
            '--config',
            configPath,
            '--persist-to',
            persistence,
            '--ip',
            '127.0.0.1',
            '--port',
            String(port),
            '--inspector-port',
            String(inspectorPort),
        ],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    child.stdout.on('data', (value) => {
        logs += value
    })
    child.stderr.on('data', (value) => {
        logs += value
    })
    for (let attempt = 0; attempt < 200; attempt++) {
        if (child.exitCode !== null) throw new Error(`workerd exited: ${logs}`)
        try {
            const page = await fetch(origin, { signal: AbortSignal.timeout(1_000) })
            if (page.ok && (await page.text()).includes('ViteHub distribution probe')) return
        } catch {}
        await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error(`workerd did not become ready: ${logs}`)
}
const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    if (process.platform === 'win32')
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill()
    await exited
}
try {
    await start()
    const { editor, documentId } = await checks.verifyHttp(origin, token, () => logs)
    const snapshot = async (input) => {
        const response = await fetch(`${origin}/api/__snapshot`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-liti-probe': token },
            body: JSON.stringify(input),
        })
        const body = await response.text()
        assert.equal(response.status, 200, `${body}\n${logs}`)
        return JSON.parse(body)
    }
    const queued = await snapshot({})
    await stop()
    await start()
    const session = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie: editor } })
    assert.equal(session.status, 200, logs)
    assert.ok((await session.json()).user?.email.startsWith('editor-'), logs)
    const published = await fetch(`${origin}/api/probe-public/${documentId}`)
    const publishedBody = await published.text()
    assert.equal(published.status, 200, `${publishedBody}\n${logs}`)
    assert.equal(JSON.parse(publishedBody).data.title, 'Console')
    const before = await snapshot({ id: queued.id })
    assert.equal(before.published, null)
    await new Promise((done) => setTimeout(done, Math.max(0, queued.at - Date.now() + 1)))
    const trigger = async () => {
        const cron = await fetch(`${origin}/__scheduled?cron=${encodeURIComponent('* * * * *')}`)
        assert.equal(cron.status, 200, `${await cron.text()}\n${logs}`)
    }
    await Promise.all([trigger(), trigger()])
    const after = await snapshot({ id: queued.id })
    assert.equal(after.published.data.title, 'Durable reviewed snapshot')
    assert.equal(after.draft.digest, queued.digest)
    assert.equal(after.head.parentId, before.head.id)
    await trigger()
    assert.equal((await snapshot({ id: queued.id })).head.id, after.head.id)
    console.log('PASS workerd restart retains D1 authentication and R2-backed publication')
    console.log('PASS restarted Worker Cron publishes a durable snapshot once and retains newer draft edits')
    const verifyPerformance = Reflect.get(checks, 'verifyPerformance')
    if (typeof verifyPerformance === 'function')
        await verifyPerformance({
            origin,
            token,
            inspectorPort,
            restart: async () => {
                await stop()
                await start()
            },
            logs: () => logs,
        })
} finally {
    await stop()
}
