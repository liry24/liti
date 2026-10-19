import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { expect, test, vi } from 'vitest'
import { defineSiteAdminConfig, text, type SiteAdminLifecycleEvent } from '../packages/site-admin/src'
import { createManagementOperations } from '../packages/site-admin/src/server/operations'
import { createMigratedTestAdmin } from './migrate'

test('management mutations emit attributed data snapshots only after committing', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    const events: SiteAdminLifecycleEvent[] = []
    const afterCommit = vi.fn((event: SiteAdminLifecycleEvent) => {
        events.push(event)
    })
    try {
        const admin = await createMigratedTestAdmin({
            database,
            authorize: () => ({ id: 'actor', roles: ['admin'] }),
            afterCommit,
            config: defineSiteAdminConfig({
                models: {
                    items: { fields: { name: text(), note: text() }, sortable: true },
                },
            }),
        })
        const api = createManagementOperations<unknown, { items: { name: string; note: string } }>(
            () => admin,
            new Request('https://example.com'),
        )
        let entry = await api.createEntry('items', { data: { name: 'Original', note: 'All fields' } })
        expect(events.at(-1)).toMatchObject({
            type: 'create',
            actorId: 'actor',
            data: { name: 'Original', note: 'All fields' },
        })
        expect(events.at(-1)).not.toHaveProperty('label')
        entry = await api.schedulePublish(entry.id, {
            expectedVersion: entry.version,
            at: new Date(Date.now() + 3600000).toISOString(),
        })
        entry = await api.cancelScheduledPublish(entry.id, { expectedVersion: entry.version })
        expect(events.at(-1)).toMatchObject({ type: 'cancelSchedule', actorId: 'actor', version: entry.version })
        const count = events.length
        await expect(
            api.setSortOrders('items', [{ id: entry.id, expectedVersion: 999, sortOrder: 0 }]),
        ).rejects.toMatchObject({ code: 'SITE_ADMIN_CONFLICT' })
        await expect(api.cancelScheduledPublish(entry.id, { expectedVersion: 999 })).rejects.toMatchObject({
            code: 'SITE_ADMIN_CONFLICT',
        })
        expect(events).toHaveLength(count)
        entry = await api.setSortOrder(entry.id, 1, entry.version)
        expect(events.at(-1)).toMatchObject({
            type: 'sort',
            actorId: 'actor',
            data: { name: 'Original', note: 'All fields' },
        })
        entry = (await api.setSortOrders('items', [{ id: entry.id, expectedVersion: entry.version, sortOrder: 0 }]))[0]!
        expect(events.at(-1)).toMatchObject({ type: 'sort', actorId: 'actor', version: entry.version })
        afterCommit.mockImplementationOnce(() => {
            throw new Error('Activity unavailable')
        })
        entry = await api.updateEntry(entry.id, {
            expectedVersion: entry.version,
            data: { name: 'Renamed', note: 'Updated' },
        })
        expect((await admin.getEntry(entry.id)).data.name).toBe('Renamed')
        expect(admin.diagnostics).toContainEqual(expect.objectContaining({ code: 'SITE_ADMIN_HOOK_FAILED' }))
        await api.deleteEntry(entry.id, { expectedVersion: entry.version })
        expect(events.at(-1)).toMatchObject({
            type: 'delete',
            actorId: 'actor',
            data: { name: 'Renamed', note: 'Updated' },
        })
    } finally {
        await database.dispose()
    }
})
