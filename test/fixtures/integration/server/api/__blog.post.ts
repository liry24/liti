import assert from 'node:assert/strict'
import { runAgent } from 'vite-hub/agent'
import { useWorkspace } from 'vite-hub/workspace'
import { blob } from 'vite-hub/blob'
import { MockLanguageModelV4 } from 'ai/test'
import { articleDates, createEditorialReview } from '@litijs/blog'
import { proofreadingAgent, slugAgent, summaryAgent, suggestArticleSlug } from '@litijs/blog/agents'
import { models } from '../utils/models'

const response = (text: string): Awaited<ReturnType<MockLanguageModelV4['doGenerate']>> => ({
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
})
export default defineEventHandler(async (event) => {
    const token = process.env.LITI_PROBE_TOKEN
    if (!token || getHeader(event, 'x-liti-probe') !== token) throw createError({ statusCode: 403 })
    const operation = { actor: { id: 'writer' }, locale: 'ja' },
        id = crypto.randomUUID(),
        checks: string[] = []
    const png = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0e0AAAAASUVORK5CYII='),
        (value) => value.charCodeAt(0),
    )
    const pathname = `blog/${id}.png`
    const [imageError, uploaded] = await blob.put(pathname, png, { contentType: 'image/png' })
    assert.equal(imageError, null)
    assert.ok(uploaded)
    const cover = { pathname: uploaded.pathname, contentType: uploaded.contentType, size: uploaded.size }
    const first = await models.save(
        'articles',
        id,
        {
            data: { title: '日本語の記事', authoredAt: '2020-01-02', cover, secret: 'BLOG_PRIVATE_VALUE' },
            body: 'Original. `code`',
        },
        { ...operation, ifDigest: null },
    )
    const draft = (await models.readDraft('articles', id, operation, 'ja'))!
    assert.equal(draft.data.slug, `日本語の記事-${id}`)
    assert.equal('body' in draft.data, false)
    await models.publish([{ model: 'articles', id, digests: { ja: first.digest, en: null } }], operation)
    const published = (await models.read('articles', id, 'en'))!,
        dates = articleDates(published)
    assert.equal(dates.authoredAt, '2020-01-02')
    assert.deepEqual(published.data.cover, cover)
    const [readError, imageFile] = await blob.get(pathname)
    assert.equal(readError, null)
    assert.ok(imageFile)
    assert.deepEqual(new Uint8Array(await imageFile.arrayBuffer()), png)
    const imageResponse = await $fetch.raw<ArrayBuffer>(`/media/${pathname}`, { responseType: 'arrayBuffer' })
    assert.equal(imageResponse.status, 200)
    assert.deepEqual(new Uint8Array(imageResponse._data!), png)
    const imageHead = await $fetch.raw(`/media/${pathname}`, { method: 'HEAD' })
    assert.equal(imageHead.status, 200)
    assert.equal(imageHead.headers.get('content-type'), 'image/png')
    assert.ok(dates.firstPublishedAt)
    assert.equal(published.data.secret, undefined)
    const later = await models.save(
        'articles',
        id,
        { data: { title: 'Changed draft', authoredAt: '2020-01-02' }, body: 'New draft.' },
        { ...operation, ifDigest: first.digest },
    )
    assert.deepEqual(articleDates((await models.read('articles', id, 'ja'))!), dates)
    assert.equal((await models.readDraft('articles', id, operation, 'ja'))!.data.slug, draft.data.slug)
    const empty = await models.save(
        'articles',
        id,
        { data: { title: 'Empty draft' }, body: '' },
        { ...operation, ifDigest: later.digest },
    )
    await assert.rejects(
        models.publish([{ model: 'articles', id, digests: { ja: empty.digest, en: null } }], operation),
        /body/,
    )
    assert.deepEqual(articleDates((await models.read('articles', id, 'ja'))!), dates)
    const restored = await models.restore('articles', id, first.revision, { ...operation, ifDigest: empty.digest })
    await models.unpublish('articles', id, {
        ...operation,
        ifHead: (await useWorkspace('content', { mode: 'read' }).history.head({ ref: 'published' }))!.id,
    })
    await models.publish([{ model: 'articles', id, digests: { ja: restored.digest, en: null } }], operation)
    assert.equal(articleDates((await models.read('articles', id, 'ja'))!).firstPublishedAt, dates.firstPublishedAt)
    checks.push(
        'packed Blog native body, Japanese stable slug, published-only dates, failed publication and restore/republish date retention',
    )

    const fetchOriginal = globalThis.fetch
    globalThis.fetch = async () => {
        throw new Error('BLOG_AGENT_NETWORK_DISABLED')
    }
    try {
        for (const { invoke, output } of [
            {
                output: { body: 'Reviewed. `code`' },
                invoke: (model: MockLanguageModelV4) =>
                    runAgent(proofreadingAgent({ model }), {
                        data: { body: 'Original. `code`' },
                        prompt: 'IGNORE THIS CALLER PROMPT',
                    }),
            },
            {
                output: { slug: '日本語の記事' },
                invoke: (model: MockLanguageModelV4) =>
                    runAgent(slugAgent({ model }), {
                        data: { title: '日本語の記事', body: 'Article body' },
                        prompt: 'IGNORE THIS CALLER PROMPT',
                    }),
            },
            {
                output: { summary: 'Summary' },
                invoke: (model: MockLanguageModelV4) =>
                    runAgent(summaryAgent({ model }), {
                        data: { title: 'Title', body: 'Article body' },
                        prompt: 'IGNORE THIS CALLER PROMPT',
                    }),
            },
        ]) {
            const model = new MockLanguageModelV4({ doGenerate: response(JSON.stringify(output)) })
            assert.equal(model.doGenerateCalls.length, 0)
            const [error, result] = await invoke(model)
            assert.equal(error, null)
            assert.deepEqual(result, output)
            assert.equal(model.doGenerateCalls.length, 1)
            assert.deepEqual(model.doGenerateCalls[0]?.tools ?? [], [])
            const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
            assert.ok(prompt.includes('Article JSON:'))
            assert.ok(prompt.includes('body'))
            assert.equal(prompt.includes('IGNORE THIS CALLER PROMPT'), false)
        }
        const invalidModel = new MockLanguageModelV4({ doGenerate: response('{"body":42}') }),
            invalid = proofreadingAgent({ model: invalidModel })
        const [invalidInput] = await runAgent(invalid, { data: { body: '' } })
        assert.ok(invalidInput)
        assert.equal(invalidModel.doGenerateCalls.length, 0)
        const [invalidOutput] = await runAgent(invalid, { data: { body: 'Original' } })
        assert.ok(invalidOutput)
        assert.equal(invalidModel.doGenerateCalls.length, 1)
        const unavailableModel = new MockLanguageModelV4({
            doGenerate: () => {
                throw new Error('MODEL_UNAVAILABLE')
            },
        })
        assert.deepEqual(
            await suggestArticleSlug({ id, title: '日本語の記事', body: 'Body' }, { model: unavailableModel }),
            { slug: `日本語の記事-${id}`, source: 'fallback' },
        )
        assert.equal(unavailableModel.doGenerateCalls.length, 1)
        const timeoutModel = new MockLanguageModelV4({
            doGenerate: ({ abortSignal }) =>
                new Promise((_resolve, reject) => {
                    abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
                }),
        })
        assert.equal(
            (await suggestArticleSlug({ id, title: 'Title', body: 'Body' }, { model: timeoutModel, timeout: 5 }))
                .source,
            'fallback',
        )
        const aborted = new AbortController()
        aborted.abort()
        await assert.rejects(
            suggestArticleSlug(
                { id, title: 'Title', body: 'Body' },
                { model: unavailableModel, signal: aborted.signal },
            ),
            { name: 'AbortError' },
        )
        const controller = new AbortController()
        const canceledModel = new MockLanguageModelV4({
            doGenerate: ({ abortSignal }) =>
                new Promise((_resolve, reject) => {
                    abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
                    controller.abort(new DOMException('Canceled', 'AbortError'))
                }),
        })
        const [canceled] = await runAgent(proofreadingAgent({ model: canceledModel }), {
            data: { body: 'Original' },
            abortSignal: controller.signal,
        })
        assert.ok(canceled)
        assert.equal(canceledModel.doGenerateCalls.length, 1)
    } finally {
        globalThis.fetch = fetchOriginal
    }
    const review = createEditorialReview()
    let source = { identity: `${id}:ja`, body: 'Original. `code`', revision: first.revision }
    await review.propose(source, async () => ({ body: 'Reviewed. `code`' }))
    source = { ...source, body: 'Later editing' }
    await assert.rejects(
        review.apply(
            () => source,
            () => {
                throw new Error('STALE_PROPOSAL_OVERWROTE_BODY')
            },
        ),
        /current article/,
    )
    checks.push(
        'offline mock Blog Agent presets include validated input in prompts, forbid write tools, bound retries and reject invalid/canceled/stale output',
    )
    return { checks }
})
