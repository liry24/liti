import { describe, expect, it, vi } from 'vitest'
import { runLitiTask, type LitiTaskRuntime } from '../packages/nuxt/src/runtime/tasks'
import type { Liti } from '../packages/liti/src/server'

const runtime = (tasks: LitiTaskRuntime['tasks'] = {}) => {
    const admin = {
        rebuildSearch: vi.fn(async () => ({ indexed: 1 })),
        publishDue: vi.fn<Liti['publishDue']>(async () => ({ published: ['entry'], failed: [] })),
        runAssetGC: vi.fn<Liti['runAssetGC']>(async () => ({ deleted: ['orphan'], failed: [] })),
        syncAssetCopies: vi.fn<Liti['syncAssetCopies']>(async () => ({
            copied: ['asset'],
            deleted: [],
            failed: [],
        })),
    }
    return { admin, runtime: { tasks, getLiti: vi.fn(async () => admin) } }
}

describe('liti Nitro tasks', () => {
    it('disables all tasks by default before resolving a database or running destructive cleanup', async () => {
        for (const options of [{}, { publishDue: false, assetGC: false, syncAssets: false }]) {
            const fixture = runtime(options)
            for (const task of ['publishDue', 'assetGC', 'syncAssets'] as const)
                await expect(runLitiTask(task, fixture.runtime)).rejects.toMatchObject({
                    code: 'LITI_FORBIDDEN',
                })
            expect(fixture.runtime.getLiti).not.toHaveBeenCalled()
            expect(fixture.admin.runAssetGC).not.toHaveBeenCalled()
        }
    })

    it('passes native platform context and delegates enabled tasks to their existing use cases', async () => {
        const fixture = runtime({ publishDue: true, assetGC: '0 3 * * *', syncAssets: true })
        const context = { cloudflare: { env: { DB: {} }, context: {} } }
        expect(await runLitiTask('publishDue', fixture.runtime, context)).toEqual({
            published: ['entry'],
            failed: [],
        })
        expect(await runLitiTask('assetGC', fixture.runtime, context)).toEqual({ deleted: ['orphan'], failed: [] })
        expect(await runLitiTask('syncAssets', fixture.runtime, context)).toEqual({
            copied: ['asset'],
            deleted: [],
            failed: [],
        })
        expect(fixture.runtime.getLiti).toHaveBeenCalledWith(undefined, context)
        expect(fixture.admin.publishDue).toHaveBeenCalledExactlyOnceWith()
        expect(fixture.admin.runAssetGC).toHaveBeenCalledExactlyOnceWith()
        expect(fixture.admin.syncAssetCopies).toHaveBeenCalledExactlyOnceWith()
    })

    it('preserves per-item failures and propagates initialization failures for scheduler observability', async () => {
        const fixture = runtime({ publishDue: true, assetGC: true, syncAssets: true })
        fixture.admin.publishDue.mockResolvedValue({
            published: [],
            failed: [{ entryId: 'entry', message: 'conflict' }],
        })
        fixture.admin.runAssetGC.mockResolvedValue({ deleted: [], failed: [{ id: 'asset', message: 'lease held' }] })
        fixture.admin.syncAssetCopies.mockResolvedValue({
            copied: [],
            deleted: [],
            failed: [{ id: 'asset', message: 'retry' }],
        })
        expect(await runLitiTask('publishDue', fixture.runtime)).toEqual({
            published: [],
            failed: [{ entryId: 'entry', message: 'conflict' }],
        })
        expect(await runLitiTask('assetGC', fixture.runtime)).toEqual({
            deleted: [],
            failed: [{ id: 'asset', message: 'lease held' }],
        })
        expect(await runLitiTask('syncAssets', fixture.runtime)).toEqual({
            copied: [],
            deleted: [],
            failed: [{ id: 'asset', message: 'retry' }],
        })
        fixture.runtime.getLiti.mockRejectedValue(new Error('D1 binding unavailable'))
        await expect(runLitiTask('publishDue', fixture.runtime)).rejects.toThrow('D1 binding unavailable')
    })
})
