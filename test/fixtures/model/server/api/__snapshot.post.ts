import { z } from 'zod'
import { useWorkspace } from 'vite-hub/workspace'
import { models } from '../utils/models'

export default defineEventHandler(async (event) => {
    const token = process.env.LITI_PROBE_TOKEN
    if (!token || getHeader(event, 'x-liti-probe') !== token) throw createError({ statusCode: 403 })
    const input = z.object({ id: z.string().uuid().optional() }).parse(await readBody(event))
    const operation = { actor: { id: 'writer' } }
    if (input.id)
        return {
            draft: await models.readDraft('posts', input.id, operation, 'ja'),
            published: await models.read('posts', input.id, 'ja'),
            head: await useWorkspace('content').history.head({ ref: 'published' }),
        }
    const id = crypto.randomUUID()
    const reviewed = await models.save(
        'posts',
        id,
        { data: { title: 'Durable reviewed snapshot', slug: id, tags: [] }, body: 'Reviewed' },
        { ...operation, ifDigest: null, locale: 'ja' },
    )
    const at = Date.now() + 1_500
    await models.schedule([{ model: 'posts', id, digests: { ja: reviewed.digest, en: null } }], new Date(at), operation)
    const later = await models.save(
        'posts',
        id,
        { data: { title: 'Retain newer draft', slug: id, tags: [] }, body: 'Newer' },
        { ...operation, ifDigest: reviewed.digest, locale: 'ja' },
    )
    return { id, at, digest: later.digest }
})
