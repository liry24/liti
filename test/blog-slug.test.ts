import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import {
    defineLitiConfig,
    resolveLitiConfig,
    LitiError,
    type LitiConfigInput,
    type ModelPreparationContext,
    type OperationContext,
} from '../packages/liti/src'
import { blog } from '../packages/blog/src'
import { ai, createSlugGenerator, type AiProvider } from '../packages/ai/src'
import { handleManagementRequest } from '../packages/liti/src/server'
import { createManagementOperations } from '../packages/liti/src/server/operations'
import { createMigratedTestAdmin } from './migrate'

const databases: Database[] = []
const actor = { id: 'admin', roles: ['admin'] }
const draft = { title: 'これはexample title', content: 'Original content.', tags: [] }
afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const setup = async (
    config: LitiConfigInput = defineLitiConfig({ plugins: [blog({ models: { posts: { slug: { mode: 'auto' } } } })] }),
    locales?: Parameters<typeof createMigratedTestAdmin>[0]['locales'],
) => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    const admin = await createMigratedTestAdmin({
        config: resolveLitiConfig(config, []),
        database,
        authorize: () => actor,
        ...(locales ? { locales } : {}),
    })
    const api = createManagementOperations(() => admin, { actor })
    return { admin, api, database }
}

const aiConfig = (run: (context: OperationContext) => unknown, timeoutMs = 60_000) => {
    const provider: AiProvider = {
        id: 'fixture',
        text: {
            async generate(request, context) {
                const checked = await request.output!['~standard'].validate(await run(context))
                if (checked.issues) throw new LitiError('LITI_AI_OUTPUT_INVALID', 'Invalid fixture output.')
                return { data: checked.value, metadata: {} }
            },
        },
    }
    return defineLitiConfig({
        plugins: [
            ai({ provider, actions: { slug: createSlugGenerator() }, limits: { timeoutMs } }),
            blog({ models: { posts: { slug: { mode: 'auto', action: 'slug' } } } }),
        ],
    })
}

it.each([
    [draft.title, 'example-title'],
    ['  Héllo___WORLD---2026! ', 'hello-world-2026'],
    ['日本語の記事', /^[a-z0-9]{6}$/u],
    ['a'.repeat(90), 'a'.repeat(80)],
])('publishes without AI using a bounded ASCII slug: %s', async (title, slug) => {
    const { admin, api } = await setup()
    const entry = await admin.createEntry('posts', { data: { ...draft, title } })
    const published = await api.publishEntry(entry.id, { expectedVersion: entry.version, draft: { data: {} } })
    expect(published).toMatchObject({
        data: { ...draft, title, slug: typeof slug === 'string' ? slug : expect.stringMatching(slug) },
    })
    const stored = await admin.getEntry(entry.id)
    expect(await admin.resolvePath(`/posts/${String(stored.data.slug)}`)).toMatchObject({
        kind: 'page',
        entry: { id: entry.id },
    })
})

it('ignores drafts and reservations, but avoids published and historical URLs with a bounded suffix', async () => {
    const { admin, api } = await setup()
    const reserved = await admin.createEntry('posts', { data: { ...draft, slug: 'example-title' } })
    await admin.schedulePublish(reserved.id, { expectedVersion: reserved.version, at: '2099-01-01' })
    const original = await admin.createEntry('posts', { data: draft })
    const published = await api.publishEntry(original.id, { expectedVersion: original.version, draft: { data: {} } })
    expect(published).toMatchObject({ data: { slug: 'example-title' } })
    const renamed = await api.publishEntry(original.id, {
        expectedVersion: published.version,
        draft: { data: { slug: 'renamed' } },
    })
    expect(renamed).toMatchObject({ data: { slug: 'renamed' } })
    expect(await admin.resolvePath('/posts/example-title')).toMatchObject({ kind: 'redirect' })
    const duplicate = await admin.createEntry('posts', { data: draft })
    expect(
        await api.publishEntry(duplicate.id, { expectedVersion: duplicate.version, draft: { data: {} } }),
    ).toMatchObject({ data: { slug: expect.stringMatching(/^example-title-[a-z0-9]{6}$/u) } })

    const long = await admin.createEntry('posts', { data: { ...draft, title: 'a'.repeat(80) } })
    await api.publishEntry(long.id, { expectedVersion: long.version, draft: { data: {} } })
    const next = await admin.createEntry('posts', { data: { ...draft, title: 'a'.repeat(80) } })
    expect(await api.publishEntry(next.id, { expectedVersion: next.version, draft: { data: {} } })).toMatchObject({
        data: { slug: expect.stringMatching(new RegExp(`^${'a'.repeat(73)}-[a-z0-9]{6}$`, 'u')) },
    })
})

