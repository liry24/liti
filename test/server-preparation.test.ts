import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineLitiConfig, text, type ModelPreparationContext } from '../packages/liti/src'
import { handleManagementRequest } from '../packages/liti/src/server'
import { createManagementOperations } from '../packages/liti/src/server/operations'
import { createMigratedTestAdmin } from './migrate'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.dispose()))
})
const database = () => {
    const db = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(db)
    return db
}

it('prepares each locale once with the real identity, actor and scoped reads on create, update and restore', async () => {
    const contexts: ModelPreparationContext[] = []
    const config = defineLitiConfig({
        authorization: { roles: { writer: { models: { posts: ['create', 'update'] } } } },
        models: {
            posts: {
                fields: { title: text({ required: true, i18n: true }), derived: text({ i18n: true }) },
                async prepare(context) {
                    contexts.push(context)
                    context.data.derived = `${context.data.title}:${context.locale}`
                    if (context.data.title === 'lookup') await context.read.current.listEntries('secrets')
                },
            },
            secrets: { public: false, fields: { title: text() } },
        },
    })
    const admin = await createMigratedTestAdmin({
        database: database(),
        config,
        locales: { defaultLocale: 'en', supported: ['en', 'ja'] },
        authorize: () => ({ id: 'server-actor', roles: ['admin'] }),
    })
    const api = createManagementOperations(() => admin, { actor: { id: 'server-actor', roles: ['admin'] } })
    const input = { id: 'actual-id', data: { title: 'Original' }, translations: { ja: { title: '日本語' } } }
    let entry = await api.createEntry('posts', input)
    expect(input).toEqual({ id: 'actual-id', data: { title: 'Original' }, translations: { ja: { title: '日本語' } } })
    expect(contexts.map(({ entryId, actor, locale, operation }) => ({ entryId, actor, locale, operation }))).toEqual(
        ['en', 'ja'].map((locale) => ({
            entryId: 'actual-id',
            actor: { id: 'server-actor', roles: ['admin'] },
            locale,
            operation: 'create',
        })),
    )
    const created = await admin.getEntry(entry.id)
    expect(created.data.derived).toBe('Original:en')
    expect(created.translations.ja).toEqual({ title: '日本語', derived: '日本語:ja' })
    entry = await api.updateEntry(entry.id, { expectedVersion: entry.version, data: { title: 'Next' } })
    expect(contexts).toHaveLength(4)
    expect(contexts[2]!.previous?.id).toBe(entry.id)
    await api.restoreRevision(entry.id, created.revisionId, { expectedVersion: entry.version })
    expect(contexts.slice(-2).map(({ operation }) => operation)).toEqual(['restore', 'restore'])
    const writer = createManagementOperations(() => admin, { actor: { id: 'writer', roles: ['writer'] } })
    await expect(writer.createEntry('posts', { data: { title: 'lookup' } })).rejects.toMatchObject({
        code: 'LITI_FORBIDDEN',
    })

    const response = await handleManagementRequest(
        admin,
        new Request('https://site.test/api/liti/entries/posts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: { title: 'HTTP' }, actorId: 'forged' }),
        }),
    )
    expect(response.status).toBe(201)
    expect(contexts.at(-1)?.actor?.id).toBe('server-actor')
})

it('only transforms new publication candidates; scheduling pins data and public reads never prepare', async () => {
    const save = vi.fn()
    const generate = vi.fn(({ data }: ModelPreparationContext) => {
        if (!data.slug) data.slug = 'generated'
    })
    const check = vi.fn(({ data, issues }: ModelPreparationContext) => {
        if (!data.slug) issues.push({ path: 'slug', message: 'A slug is required.' })
    })
    const admin = await createMigratedTestAdmin({
        database: database(),
        config: defineLitiConfig({
            models: {
                posts: {
                    fields: { title: text(), slug: text() },
                    route: '/:slug',
                    prepare: save,
                    preparePublication: generate,
                    validatePublication: check,
                },
            },
        }),
    })
    let entry = await admin.createEntry('posts', { data: { title: 'Draft', slug: '' } })
    expect(generate).not.toHaveBeenCalled()
    await expect(admin.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
        issues: [{ path: 'slug' }],
    })
    expect(generate).not.toHaveBeenCalled()
    entry = await admin.schedulePublish(entry.id, {
        expectedVersion: entry.version,
        at: '2099-01-01',
        draft: { data: { title: 'Candidate' } },
    })
    expect(generate).toHaveBeenCalledTimes(1)
    const pinned = entry.scheduledRevisionId
    await expect(
        admin.publishEntry(entry.id, { expectedVersion: entry.version - 1, draft: { data: {} } }),
    ).rejects.toMatchObject({ code: 'LITI_CONFLICT' })
    expect(generate).toHaveBeenCalledTimes(1)
    entry = await admin.updateEntry(entry.id, { expectedVersion: entry.version, data: { title: 'Later' } })
    const saves = save.mock.calls.length
    expect((await admin.publishDue(new Date('2100-01-01'))).published).toEqual([entry.id])
    const published = await admin.getPublicEntry('posts', entry.id)
    expect(published).toMatchObject({ revisionId: pinned, data: { title: 'Candidate', slug: 'generated' } })
    await admin.listPublicEntries('posts')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledTimes(saves)
})

it('preserves input and commits nothing after preparation issues or cancellation', async () => {
    const controller = new AbortController()
    const admin = await createMigratedTestAdmin({
        database: database(),
        config: defineLitiConfig({
            models: {
                posts: {
                    fields: { title: text() },
                    prepare({ data, issues }) {
                        const fail = data.title === 'invalid'
                        data.title = 'changed'
                        if (fail) issues.push({ path: 'title', message: 'Invalid title.' })
                        else controller.abort()
                    },
                },
            },
        }),
    })
    const input = { data: { title: 'invalid' } }
    await expect(admin.createEntry('posts', input)).rejects.toMatchObject({ code: 'LITI_INVALID_INPUT' })
    expect(input.data.title).toBe('invalid')
    await expect(
        admin.createEntry('posts', { data: { title: 'abort' } }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(await admin.listEntries('posts')).toEqual([])
})
