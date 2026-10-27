import { verifyHttp } from './verify-http.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const commit = '24ddab7ff9885d1b5ea176b8824f6e3f1a0e3ca9'
const manifest = JSON.parse(await readFile(resolve(root, 'node_modules/vite-hub/package.json'), 'utf8'))
for (const name of ['./content', './content/presets/cms', './nuxt', './workspace/blob-database']) {
    assert.ok(manifest.exports[name], `Missing installed export ${name}`)
    await access(resolve(root, 'node_modules/vite-hub', manifest.exports[name].types))
    await access(resolve(root, 'node_modules/vite-hub', manifest.exports[name].import))
}
for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (name.startsWith('@vite-hub/')) assert.equal(version, `https://pkg.pr.new/vite-hub/vitehub/${name}@${commit}`)
}

const portProbe = createServer()
portProbe.listen(0, '127.0.0.1')
await once(portProbe, 'listening')
const { port } = portProbe.address()
await new Promise((done, reject) => portProbe.close((error) => (error ? reject(error) : done())))
const token = crypto.randomUUID()
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LITI_PROBE_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
child.stdout.on('data', (data) => {
    logs += data
})
child.stderr.on('data', (data) => {
    logs += data
})
const origin = `http://127.0.0.1:${port}`
try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`Built consumer exited: ${logs}`)
        try {
            const page = await fetch(origin, { signal: AbortSignal.timeout(1_000) })
            if (page.ok && (await page.text()).includes('ViteHub distribution probe')) {
                ready = true
                break
            }
        } catch {}
        await new Promise((done) => setTimeout(done, 100))
    }
    assert.ok(ready, `Built consumer did not become ready: ${logs}`)
    await verifyHttp(origin, token, () => logs)
} finally {
    if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
    }
}
