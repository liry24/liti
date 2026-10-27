import { blob } from 'vite-hub/blob'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import { models } from '../utils/models'
import { z } from 'zod'

const input = z.discriminatedUnion('action', [
    z.object({ action: z.literal('seed'), dataset: z.uuid(), index: z.number().int().min(0).max(199) }),
    z.object({ action: z.literal('query'), dataset: z.uuid() }),
])
export default defineEventHandler(async (event) => {
    if (!process.env.LITI_PROBE_TOKEN || getHeader(event, 'x-liti-probe') !== process.env.LITI_PROBE_TOKEN)
        throw createError({ statusCode: 403 })
    const request = input.parse(await readBody(event)),
        operation = { actor: { id: 'writer' } }
    if (request.action === 'seed') {
        const id = `bench-${request.dataset}-${String(request.index).padStart(4, '0')}`,
            pathname = `bench/${request.dataset}.png`
        if (request.index === 0) {
            const png = Uint8Array.from(
                atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGf8AAAAASUVORK5CYII='),
                (byte) => byte.charCodeAt(0),
            )
            const [error] = await blob.put(pathname, png, { contentType: 'image/png' })
            if (error) throw error
        }
        const data = {
            title: `Article ${request.index}`,
            slug: id,
            dataset: request.dataset,
            cover: { pathname, size: 68 },
        }
        const body = (revision: number, length: number) =>
            `Article ${request.index}, revision ${revision}.\n![cover](${pathname})\n` +
            'Content '.repeat(Math.ceil(length / 8)).slice(0, length)
        let digest: string | null = null,
            revision = ''
        for (let version = 0; version < 4; version++) {
            const saved = await models.save(
                'bench',
                id,
                { data, body: body(version, 32768) },
                { ...operation, locale: 'ja', ifDigest: digest },
            )
            digest = saved.digest
            revision = saved.revision
        }
        let english: string | null = null
        if (request.index % 2 === 0) {
            for (let version = 0; version < 2; version++) {
                const saved = await models.save(
                    'bench',
                    id,
                    { data: { title: `English ${request.index}`, slug: `en-${id}` }, body: body(version, 16384) },
                    { ...operation, locale: 'en', ifDigest: english },
                )
                english = saved.digest
            }
        }
        await models.publish([{ model: 'bench', id, digests: { ja: digest, en: english } }], operation)
        await models.save(
            'bench',
            id,
            { data: { ...data, title: 'PRIVATE_LATER_DRAFT' }, body: 'PRIVATE_LATER_DRAFT' },
            { ...operation, locale: 'ja', ifDigest: digest },
        )
        return { id, revision }
    }
    const env = getRuntimeContext(event).cloudflare?.env
    if (!env || !env.BLOB || typeof env.BLOB !== 'object')
        throw new Error('Performance probe requires the real workerd R2 BLOB binding.')
    const bucket = env.BLOB,
        operations: Record<string, number> = {}
    env.BLOB = new Proxy(bucket, {
        get(target, key) {
            const method = Reflect.get(target, key, target)
            if (typeof method !== 'function' || typeof key !== 'string' || key === 'constructor') return method
            return (...args: unknown[]) => {
                operations[key] = (operations[key] ?? 0) + 1
                return Reflect.apply(method, target, args)
            }
        },
    })
    const start = performance.now()
    try {
        const page = await models.query('bench', { locale: 'en', limit: 200, filter: { dataset: request.dataset } })
        Object.assign(globalThis, { __litiPerfHold: page })
        return { page, metrics: { queryMs: performance.now() - start, r2: operations } }
    } finally {
        env.BLOB = bucket
    }
})
