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
    const rpc = async (action, body, cookie = '') =>
        await fetch(`${origin}/_vitehub/rpc/__call`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-vitehub-console': '1', cookie, origin },
            body: JSON.stringify({
                method: 'vitehub:console:documents',
                input: {
                    method: 'POST',
                    query: { section: 'content', action },
                    body,
                },
            }),
        })
    assert.equal((await rpc('list', { collection: 'posts' })).status, 401)
    const session = async (role) => {
        const email = `${role}-${crypto.randomUUID()}@example.test`
        const response = await fetch(`${origin}/api/auth/sign-up/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: JSON.stringify({ name: role, email, password: 'Synthetic-probe-password-2026' }),
        })
        const result = await response.text()
        assert.equal(response.status, 200, `${result}\n${logs}`)
        const cookie = response.headers
            .getSetCookie()
            .map((item) => item.split(';')[0])
            .join('; ')
        assert.ok(cookie)
        const current = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie } })
        assert.equal(current.status, 200)
        assert.equal((await current.json()).user.email, email)
        return cookie
    }
    const editor = await session('editor')
    const reader = await session('reader')
    const document = {
        collection: 'posts',
        id: crypto.randomUUID(),
        data: { title: 'Console' },
        body: 'Console body',
        ifDigest: null,
    }
    assert.equal((await rpc('save', document, reader)).status, 403)
    const savedResponse = await rpc('save', document, editor)
    const savedText = await savedResponse.text()
    assert.equal(savedResponse.status, 200, `${savedText}\n${logs}`)
    const saved = JSON.parse(savedText).value
    assert.equal(saved.data.title, 'Console')
    const forbidden = await rpc(
        'save',
        { ...document, data: { title: 'CONSOLE_FORBIDDEN_PROBE' }, ifDigest: saved.digest },
        editor,
    )
    assert.equal(forbidden.status, 500)
    const unchanged = await rpc('get', { collection: 'posts', id: document.id }, editor)
    assert.equal((await unchanged.json()).value.digest, saved.digest)
    assert.equal(
        (await rpc('publish', { collection: 'posts', expect: [{ id: document.id, digest: saved.digest }] }, reader))
            .status,
        403,
    )
    const published = await rpc(
        'publish',
        { collection: 'posts', expect: [{ id: document.id, digest: saved.digest }] },
        editor,
    )
    assert.equal(published.status, 200, `${await published.text()}\n${logs}`)
    console.log('PASS Auth signup/session and Console RPC authorization/validation/publication')
    const denied = await fetch(`${origin}/api/__probe`, { method: 'POST' })
    assert.equal(denied.status, 403)
    const response = await fetch(`${origin}/api/__probe`, {
        method: 'POST',
        headers: { 'x-liti-probe': token },
        signal: AbortSignal.timeout(30_000),
    })
    const body = await response.text()
    assert.equal(response.status, 200, `${body}\n${logs}`)
    const result = JSON.parse(body)
    assert.equal(result.checks.length, 6)
    for (const check of result.checks) console.log(`PASS ${check}`)
} finally {
    if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
    }
}
