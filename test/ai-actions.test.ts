import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { APICallError } from 'ai'
import { Experimental_DecisionMockModelV4, MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import {
    defineLitiConfig,
    resolveLitiConfig as resolveConfig,
    LitiError,
    type LitiConfigInput,
} from '../packages/liti/src'
import { executeAction } from '../packages/liti/src/server/actions'
import { handleActionRequest } from '../packages/liti/src/server/actions-http'
import {
    ai,
    createTextAction,
    createDecisionAction,
    createExtractionAction,
    createSlugGenerator,
} from '../packages/ai/src'
import { aiSdk } from '../packages/ai/src/ai-sdk'
import { voidAi } from '../packages/ai/src/void'

const native = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('void/ai', () => ({ ai: native }))
const resolveLitiConfig = <const Config extends LitiConfigInput>(config: Config) => resolveConfig(config, [])
const result = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
})
const context = {
    actor: { id: 'editor', roles: ['editor'] },
    request: new Request('https://site.test/manage/actions/proofread'),
}
const admin = { actor: { id: 'admin', roles: ['admin'] } }
const setup = (generate: MockLanguageModelV4['doGenerate'] = async () => result('{"content":"Corrected"}')) => {
    const run = vi.fn(generate)
    const config = resolveLitiConfig(
        defineLitiConfig({
            authorization: { roles: { editor: { actions: ['proofread', 'plain', 'safe'] } } },
            plugins: [
                ai({
                    provider: aiSdk({ text: new MockLanguageModelV4({ doGenerate: run }) }),
                    actions: {
                        proofread: createTextAction({
                            input: z
                                .object({ content: z.string(), count: z.string().transform(Number).optional() })
                                .strict(),
                            prompt: ({ content, count }) => content + (count ?? ''),
                            output: z.object({ content: z.string() }),
                        }),
                        plain: createTextAction({
                            input: z.object({ content: z.string() }).strict(),
                            prompt: ({ content }) => content,
                        }),
                        safe: createTextAction({
                            input: z.object({ content: z.string(), version: z.number() }).strict(),
                            prompt: ({ content, version }) => {
                                if (version !== 3) throw new LitiError('LITI_CONFLICT', 'Version changed.')
                                return content
                            },
                            output: ({ content }) =>
                                z.object({
                                    content: z
                                        .string()
                                        .refine((generated) => generated.includes(content), 'Must preserve input.'),
                                }),
                        }),
                    },
                }),
            ],
        }),
    )
    return { config, run }
}