it.each([
    () => {
        throw new Error('Missing API key or provider outage')
    },
    () => ({ slug: 'bad/slug' }),
    () => ({ slug: '' }),
])('publishes through HTTP when the AI provider fails or returns an invalid candidate', async (run) => {
    const { admin } = await setup(aiConfig(run))
    const entry = await admin.createEntry('posts', { data: draft })
    const response = await handleManagementRequest(
        admin,
        new Request(`https://site.test/api/liti/entries/${entry.id}/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedVersion: entry.version, draft: { data: {} } }),
        }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { ...draft, slug: 'example-title' } })
    expect((await admin.getEntry(entry.id)).publishedRevisionId).not.toBeNull()
})

it('falls back on an AI timeout, but never publishes after caller cancellation or an expired deadline', async () => {
    const run = vi.fn(
        (context: OperationContext) =>
            new Promise((_, reject) => {
                context.signal!.addEventListener('abort', () => reject(context.signal!.reason), { once: true })
            }),
    )
    const { admin, api } = await setup(aiConfig(run, 10))
    const entry = await admin.createEntry('posts', { data: draft })
    expect(await api.publishEntry(entry.id, { expectedVersion: entry.version, draft: { data: {} } })).toMatchObject({
        data: { slug: 'example-title' },
    })
    const cancelled = await admin.createEntry('posts', { data: draft })
    const controller = new AbortController()
    run.mockImplementationOnce(() => {
        controller.abort(new DOMException('Cancelled', 'AbortError'))
        throw controller.signal.reason
    })
    const attempt = admin.publishEntry(
        cancelled.id,
        {
            expectedVersion: cancelled.version,
            draft: { data: {} },
        },
        undefined,
        { actor, signal: controller.signal },
    )
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
        admin.publishEntry(
            cancelled.id,
            {
                expectedVersion: cancelled.version,
                draft: { data: {} },
            },
            undefined,
            { actor, deadline: Date.now() - 1 },
        ),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(await admin.getEntry(cancelled.id)).toMatchObject({ version: cancelled.version, publishedRevisionId: null })
})

it('rechecks the route on retry without rerunning a successful AI action', async () => {
    const run = vi.fn(() => ({ slug: 'ai-slug' }))
    const { admin, api } = await setup(aiConfig(run))
    const blocker = await admin.createEntry('posts', { data: { ...draft, slug: 'ai-slug' } })
    let occupy = true
    const config = admin.config.models.posts!
    const prepare = config.preparePublication!
    config.preparePublication = async (context) => {
        await prepare(context)
        if (occupy) {
            occupy = false
            await admin.publishEntry(blocker.id, { expectedVersion: blocker.version })
        }
    }
    const entry = await admin.createEntry('posts', { data: draft })
    const input = { expectedVersion: entry.version, draft: { data: {} } }
    await expect(api.publishEntry(entry.id, input)).rejects.toMatchObject({ code: 'LITI_ROUTE_CONFLICT' })
    expect(await admin.getEntry(entry.id)).toMatchObject({ version: entry.version, publishedRevisionId: null })
    expect(await admin.listRevisions(entry.id)).toHaveLength(1)
    const published = await api.publishEntry(entry.id, input)
    expect(published).toMatchObject({ data: { slug: expect.stringMatching(/^ai-slug-[a-z0-9]{6}$/u) } })
    expect(run).toHaveBeenCalledTimes(1)
})

it('pins fallback data at scheduling and retains manual and established slugs', async () => {
    const run = vi.fn(() => {
        throw new Error('Unavailable')
    })
    const { admin, api } = await setup(aiConfig(run))
    const manual = await admin.createEntry('posts', {
        data: { ...draft, slug: 'manual', publication: { slug: 'manual' } },
    })
    const published = await api.publishEntry(manual.id, { expectedVersion: manual.version, draft: { data: {} } })
    expect(published).toMatchObject({ data: { slug: 'manual' } })
    expect(run).not.toHaveBeenCalled()
    const entry = await admin.createEntry('posts', { data: draft })
    const scheduled = await api.schedulePublish(entry.id, {
        expectedVersion: entry.version,
        draft: { data: {} },
        at: '2099-01-01',
    })
    expect(scheduled).toMatchObject({ data: { slug: 'example-title' } })
    expect((await admin.publishDue(new Date('2100-01-01'))).published).toEqual([entry.id])
    expect(run).toHaveBeenCalledTimes(1)
    const established = await admin.getEntry(entry.id)
    expect(
        await api.publishEntry(entry.id, {
            expectedVersion: established.version,
            draft: { data: { title: 'Changed title' } },
        }),
    ).toMatchObject({ data: { slug: 'example-title' } })
    expect(run).toHaveBeenCalledTimes(1)
})

it('bounds repeated ID collisions and commits no candidate revision', async () => {
    const routeAvailable = vi.fn(async () => false)
    const model = blog({ models: { posts: { slug: { mode: 'auto' } } } }).models.posts
    const context = {
        data: { ...draft, slug: '', publication: { slug: 'auto' } },
        read: { published: { routeAvailable } },
    } as unknown as Parameters<NonNullable<typeof model.preparePublication>>[0]
    await expect(model.preparePublication!(context)).rejects.toMatchObject({ code: 'LITI_ROUTE_CONFLICT' })
    expect(routeAvailable).toHaveBeenCalledTimes(10)
    expect(context.data.slug).toBe('')
})

it('checks the configured localized path without treating another locale or this entry as a collision', async () => {
    const contexts: ModelPreparationContext[] = []
    const { admin, api } = await setup(
        defineLitiConfig({
            plugins: [
                blog({
                    models: {
                        posts: {
                            i18n: true,
                            route: '/stories/:slug',
                            slug: { mode: 'auto' },
                            preparePublication(context) {
                                contexts.push(context)
                            },
                        },
                    },
                }),
            ],
        }),
        {
            defaultLocale: 'en',
            supported: ['en', 'ja'],
            localizePath: (path, locale) => `/${locale}${path}`,
        },
    )
    for (const locale of ['en', 'ja']) {
        const entry = await admin.createEntry('posts', { defaultLocale: locale, data: { ...draft, title: 'Shared' } })
        expect(await api.publishEntry(entry.id, { expectedVersion: entry.version, draft: { data: {} } })).toMatchObject(
            {
                data: { slug: 'shared' },
            },
        )
        expect(await admin.resolvePath(`/${locale}/stories/shared`, locale)).toMatchObject({ kind: 'page' })
        expect(await contexts.at(-1)!.read.published.routeAvailable({ slug: 'shared' })).toBe(true)
    }
    const duplicate = await admin.createEntry('posts', { defaultLocale: 'en', data: { ...draft, title: 'Shared' } })
    expect(
        await api.publishEntry(duplicate.id, { expectedVersion: duplicate.version, draft: { data: {} } }),
    ).toMatchObject({
        data: { slug: expect.stringMatching(/^shared-[a-z0-9]{6}$/u) },
    })
})
