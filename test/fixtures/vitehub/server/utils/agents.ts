import assert from 'node:assert/strict'
import { defineAgent, runAgent } from 'vite-hub/agent'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { content } from '../content'

const inputSchema = z.object({ body: z.string().min(1) })
const outputSchema = z.object({ body: z.string().min(1) })
const response = (text: string): Awaited<ReturnType<MockLanguageModelV4['doGenerate']>> => ({
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
})

export async function verifyAgents() {
    const nativeFetch = globalThis.fetch
    globalThis.fetch = async () => {
        throw new Error('PROBE_AGENT_NETWORK_DISABLED')
    }
    try {
        return await verifyOfflineAgents()
    } finally {
        globalThis.fetch = nativeFetch
    }
}

async function verifyOfflineAgents() {
    const model = new MockLanguageModelV4({
        doGenerate: response('{"body":"Reviewed text"}'),
    })
    const agent = defineAgent({
        runtime: false,
        data: inputSchema,
        capabilities: [],
        driver: { model, maxRetries: 0, output: { schema: outputSchema, maxAttempts: 1 } },
    })
    assert.equal(model.doGenerateCalls.length, 0)
    const data = inputSchema.parse({ body: 'Original text' })
    const [error, result] = await runAgent(agent, { data, prompt: JSON.stringify(data) })
    assert.equal(error, null)
    assert.deepEqual(result, { body: 'Reviewed text' })
    assert.equal(model.doGenerateCalls.length, 1)
    assert.ok(JSON.stringify(model.doGenerateCalls[0]?.prompt).includes('Original text'))
    const [invalidInput] = await runAgent(agent, { data: { body: '' }, prompt: 'Do not run' })
    assert.ok(invalidInput)
    assert.equal(model.doGenerateCalls.length, 1)

    const badModel = new MockLanguageModelV4({ doGenerate: response('{"body":42}') })
    const badAgent = defineAgent({
        runtime: false,
        driver: { model: badModel, maxRetries: 0, output: { schema: outputSchema, maxAttempts: 1 } },
    })
    const [invalidOutput] = await runAgent(badAgent, { prompt: 'Return structured output' })
    assert.ok(invalidOutput)
    assert.equal(badModel.doGenerateCalls.length, 1)

    let started = false
    const controller = new AbortController()
    const canceledModel = new MockLanguageModelV4({
        doGenerate: ({ abortSignal }) =>
            new Promise((_resolve, reject) => {
                started = true
                abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
                controller.abort(new DOMException('Probe canceled', 'AbortError'))
            }),
    })
    const canceledAgent = defineAgent({ runtime: false, driver: { model: canceledModel, maxRetries: 0 } })
    const [canceled] = await runAgent(canceledAgent, { prompt: 'Cancel this request', abortSignal: controller.signal })
    assert.ok(started)
    assert.ok(canceled)
    assert.equal(canceledModel.doGenerateCalls.length, 1)
    const bypass = defineAgent({
        runtime: false,
        driver: {
            run: () =>
                content.collection('managed').save(crypto.randomUUID(), { data: { title: 'Agent bypass' }, body: '' }),
        },
    })
    const [bypassError] = await runAgent(bypass, { prompt: 'Try generic content save' })
    assert.ok(bypassError)
    assert.match(`${String(bypassError)} ${JSON.stringify(bypassError)}`, /PROBE_MANAGED_ROUTE_REQUIRED/)
    return [
        'offline mock inline Agent input/output, prompt, bounded attempts, cancellation and managed-write rejection',
    ]
}