describe('capability-based named AI actions', () => {
    it.each(['length', 'content-filter'] as const)('rejects incomplete structured output (%s)', async (reason) => {
        const { config } = setup(async () => ({
            ...result('{"content":"Looks complete"}'),
            finishReason: { unified: reason, raw: undefined },
        }))
        await expect(executeAction(config, 'proofread', { content: 'Original' }, context)).rejects.toMatchObject({
            code: 'LITI_AI_OUTPUT_INVALID',
        })
    })
    it('transforms input before the provider and preserves usage and finish metadata', async () => {
        const { config, run } = setup()
        const output = await executeAction(config, 'proofread', { content: 'Input', count: '2' }, context)
        expect(output).toMatchObject({
            data: { content: 'Corrected' },
            metadata: { finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
        })
        expect(run.mock.calls[0]?.[0].prompt).toContainEqual({
            role: 'user',
            content: [{ type: 'text', text: 'Input2' }],
        })
        expect((await executeAction(config, 'plain', { content: 'Text' }, context)).data).toBe(
            '{"content":"Corrected"}',
        )
    })
    it.each([
        { actor: null, name: 'proofread', input: { content: 'x' }, code: 'LITI_AUTH_REQUIRED' },
        { actor: { id: 'user', roles: ['user'] }, name: 'proofread', input: { content: 'x' }, code: 'LITI_FORBIDDEN' },
        { actor: context.actor, name: 'proofread', input: {}, code: 'LITI_INVALID_INPUT' },
        { actor: context.actor, name: 'proofread', input: { content: 4 }, code: 'LITI_INVALID_INPUT' },
    ])('rejects $code before inference', async ({ actor, name, input, code }) => {
        const { config, run } = setup()
        await expect(
            executeAction(config, name as 'proofread', input as { content: string }, { ...context, actor }),
        ).rejects.toMatchObject({ code })
        expect(run).not.toHaveBeenCalled()
    })
    it('runs application guards and rejects dynamic output', async () => {
        const { config, run } = setup()
        await expect(
            executeAction(config, 'safe', { content: 'https://original.test', version: 2 }, context),
        ).rejects.toMatchObject({ code: 'LITI_CONFLICT' })
        expect(run).not.toHaveBeenCalled()
        await expect(
            executeAction(config, 'safe', { content: 'https://original.test', version: 3 }, context),
        ).rejects.toMatchObject({ code: 'LITI_AI_FAILED' })
    })
    it('snapshots input during asynchronous validation and resolves models from operation context', async () => {
        let release!: () => void
        const wait = new Promise<void>((resolve) => {
            release = resolve
        })
        const prompt = vi.fn(({ content }: { content: string }) => content)
        const resolver = vi.fn(async () => new MockLanguageModelV4({ doGenerate: async () => result('Text') }))
        const config = resolveLitiConfig(
            defineLitiConfig({
                plugins: [
                    ai({
                        provider: aiSdk({ text: resolver }),
                        actions: {
                            action: createTextAction({
                                input: z.object({
                                    content: z.string().refine(async () => {
                                        await wait
                                        return true
                                    }),
                                }),
                                prompt,
                            }),
                        },
                    }),
                ],
            }),
        )
        const input = { content: 'Original' }
        const platformContext = { binding: 'app' }
        const pending = executeAction(config, 'action', input, { ...context, ...admin, platformContext })
        input.content = 'Changed'
        release()
        expect((await pending).data).toBe('Text')
        expect(prompt).toHaveBeenCalledWith({ content: 'Original' }, expect.anything())
        expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ request: context.request, platformContext }))
    })
    it('uses zero retries by default and redacts provider errors', async () => {
        const { config, run } = setup(async () => {
            throw new APICallError({
                message: 'PRIVATE_KEY',
                url: 'https://private.test',
                requestBodyValues: {},
                isRetryable: true,
            })
        })
        await expect(executeAction(config, 'plain', { content: 'x' }, context)).rejects.toMatchObject({
            code: 'LITI_AI_FAILED',
            message: 'AI action failed.',
        })
        expect(run).toHaveBeenCalledOnce()
    })
    it('propagates abort and rejects elapsed deadlines', async () => {
        const controller = new AbortController()
        const { config, run } = setup(
            async ({ abortSignal }) =>
                new Promise((_, reject) => {
                    abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
                }),
        )
        const pending = executeAction(config, 'plain', { content: 'x' }, { ...context, signal: controller.signal })
        await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
        controller.abort(new DOMException('Cancelled', 'AbortError'))
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await expect(
            executeAction(config, 'plain', { content: 'x' }, { ...context, deadline: Date.now() - 1 }),
        ).rejects.toMatchObject({ name: 'TimeoutError' })
        expect(run).toHaveBeenCalledOnce()
    })
    it('preserves native decision choices, probability meanings, usage and rounding', async () => {
        const decide = vi.fn<Experimental_DecisionMockModelV4['doDecide']>(async () => ({
            answers: {
                category: { type: 'choice', choice: 'technology', probabilities: { technology: 0.8, diary: 0.2 } },
                safe: { type: 'boolean', probability: 0.25 },
                score: { type: 'score', score: 0.75, probabilities: { '0': 0.25, '1': 0.75 } },
            },
            usage: { inputTokens: 4, outputTokens: 3 },
            rounding: { probabilityDecimals: 2 },
            warnings: [],
        }))
        const config = resolveLitiConfig(
            defineLitiConfig({
                plugins: [
                    ai({
                        provider: aiSdk({ decision: new Experimental_DecisionMockModelV4({ doDecide: decide }) }),
                        actions: {
                            classify: createDecisionAction({
                                input: z.object({ content: z.string() }),
                                state: ({ content }) => ({ content }),
                                questions: {
                                    category: { type: 'choice', criteria: { technology: 'Tech', diary: 'Diary' } },
                                    safe: { type: 'boolean', instructions: 'Safe?' },
                                    score: { type: 'score', criteria: ['low', 'high'] },
                                },
                            }),
                        },
                    }),
                ],
            }),
        )
        expect(await executeAction(config, 'classify', { content: 'SDK types' }, admin)).toMatchObject({
            data: {
                category: { choice: 'technology', probabilities: { technology: 0.8, diary: 0.2 } },
                safe: { probability: 0.25 },
                score: { score: 0.75 },
            },
            metadata: { usage: { inputTokens: 4, outputTokens: 3 }, rounding: { probabilityDecimals: 2 } },
        })
        expect(decide.mock.calls[0]?.[0].state).toEqual([{ type: 'json', value: { content: 'SDK types' } }])
    })
    it('extracts native nulls, source spans and intervals without text inference', async () => {
        const response = {
            model: 'clairic',
            truncated: false,
            state_text: 'Invoice INV-1',
            answers: {
                id: { type: 'text', value: 'INV-1', guess: 'INV-1', span: [8, 13], p_null: 0, confidence: 0.9 },
                missing: { type: 'number', value: null, guess: 2, p_null: 0.8, confidence: 0.7 },
                days: {
                    type: 'estimate',
                    value: 30,
                    median: 30,
                    mean: 29.5,
                    p10: 21,
                    p90: 38,
                    p_below: 0.01,
                    p_above: 0.02,
                },
            },
            usage: { input_tokens: 12, output_tokens: 0, passes: 3 },
        }
        native.run.mockResolvedValue(response)
        const extraction = createExtractionAction({
            input: z.object({ content: z.string() }),
            source: ({ content }) => ({ state: content }),
            fields: {
                id: { type: 'text' },
                missing: { type: 'number' },
                days: { type: 'estimate', min: 0, max: 120, step: 1 },
            },
        })
        const config = resolveLitiConfig(
            defineLitiConfig({
                plugins: [
                    ai({
                        provider: voidAi({ extraction: '@cf/cloudflare/clairic' }),
                        actions: { invoice: extraction },
                    }),
                ],
            }),
        )
        const output = await executeAction(config, 'invoice', { content: 'Invoice INV-1' }, admin)
        expect(output.data).toMatchObject({
            id: { span: [8, 13] },
            missing: { value: null, p_null: 0.8 },
            days: { p10: 21, p90: 38 },
        })
        expect(output.metadata).toMatchObject({
            truncated: false,
            stateText: 'Invoice INV-1',
            usage: { inputTokens: 12, passes: 3 },
        })
        expect(native.run).toHaveBeenCalledWith(
            '@cf/cloudflare/clairic',
            expect.objectContaining({ model: 'clairic', fields: extraction.fields }),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
        expect(() =>
            resolveLitiConfig(
                defineLitiConfig({
                    plugins: [
                        ai({ provider: aiSdk({ text: new MockLanguageModelV4() }), actions: { invoice: extraction } }),
                    ],
                }),
            ),
        ).toThrow('extraction')
        native.run.mockResolvedValue({ ...response, truncated: true })
        await expect(executeAction(config, 'invoice', { content: 'Invoice INV-1' }, admin)).rejects.toMatchObject({
            code: 'LITI_AI_OUTPUT_INVALID',
        })
    })
    it('offers validated slug candidates without a database or import-time inference', async () => {
        const run = vi.fn(async () => result('{"slug":"valid-title"}'))
        const plugin = ai({
            provider: aiSdk({ text: new MockLanguageModelV4({ doGenerate: run }) }),
            actions: { slug: createSlugGenerator({ maxLength: 12 }) },
        })
        const config = resolveLitiConfig(defineLitiConfig({ plugins: [plugin] }))
        expect(run).not.toHaveBeenCalled()
        expect((await executeAction(config, 'slug', { title: 'Title' }, admin)).data).toEqual({ slug: 'valid-title' })
        run.mockResolvedValue(result('{"slug":"INVALID SLUG"}'))
        await expect(executeAction(config, 'slug', { title: 'Title' }, admin)).rejects.toMatchObject({
            code: 'LITI_AI_FAILED',
        })
        expect(() =>
            resolveLitiConfig(defineLitiConfig({ plugins: [ai({ actions: { slug: createSlugGenerator() } })] })),
        ).toThrow('text capability')
        expect(resolveLitiConfig(defineLitiConfig({ plugins: [ai()] })).actions).toEqual({})
    })
    it('distinguishes stream deltas from the validated complete result', async () => {
        const provider = aiSdk({
            text: new MockLanguageModelV4({
                doStream: async () => ({
                    stream: convertArrayToReadableStream([
                        { type: 'stream-start', warnings: [] },
                        { type: 'text-start', id: '0' },
                        { type: 'text-delta', id: '0', delta: '{"slug":' },
                        { type: 'text-delta', id: '0', delta: '"hello"}' },
                        { type: 'text-end', id: '0' },
                        { type: 'finish', finishReason: result('').finishReason, usage: result('').usage },
                    ]),
                }),
            }),
        })
        const events = []
        for await (const event of provider.text!.stream!(
            { prompt: 'test', output: z.object({ slug: z.string() }) },
            admin,
        ))
            events.push(event)
        expect(events[0]).toEqual({ type: 'delta', text: '{"slug":' })
        expect(events.at(-1)).toMatchObject({ type: 'complete', result: { data: { slug: 'hello' } } })
    })
    it('protects HTTP method, origin, body size and result privacy', async () => {
        const { config } = setup()
        const execute = vi.fn((name: string, input: unknown) =>
            executeAction(config, name as 'proofread', input as { content: string }, context),
        )
        const request = (headers: Record<string, string> = {}, method = 'POST', body = '{"input":{"content":"x"}}') =>
            new Request('https://site.test/manage/actions/proofread', {
                method,
                headers: { 'content-type': 'application/json', ...headers },
                ...(method === 'POST' ? { body } : {}),
            })
        expect((await handleActionRequest(request({}, 'GET'), '/manage', execute)).status).toBe(405)
        expect((await handleActionRequest(request({ origin: 'https://other.test' }), '/manage', execute)).status).toBe(
            403,
        )
        expect((await handleActionRequest(request({}, 'POST', '{'), '/manage', execute)).status).toBe(400)
        expect(
            (
                await handleActionRequest(
                    request({}, 'POST', JSON.stringify({ input: 'x'.repeat(1_048_577) })),
                    '/manage',
                    execute,
                )
            ).status,
        ).toBe(400)
        expect(execute).not.toHaveBeenCalled()
        const response = await handleActionRequest(request(), '/manage', execute)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(await response.json()).toMatchObject({ data: { content: 'Corrected' } })
        const failed = await handleActionRequest(request(), '/manage', async () => {
            throw new Error('PRIVATE_SECRET')
        })
        expect(failed.status).toBe(502)
        expect(await failed.text()).not.toContain('PRIVATE_SECRET')
    })
})
