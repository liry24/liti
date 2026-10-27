import { isWorkspaceConflict, useWorkspace } from 'vite-hub/workspace'
import { z } from 'zod'
import { withManagedWrite } from './managed'

const jobSchema = z.object({ revision: z.string(), path: z.string().startsWith('managed/'), at: z.number() })
const system = { id: 'probe-schedule', email: 'editor-schedule@example.test' }
const queueRef = 'probe-schedules'

// Feasibility only: queue metadata and receipts use native Workspace history, never a second content store.
export async function queueSnapshot(id: string, job: z.infer<typeof jobSchema>) {
    const workspace = useWorkspace('content', { mode: 'write' })
    jobSchema.parse(job)
    const head = await workspace.history.head({ ref: queueRef })
    return await withManagedWrite(system, 'publish', () =>
        workspace.history.commit({
            ref: queueRef,
            ifHead: head?.id ?? null,
            changes: { put: { [`.liti-probe/jobs/${id}.json`]: JSON.stringify(job) } },
        }),
    )
}

export async function publishSnapshots(now: Date) {
    const workspace = useWorkspace('content', { mode: 'write' })
    const queue = await workspace.history.head({ ref: queueRef })
    if (!queue) return
    const jobs = await workspace.history.open(queue.id)
    for (const entry of await jobs.list('.liti-probe/jobs', { recursive: true })) {
        if (entry.type !== 'file') continue
        const job = jobSchema.parse(JSON.parse(await jobs.readFile(entry.path, { encoding: 'utf8' })))
        if (job.at > now.getTime()) continue
        const receipt = entry.path.replace('/jobs/', '/receipts/')
        const head = await workspace.history.head({ ref: 'published' })
        const completed = async (revision: string | null) =>
            revision &&
            (await (await workspace.history.open(revision)).list('', { recursive: true })).some(
                (file) => file.path === receipt,
            )
        if (await completed(head?.id ?? null)) continue
        const snapshot = await workspace.history.open(job.revision)
        const bytes = await snapshot.readFile(job.path)
        try {
            await withManagedWrite(system, 'publish', () =>
                workspace.history.commit({
                    ref: 'published',
                    ifHead: head?.id ?? null,
                    ifHeads: { [queueRef]: queue.id },
                    changes: { put: { [job.path]: bytes, [receipt]: JSON.stringify(job) } },
                    message: 'Publish reviewed immutable revision',
                }),
            )
        } catch (error) {
            // Only an already committed receipt makes a competing execution successful.
            if (!isWorkspaceConflict(error)) throw error
            if (!(await completed((await workspace.history.head({ ref: 'published' }))?.id ?? null))) throw error
        }
    }
}
