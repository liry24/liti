import { afterEach, expect, it } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineLitiConfig, text } from '../packages/liti/src'
import { createMigratedTestAdmin } from './migrate'

const databases: Database[] = []
afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.dispose()))
})

it('records first publication atomically for all locales and preserves it across publication state changes', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(database)
    let now = new Date('2026-01-01T00:00:00Z')
    const admin = await createMigratedTestAdmin({
        database,
        now: () => now,
        locales: {
            defaultLocale: 'en',
            supported: ['en', 'ja', 'fr'],
            localizePath: (path, locale) => `/${locale}${path}`,
        },
        config: defineLitiConfig({
            models: {
                posts: {
                    route: '/:slug',
                    fields: {
                        title: text({ i18n: true }),
                        slug: text({ i18n: true }),
                    },
                },
            },
        }),
    })
    let entry = await admin.createEntry('posts', {
        data: { title: 'Original', slug: 'post' },
        translations: { ja: { title: '日本語' } },
    })
    const firstRevision = entry.currentRevisionId
    const created = entry.updatedAt
    now = new Date('2026-01-02T00:00:00Z')
    entry = await admin.schedulePublish(entry.id, { expectedVersion: entry.version, at: '2026-01-03T00:00:00Z' })
    expect(entry.firstPublishedAt).toBeNull()
    expect(entry.updatedAt).toBe(created)
    now = new Date('2026-01-04T00:00:00Z')
    expect((await admin.publishDue()).published).toEqual([entry.id])
    entry = await admin.getEntry(entry.id)
    const first = now.toISOString()
    expect(entry).toMatchObject({ firstPublishedAt: first, publishedAt: first, updatedAt: created })
    for (const locale of ['en', 'ja'])
        expect(await admin.getPublicEntry('posts', entry.id, locale)).toMatchObject({
            firstPublishedAt: first,
            updatedAt: created,
        })
    now = new Date('2026-01-05T00:00:00Z')
    entry = await admin.updateEntry(entry.id, {
        expectedVersion: entry.version,
        translations: { fr: { title: 'Français' } },
    })
    const edited = entry.updatedAt
    expect((await admin.getPublicEntry('posts', entry.id))?.updatedAt).toBe(created)
    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
    expect(await admin.getPublicEntry('posts', entry.id, 'fr')).toMatchObject({
        firstPublishedAt: first,
        updatedAt: edited,
    })
    now = new Date('2026-01-06T00:00:00Z')
    entry = await admin.unpublishEntry(entry.id, { expectedVersion: entry.version })
    expect(entry).toMatchObject({ firstPublishedAt: first, publishedAt: null, updatedAt: edited })
    entry = await admin.restoreRevision(entry.id, firstRevision, { expectedVersion: entry.version })
    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version })
    expect(entry.firstPublishedAt).toBe(first)

    const conflict = await admin.createEntry('posts', { data: { title: 'Conflict', slug: 'post' } })
    await expect(admin.publishEntry(conflict.id, { expectedVersion: conflict.version })).rejects.toMatchObject({
        code: 'LITI_ROUTE_CONFLICT',
    })
    expect(await admin.getEntry(conflict.id)).toMatchObject({ firstPublishedAt: null, publishedAt: null })
})
