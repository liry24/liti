import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { stopProcess } from './stop-process.ts'

const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const { port } = probe.address()
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())))
const origin = `http://127.0.0.1:${port}`
const cloudflare = process.env.LITI_DEV_R2 === 'true',
    token = crypto.randomUUID()
const child = spawn(
    process.execPath,
    [
        'node_modules/nuxt/bin/nuxt.mjs',
        'dev',
        '--no-fork',
        '--no-tui',
        '--no-takeover',
        '--strictPort',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
    ],
    {
        cwd: process.cwd(),
        env: { ...process.env, LITI_PROBE_PRESET: cloudflare ? 'cloudflare' : 'node', LITI_PROBE_TOKEN: token },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
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
    for (let attempt = 0; attempt < 240; attempt++) {
        if (child.exitCode !== null) throw new Error(`Nuxt dev exited:\n${logs}`)
        try {
            if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) {
                ready = true
                break
            }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.ok(ready, logs)
    const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
            name: 'Dev editor',
            email: `editor-${crypto.randomUUID()}@example.test`,
            password: 'Synthetic-dev-password-2026',
        }),
    })
    assert.equal(signup.status, 200, `${await signup.clone().text()}\n${logs}`)
    const user = (await signup.json()).user,
        cookie = signup.headers
            .getSetCookie()
            .map((value) => value.split(';')[0])
            .join('; ')
    const fetchReady = async (url, options = {}) => {
        for (let attempt = 0; attempt < 120; attempt++) {
            const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) })
            if (
                response.status !== 503 ||
                !response.headers.get('content-type')?.includes('text/html') ||
                !(await response.clone().text()).includes('__NUXT_LOADING__')
            )
                return response
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        throw new Error(`Nuxt remained on its HMR loading page:\n${logs}`)
    }
    const manage = (body) =>
        fetchReady(`${origin}/api/_liti/manage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin, cookie },
            body: JSON.stringify(body),
        })
    const metadata = await manage({ action: 'models' })
    assert.equal(metadata.status, 200, `${await metadata.clone().text()}\n${logs}`)
    const publicPage = await fetchReady(`${origin}/query?id=missing-dev-entry`)
    assert.equal(publicPage.status, 200, `${await publicPage.clone().text()}\n${logs}`)
    assert.ok((await publicPage.text()).includes('id="many"'), logs)
    if (cloudflare) {
        const config = JSON.parse(await readFile('.nuxt/vitehub-blob-wrangler.json', 'utf8'))
        assert.equal(config.d1_databases, undefined, 'Native CLI migrations and Nuxt dev keep the same SQLite database')
        assert.deepEqual(config.r2_buckets.map((bucket) => bucket.binding).sort(), ['BLOB', 'CONTENT'])
        const upload = await fetchReady(`${origin}/api/__blob`, {
            method: 'POST',
            headers: { 'x-liti-probe': token },
        })
        assert.equal(upload.status, 200, `${await upload.clone().text()}\n${logs}`)
        const { pathname } = await upload.json()
        const file = await fetchReady(`${origin}/media/${pathname}`)
        assert.equal(file.status, 200, `${await file.clone().text()}\n${logs}`)
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([0, 1, 2, 255]))
        console.log(
            'PASS Cloudflare Nuxt dev R2 bytes and native local SQLite authentication without HTTP storage credentials',
        )
    }
    const file = new URL('./server/models/memos.ts', import.meta.url),
        original = await readFile(file, 'utf8')
    try {
        await writeFile(file, original.replace("name: 'memos',", "name: 'memos', label: 'Reloaded memo',"))
        let reloaded = false
        for (let attempt = 0; attempt < 120; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 250))
            try {
                const response = await manage({ action: 'models' })
                if (
                    response.ok &&
                    (await response.json()).some((model) => model.name === 'memos' && model.label === 'Reloaded memo')
                ) {
                    reloaded = true
                    break
                }
            } catch {}
        }
        assert.ok(reloaded, `Model definition did not reload:\n${logs}`)
        const secret = `DEV_PRIVATE_${crypto.randomUUID()}`
        const saved = await manage({
            action: 'save',
            model: 'memos',
            id: user.id,
            data: { title: 'Dev memo', secret },
            ifDigest: null,
        })
        assert.equal(saved.status, 200, `${await saved.clone().text()}\n${logs}`)
        const page = await fetchReady(`${origin}/private?id=${user.id}`, { headers: { cookie } })
        assert.equal(page.status, 200, `${await page.clone().text()}\n${logs}`)
        assert.ok((await page.text()).includes(secret), logs)
        assert.ok(!(await (await fetchReady(`${origin}/private?id=${user.id}`)).text()).includes(secret))
        console.log('PASS Nuxt dev model-definition HMR, native authenticated writes and private SSR')
    } finally {
        try {
            await stopProcess(child)
        } finally {
            await writeFile(file, original)
        }
    }
} finally {
    await stopProcess(child)
}
