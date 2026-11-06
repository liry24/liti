import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

// Reuse the pinned Wrangler client's WebSocket to send its required inspector Origin.
const require = createRequire(import.meta.url)
const { WebSocket } = createRequire(require.resolve('wrangler/package.json'))('ws')

async function inspector(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const target = targets.find((item) => item.webSocketDebuggerUrl)
    assert.ok(target, 'No inspector target for the owned workerd process')
    const endpoint = new URL(target.webSocketDebuggerUrl)
    assert.equal(Number(endpoint.port), port)
    const socket = new WebSocket(endpoint, { origin: 'http://localhost' })
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', reject, { once: true })
    })
    let next = 0
    const pending = new Map()
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)),
            request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        clearTimeout(request.timer)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
    })
    return {
        close: () => socket.close(),
        send: (method, params = {}) =>
            new Promise((resolve, reject) => {
                const id = ++next,
                    timer = setTimeout(() => {
                        pending.delete(id)
                        reject(new Error(`Inspector timeout: ${method}`))
                    }, 10000)
                pending.set(id, { resolve, reject, timer })
                socket.send(JSON.stringify({ id, method, params }))
            }),
    }
}

export async function verifyContentPerformance({ origin, token, inspectorPort, restart, logs }) {
    const connection = await inspector(inspectorPort)
    await connection.send('Runtime.getHeapUsage')
    connection.close()
    const dataset = crypto.randomUUID(),
        count = 200
    const call = async (body) => {
        const response = await fetch(`${origin}/api/__perf`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-liti-probe': token },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
        })
        assert.equal(response.status, 200, `${await response.clone().text()}\n${logs()}`)
        return await response.json()
    }
    for (let index = 0; index < count; index++) {
        await call({ action: 'seed', dataset, index })
        if ((index + 1) % 25 === 0) console.log(`Performance seed: ${index + 1}/${count} entries`)
    }
    await restart()
    const client = await inspector(inspectorPort)
    try {
        const before = await client.send('Runtime.getHeapUsage'),
            start = performance.now()
        const result = await call({ action: 'query', dataset }),
            elapsedMs = performance.now() - start
        const after = await client.send('Runtime.getHeapUsage')
        assert.equal(result.page.total, count)
        assert.equal(result.page.items.length, count)
        let bodyBytes = 0
        for (const entry of result.page.items) {
            assert.equal(entry.body.includes('PRIVATE_LATER_DRAFT'), false)
            assert.equal(entry.data.cover.pathname, `bench/${dataset}.png`)
            bodyBytes += Buffer.byteLength(entry.body)
        }
        assert.ok(bodyBytes > 4 * 1024 * 1024)
        assert.ok(result.metrics.r2.get > 0, 'The cold query must measure real R2 reads')
        assert.equal(result.metrics.r2.put ?? 0, 0)
        assert.equal(result.metrics.r2.delete ?? 0, 0)
        assert.ok(after.usedSize < 96 * 1024 * 1024, `Retained result heap exceeded 96 MiB: ${after.usedSize}`)
        assert.ok(elapsedMs < 30000, `Cold local query exceeded 30s: ${elapsedMs}`)
        const metrics = {
            environment: 'local workerd with real D1/R2 bindings',
            entries: count,
            translations: count / 2,
            revisionsPerOriginal: 5,
            revisionsPerTranslation: 2,
            originalBodyBytes: 32768,
            translatedBodyBytes: 16384,
            publishedBodyBytes: bodyBytes,
            queryMs: result.metrics.queryMs,
            responseMs: elapsedMs,
            heapBefore: before,
            heapWithRetainedResult: after,
            r2: result.metrics.r2,
        }
        await writeFile(new URL('./performance-result.json', import.meta.url), JSON.stringify(metrics, null, 2))
        console.log(`PASS workerd Content scale: ${JSON.stringify(metrics)}`)
    } finally {
        client.close()
    }
}
