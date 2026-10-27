import assert from 'node:assert/strict'
import { executeSchedule, executeStaticSchedule } from 'vite-hub/schedule/runtime'
import { defineSchedule } from 'vite-hub/schedule'
import { useWorkspace } from 'vite-hub/workspace'
import snapshots from '../schedules/snapshots'
import { content } from '../content'
import { withManagedWrite } from './managed'
import { queueSnapshot } from './snapshots'

export async function verifySchedules() {
    const managed = content.collection('managed')
    const id = crypto.randomUUID()
    const editor = { id: 'editor', email: 'editor-synthetic@example.test' }
    await assert.rejects(
        withManagedWrite(null, 'write', () => managed.save(id, { data: { title: 'Denied' }, body: '' })),
        /PROBE_ACCESS_DENIED/,
    )
    await assert.rejects(managed.save(id, { data: { title: 'Bypass' }, body: '' }), /PROBE_MANAGED_ROUTE_REQUIRED/)
    const reviewed = await withManagedWrite(editor, 'write', () =>
        managed.save(id, { data: { title: 'Reviewed snapshot' }, body: 'Reviewed' }),
    )
    const now = new Date(Date.now() + 60_000)
    await queueSnapshot(id, { revision: reviewed.revision, path: reviewed.path, at: now.getTime() })
    const later = await withManagedWrite(editor, 'write', () =>
        managed.save(id, { data: { title: 'Later draft' }, body: 'Keep edits' }, { ifDigest: reviewed.digest }),
    )
    const publishedBefore = await useWorkspace('content').history.head({ ref: 'published' })
    const attempts = await Promise.all(
        [0, 1].map((index) =>
            executeStaticSchedule({
                name: `snapshot-probe-${id}-${index}`,
                cron: snapshots.cron,
                definition: snapshots,
                scheduledAt: now,
            }),
        ),
    )
    assert.ok(attempts.every((run) => run.status === 'succeeded'))
    assert.equal((await managed.get(id))?.data.title, 'Reviewed snapshot')
    assert.equal((await managed.get(id, { ref: 'draft' }))?.digest, later.digest)
    const history = useWorkspace('content').history
    const publishedAfter = await history.head({ ref: 'published' })
    assert.notEqual(publishedBefore?.id, publishedAfter?.id)
    assert.equal(publishedAfter?.parentId, publishedBefore?.id)
    await executeStaticSchedule({
        name: `snapshot-probe-${id}-0`,
        cron: snapshots.cron,
        definition: snapshots,
        scheduledAt: now,
    })
    await executeStaticSchedule({
        name: `snapshot-probe-${id}-retry`,
        cron: snapshots.cron,
        definition: snapshots,
        scheduledAt: now,
    })
    assert.equal((await history.head({ ref: 'published' }))?.id, publishedAfter?.id)
    await assert.rejects(managed.remove(id), /PROBE_MANAGED_ROUTE_REQUIRED/)
    await assert.rejects(managed.restore(id, reviewed.revision), /PROBE_MANAGED_ROUTE_REQUIRED/)
    await assert.rejects(
        executeSchedule({
            definition: defineSchedule('* * * * *', () =>
                content.publish({ expect: [{ collection: 'managed', id, digest: later.digest }] }),
            ),
            scheduleId: `bypass-${id}`,
            target: 'generic-content-publish',
        }),
        /PROBE_MANAGED_ROUTE_REQUIRED/,
    )
    assert.equal((await managed.get(id))?.data.title, 'Reviewed snapshot')
    assert.equal((await managed.get(id, { ref: 'draft' }))?.digest, later.digest)
    return [
        'authorized managed writes; Schedule immutable snapshot, concurrent/duplicate execution and bypass rejection',
    ]
}
