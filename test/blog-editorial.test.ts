import { expect, it, vi } from 'vite-plus/test'
import {
    defineArticle,
    articleDates,
    articleDraftUpdatedAt,
    articleSummary,
    createEditorialReview,
    slugFromTitle,
    validateProofreading,
} from '../packages/blog/src'
import { field, validateData } from '@litijs/model'
import { z } from 'zod'

const context = { action: 'save' as const, id: 'stable-id', locale: 'und', actor: { id: 'writer' }, previous: null }
it('defines native-body articles with deterministic Japanese slugs and preserves established/manual slugs', async () => {
    const article = defineArticle({ name: 'posts', authorize: () => true })
    expect('body' in article.fields).toBe(false)
    expect(slugFromTitle('日本語の記事・２０２６')).toBe('日本語の記事-2026')
    expect(slugFromTitle('𠮷'.repeat(90))).toBe('𠮷'.repeat(80))
    const prepared = await article.prepare!({ data: { title: '日本語の記事' } }, context)
    expect(prepared.data.slug).toBe('日本語の記事-stable-id')
    const data = await validateData(article.fields, prepared.data)
    expect(data.tags).toEqual([])
    const historical = await article.prepare!({ data: { title: 'Manual', slug: '2026.10~review%value' } }, context)
    const historicalData = await validateData(article.fields, historical.data)
    expect(article.url!({ id: 'stable-id', locale: 'und', data: historicalData })).toBe('/posts/2026.10~review%25value')
    const longId = await article.prepare!({ data: { title: '𠮷'.repeat(90) } }, { ...context, id: 'x'.repeat(128) })
    expect((await validateData(article.fields, longId.data)).slug.length).toBeLessThanOrEqual(210)
    expect(
        await article.prepare!(
            { data: { title: 'Changed title', slug: '' } },
            { ...context, previous: { slug: 'published-url' } },
        ),
    ).toMatchObject({ data: { slug: 'published-url' } })
    expect(await article.prepare!({ data: { title: 'Title', slug: 'manual' } }, context)).toMatchObject({
        data: { slug: 'manual' },
    })
    expect(() => defineArticle({ name: 'posts', authorize: () => true, fields: { slug: field(z.string()) } })).toThrow(
        'already standardized',
    )
    await expect(
        article.validate!({ ...data, title: 'Title' }, { ...context, action: 'publish', body: '' }),
    ).rejects.toThrow('body')
    await article.validate!({ ...data, title: 'Title' }, { ...context, body: '' })
    const localized = defineArticle({
        name: 'posts',
        authorize: () => true,
        locales: { default: 'ja', supported: ['ja', 'en'] },
    })
    expect(
        (await localized.prepare!({ data: { summary: 'Only summary' } }, { ...context, locale: 'en' })).data,
    ).toEqual({ summary: 'Only summary' })
})

it('exposes published article dates separately from draft updates and preserves unknown dates', () => {
    const entry = {
        data: { authoredAt: '2020-01-02' },
        publication: { firstPublishedAt: '2021-01-01T00:00:00Z', updatedAt: '2022-01-01T00:00:00Z' },
    }
    expect(articleDates(entry)).toEqual({
        authoredAt: '2020-01-02',
        date: '2020-01-02',
        firstPublishedAt: '2021-01-01T00:00:00Z',
        publishedUpdatedAt: '2022-01-01T00:00:00Z',
    })
    expect(articleDraftUpdatedAt({ updatedAt: '2026-01-01T00:00:00Z' })).toBe('2026-01-01T00:00:00Z')
    expect(articleDates({ data: {}, publication: null }).date).toBeNull()
    expect(articleSummary({ data: {}, body: 'Overview.\n\n<!-- more -->\n\nFull body.' })).toBe('Overview.')
    expect(articleSummary({ data: { summary: '' }, body: 'Body' })).toBe('')
})

const protection = { protect: (body: string) => body.match(/\[game:[^\]]+\]/gu) ?? [] }
const original =
    'Original. `code` [link](/relative) ![image](/image.png) <Game id="one" /> [game:one]\n\n```ts\nconst x = 1\n```\n'
it('retains parser-based protection for code, links, images, HTML and application game tags', async () => {
    expect(await validateProofreading(original, original.replace('Original.', 'Reviewed.'), protection)).toBe(true)
    for (const [before, after] of [
        ['`code`', '``code``'],
        ['/relative', '/other'],
        ['/image.png', '/other.png'],
        ['id="one"', 'id="two"'],
        ['[game:one]', '[game:two]'],
        ['x = 1', 'x = 2'],
    ])
        expect(await validateProofreading(original, original.replace(before!, after!), protection)).toBe(false)
})

it('reviews without saving and rejects stale body, identity and revision before applying', async () => {
    const review = createEditorialReview(protection)
    let source = { identity: 'actor:post:ja', body: original, revision: 'one' }
    const write = vi.fn((body: string) => {
        source = { ...source, body }
    })
    await review.propose(source, async () => ({ body: original.replace('Original.', 'Reviewed.') }))
    expect(write).not.toHaveBeenCalled()
    for (const stale of [
        { ...source, body: 'Later editing' },
        { ...source, identity: 'actor:other:ja' },
        { ...source, revision: 'two' },
    ])
        await expect(review.apply(() => stale, write)).rejects.toMatchObject({ code: 'LITI_CONFLICT' })
    await review.apply(() => source, write)
    expect(write).toHaveBeenCalledTimes(1)
    expect(review.state.status).toBe('applied')
    await expect(review.apply(() => source, write)).rejects.toMatchObject({ code: 'LITI_CONFLICT' })
})

it('rechecks content after asynchronous protection and refuses invalid output', async () => {
    let wait = false
    const releases: (() => void)[] = [],
        entered = Promise.withResolvers<void>()
    const review = createEditorialReview({
        protect: async () => {
            if (wait)
                await new Promise<void>((resolve) => {
                    releases.push(resolve)
                    entered.resolve()
                })
            return []
        },
    })
    let source = { identity: 'post', body: 'Original' }
    await review.propose(source, async () => ({ body: 'Reviewed' }))
    wait = true
    const written = vi.fn()
    const applying = expect(review.apply(() => source, written)).rejects.toMatchObject({ code: 'LITI_CONFLICT' })
    await entered.promise
    source = { ...source, body: 'Changed while validating' }
    wait = false
    releases.forEach((release) => release())
    await applying
    expect(written).not.toHaveBeenCalled()
    for (const invalid of [{ body: 42 }, { body: 'Text', publish: true }, { body: '' }])
        await expect(review.propose(source, async () => invalid)).rejects.toMatchObject({ code: 'LITI_INVALID_INPUT' })
})

it('cancels and times out an uncooperative executor without allowing a later result to replace another review', async () => {
    const review = createEditorialReview(),
        source = { identity: 'post', body: 'Original' }
    const pending = review.propose(source, async () => await new Promise(() => {}))
    review.cancel()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(review.state.status).toBe('idle')
    await expect(review.propose(source, async () => await new Promise(() => {}), { timeout: 5 })).rejects.toMatchObject(
        { name: 'TimeoutError' },
    )
    expect(review.state.status).toBe('error')
    await review.propose(source, async () => ({ body: 'New proposal' }))
    expect(review.state.proposal?.body).toBe('New proposal')
})
