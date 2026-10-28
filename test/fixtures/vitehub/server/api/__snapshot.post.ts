import { z } from 'zod'
import { content } from '../content'
import { useWorkspace } from 'vite-hub/workspace'
import { withManagedWrite } from '../utils/managed'
import { queueSnapshot } from '../utils/snapshots'

export default defineEventHandler(async (event) => {
    const token = process.env.LITI_PROBE_TOKEN
    if (!token || getHeader(event, 'x-liti-probe') !== token) throw createError({ statusCode: 403 })
    const input = z.object({ id: z.string().uuid().optional() }).parse(await readBody(event))
    const managed = content.collection('managed')
    const history = useWorkspace('content').history
    if (input.id)
        return {
            draft: await managed.get(input.id, { ref: 'draft' }),
            published: await managed.get(input.id),
            head: await history.head({ ref: 'published' }),
        }
    const id = crypto.randomUUID()
    const editor = { id: 'editor', email: 'editor-synthetic@example.test' }
    const reviewed = await withManagedWrite(editor, 'write', () =>
        managed.save(id, { data: { title: 'Durable reviewed snapshot' }, body: 'Reviewed' }),
    )
    const at = Date.now() + 1_500
    await queueSnapshot(id, { revision: reviewed.revision, path: reviewed.path, at })
    const later = await withManagedWrite(editor, 'write', () =>
        managed.save(id, { data: { title: 'Retain newer draft' }, body: 'Newer' }, { ifDigest: reviewed.digest }),
    )
    return { id, at, digest: later.digest }
})
