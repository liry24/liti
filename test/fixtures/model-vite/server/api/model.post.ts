import assert from 'node:assert/strict'
import { defineEventHandler, getHeader, createError } from 'h3'
import { models, records } from '../utils/models'
import { content } from '../content'
export default defineEventHandler(async (event) => {
    if (!process.env.LITI_PROBE_TOKEN || getHeader(event, 'x-liti-probe') !== process.env.LITI_PROBE_TOKEN)
        throw createError({ statusCode: 403 })
    const operation = { actor: { id: 'writer' } },
        id = crypto.randomUUID(),
        stat = crypto.randomUUID()
    const saves = await Promise.allSettled(
        [0, 1].map((index) =>
            records.save(
                'games',
                `${id}-${index}`,
                { slug: id, igdbId: 1 + parseInt(id.replaceAll('-', '').slice(0, 12), 16) },
                { ...operation, ifVersion: null },
            ),
        ),
    )
    assert.equal(
        saves.filter((result) => result.status === 'fulfilled').length,
        1,
        JSON.stringify(saves, (_key, value) =>
            value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value,
        ),
    )
    const game = saves[0]!.status === 'fulfilled' ? `${id}-0` : `${id}-1`
    const stats = await Promise.allSettled(
        [0, 1].map((index) =>
            records.save('stats', `${stat}-${index}`, { game, period: '2026-10' }, { ...operation, ifVersion: null }),
        ),
    )
    assert.equal(stats.filter((result) => result.status === 'fulfilled').length, 1)
    await assert.rejects(
        records.save(
            'stats',
            crypto.randomUUID(),
            { game: 'missing', period: '2026-10' },
            { ...operation, ifVersion: null },
        ),
    )
    await assert.rejects(
        models.save(
            'notes',
            id,
            { data: { title: 'Denied', slug: id, game }, body: 'Body' },
            { actor: { id: 'denied' }, ifDigest: null },
        ),
    )
    const saved = await models.save(
        'notes',
        id,
        { data: { title: 'Standalone Model', slug: id, game }, body: 'Native Workspace body' },
        { ...operation, ifDigest: null },
    )
    assert.equal(await models.read('notes', id), null)
    await models.publish([{ model: 'notes', id, digests: { und: saved.digest } }], operation)
    assert.equal((await models.read('notes', id))!.body, 'Native Workspace body')
    const first = (await models.read('notes', id))!.publication!.firstPublishedAt
    const draft = await models.save(
        'notes',
        id,
        { data: { title: 'Newer draft', slug: id, game }, body: 'Later body' },
        { ...operation, ifDigest: saved.digest },
    )
    assert.equal((await models.read('notes', id))!.data.title, 'Standalone Model')
    assert.equal((await models.read('notes', id))!.publication!.firstPublishedAt, first)
    const restored = await models.restore('notes', id, saved.revision, { ...operation, ifDigest: draft.digest })
    assert.equal((await models.readDraft('notes', id, operation))!.digest, restored.digest)
    await assert.rejects(
        content.collection('notes').save(id, { data: { title: 'Bypass', slug: id, game }, body: '' }),
        /authorized Model operation/,
    )
    return {
        ok: true,
        checks: [
            'Nuxt-free native SQL contributions, scalar/composite concurrent uniqueness and FK constraints',
            'Nuxt-free Content authorization, immutable draft/public/history separation and native bypass rejection',
        ],
    }
})
