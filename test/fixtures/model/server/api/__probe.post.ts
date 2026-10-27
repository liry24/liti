import assert from 'node:assert/strict'
import { registerWorkspacePlugin, useWorkspace } from 'vite-hub/workspace'
import { models, records } from '../utils/models'
import { content } from '../content'

export default defineEventHandler(async (event) => {
    const token = process.env.LITI_PROBE_TOKEN
    if (!token || getHeader(event, 'x-liti-probe') !== token) throw createError({ statusCode: 403 })
    const checks: string[] = [],
        operation = { actor: { id: 'writer' } }
    const id = crypto.randomUUID(),
        other = crypto.randomUUID(),
        work = crypto.randomUUID()
    const dbId = crypto.randomUUID(),
        igdbId = parseInt(dbId.replaceAll('-', '').slice(0, 12), 16)
    const history = useWorkspace('content', { mode: 'write' }).history
    await assert.rejects(
        models.save(
            'posts',
            id,
            { data: { title: 'Denied', slug: id, tags: [] } },
            { actor: { id: 'denied' }, ifDigest: null, locale: 'ja' },
        ),
        /not authorized/,
    )
    await assert.rejects(
        content
            .collection('posts')
            .save(`${id}/ja`, { data: { title: 'Bypass', slug: id, tags: [], _litiOrder: 0, _litiBody: true } }),
        /authorized Model operation/,
    )
    checks.push('explicit authorization and native Content bypass rejection')

    const duplicates = await Promise.allSettled(
        [0, 1].map((index) =>
            records.save(
                'games',
                `${dbId}-${index}`,
                { igdbId, slug: `${dbId}-${index}`, privateNote: 'private' },
                { ...operation, ifVersion: null },
            ),
        ),
    )
    assert.equal(duplicates.filter((item) => item.status === 'fulfilled').length, 1)
    const gameId = duplicates[0]!.status === 'fulfilled' ? `${dbId}-0` : `${dbId}-1`
    const game = (await records.read('games', gameId))!
    assert.equal(game.data.privateNote, undefined)
    assert.equal((await records.readDraft('games', gameId, operation))?.data.privateNote, 'private')
    const versions = await Promise.allSettled(
        [0, 1].map((index) =>
            records.save(
                'games',
                gameId,
                { igdbId, slug: `${dbId}-version-${index}` },
                { ...operation, ifVersion: game.version },
            ),
        ),
    )
    assert.equal(versions.filter((item) => item.status === 'fulfilled').length, 1)
    const stats = await Promise.allSettled(
        [0, 1].map((index) =>
            records.save(
                'gameStats',
                `${dbId}-stat-${index}`,
                { game: gameId, periodKey: '2026-10', count: 1 },
                { ...operation, ifVersion: null },
            ),
        ),
    )
    assert.equal(stats.filter((item) => item.status === 'fulfilled').length, 1)
    await assert.rejects(
        records.save(
            'gameStats',
            crypto.randomUUID(),
            { game: 'absent-game', periodKey: '2026-10', count: 1 },
            { ...operation, ifVersion: null },
        ),
    )
    await assert.rejects(
        records.remove('games', gameId, { ...operation, ifVersion: (await records.read('games', gameId))!.version }),
        /cannot be physically deleted/,
    )
    const blindId = crypto.randomUUID(),
        blindActor = { actor: { id: 'write-only' } }
    const blind = await records.save(
        'games',
        blindId,
        { igdbId: igdbId + 100, slug: blindId, privateNote: 'server-private' },
        { ...blindActor, ifVersion: null },
    )
    assert.equal('data' in blind, false)
    await records.save(
        'games',
        blindId,
        { igdbId: igdbId + 100, slug: `${blindId}-updated`, privateNote: 'still-private' },
        { ...blindActor, ifVersion: blind.version },
    )
    await assert.rejects(records.readDraft('games', blindId, blindActor), /not authorized/)
    const optionalCode = crypto.randomUUID()
    const nonNullUnique = await Promise.allSettled(
        [0, 1].map((index) =>
            records.save(
                'games',
                `${optionalCode}-${index}`,
                { igdbId: igdbId + 200 + index, slug: `${optionalCode}-${index}`, optionalCode },
                { ...operation, ifVersion: null },
            ),
        ),
    )
    assert.equal(nonNullUnique.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(
        (await records.query('games', { filter: { slug: String((await records.read('games', gameId))!.data.slug) } }))
            .total,
        1,
    )
    await assert.rejects(records.query('games', { filter: { privateNote: 'private' } }), /public model field/)
    checks.push('native record uniqueness, composite FK, versions, redaction and cross-store deletion refusal')

    await assert.rejects(
        models.save(
            'posts',
            id,
            { data: { title: 'FORBIDDEN', slug: id, tags: [] } },
            { ...operation, ifDigest: null, locale: 'ja' },
        ),
        /MODEL_RULE_REJECTED/,
    )
    await assert.rejects(
        models.save(
            'posts',
            id,
            { data: { title: 'Missing reference', slug: id, tags: [], game: 'absent-game' } },
            { ...operation, ifDigest: null, locale: 'ja' },
        ),
        /Missing games/,
    )
    const originalData = { title: 'Console', slug: id, tags: ['shared'], game: gameId, secret: 'private draft secret' }
    const first = await models.save(
        'posts',
        id,
        { data: originalData, body: 'Original body' },
        { ...operation, ifDigest: null, locale: 'ja' },
    )
    let english = await models.save(
        'posts',
        id,
        { data: { title: 'English title' } },
        { ...operation, ifDigest: null, locale: 'en' },
    )
    assert.equal(await models.read('posts', id, 'ja'), null)
    const selection = [{ model: 'posts', id, digests: { ja: first.digest, en: english.digest } }]
    await models.publish(selection, operation)
    const published = (await models.read('posts', id, 'en'))!
    assert.equal(published.data.title, 'English title')
    assert.equal(published.data.slug, id)
    assert.equal(published.data.secret, undefined)
    assert.deepEqual(published.data.tags, ['shared'])
    assert.equal(published.body, 'Original body')
    await assert.rejects(models.query('posts', { filter: { secret: 'private' } }), /public model field/)
    assert.deepEqual((await models.readDraft('posts', id, operation, 'en'))?.data, { title: 'English title' })
    const emptyBody = await models.save(
        'posts',
        id,
        { data: { title: 'English title' }, body: '' },
        { ...operation, ifDigest: english.digest, locale: 'en' },
    )
    await models.publish([{ model: 'posts', id, digests: { ja: first.digest, en: emptyBody.digest } }], operation)
    assert.equal((await models.read('posts', id, 'en'))?.body, '')
    english = await models.save(
        'posts',
        id,
        { data: { title: 'English title' }, body: null },
        { ...operation, ifDigest: emptyBody.digest, locale: 'en' },
    )
    assert.equal((await models.readDraft('posts', id, operation, 'en'))?.body, undefined)
    await models.publish([{ model: 'posts', id, digests: { ja: first.digest, en: english.digest } }], operation)
    assert.equal((await models.read('posts', id, 'en'))?.body, 'Original body')
    await assert.rejects(
        models.save(
            'posts',
            id,
            { data: { title: 'English', tags: ['accidental fallback'] } },
            { ...operation, ifDigest: english.digest, locale: 'en' },
        ),
        /Model validation failed/,
    )
    checks.push('atomic translation publication, shared fields, sparse fallback and private-field redaction')

    const firstPublication = (await models.read('posts', id, 'ja'))!.publication!.firstPublishedAt
    const reviewed = await models.save(
        'posts',
        id,
        { data: { ...originalData, title: 'Scheduled' }, body: 'Reviewed snapshot' },
        { ...operation, ifDigest: first.digest, locale: 'ja' },
    )
    const at = new Date(Date.now() + 60_000)
    const job = await models.schedule(
        [{ model: 'posts', id, digests: { ja: reviewed.digest, en: english.digest } }],
        at,
        operation,
    )
    const later = await models.save(
        'posts',
        id,
        { data: { ...originalData, title: 'Keep later draft' }, body: 'Newer edits' },
        { ...operation, ifDigest: reviewed.digest, locale: 'ja' },
    )
    assert.equal((await models.read('posts', id, 'ja'))?.data.title, 'Console')
    const beforeSchedule = await history.head({ ref: 'published' })
    const due = await Promise.all([models.publishDue(operation, at), models.publishDue(operation, at)])
    assert.ok(due.every((result) => result.failed.length === 0))
    assert.ok(due.some((result) => result.completed.includes(job.id)))
    assert.equal((await models.read('posts', id, 'ja'))?.data.title, 'Scheduled')
    assert.equal((await models.readDraft('posts', id, operation, 'ja'))?.digest, later.digest)
    assert.equal((await models.read('posts', id, 'ja'))?.publication?.firstPublishedAt, firstPublication)
    assert.equal((await history.head({ ref: 'published' }))?.parentId, beforeSchedule?.id)
    const completed = (await history.head({ ref: 'published' }))!.id
    await models.publishDue(operation, at)
    assert.equal((await history.head({ ref: 'published' }))?.id, completed)
    checks.push('immutable scheduled revision, concurrent execution, stable first publication and retained draft')

    const race = await Promise.allSettled(
        ['A', 'B'].map((title) =>
            models.save(
                'posts',
                id,
                { data: { ...originalData, title }, body: 'Concurrent draft' },
                { ...operation, ifDigest: later.digest, locale: 'ja' },
            ),
        ),
    )
    assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1)
    const current = (await models.readDraft('posts', id, operation, 'ja'))!
    const restored = await models.restore('posts', id, first.revision, {
        ...operation,
        ifDigest: current.digest,
        locale: 'ja',
    })
    assert.equal((await models.readDraft('posts', id, operation, 'ja'))?.data.title, 'Console')
    const preConflict = (await history.head({ ref: 'published' }))!.id
    await assert.rejects(
        models.publish([{ model: 'posts', id, digests: { ja: current.digest, en: english.digest } }], operation),
        /changed after review/,
    )
    assert.equal((await history.head({ ref: 'published' }))?.id, preConflict)
    checks.push('native save races, restore revalidation and publication failure without side effects')

    const second = await models.save(
        'posts',
        other,
        { data: { title: 'Collision', slug: id, tags: [] }, body: '' },
        { ...operation, ifDigest: null, locale: 'ja' },
    )
    await assert.rejects(
        models.publish([{ model: 'posts', id: other, digests: { ja: second.digest, en: null } }], operation),
        /URL is reserved/,
    )
    const moved = await models.save(
        'posts',
        id,
        { data: { ...originalData, slug: `${id}-moved` }, body: 'Moved' },
        { ...operation, ifDigest: restored.digest, locale: 'ja' },
    )
    await models.publish([{ model: 'posts', id, digests: { ja: moved.digest, en: english.digest } }], operation)
    await assert.rejects(
        models.publish([{ model: 'posts', id: other, digests: { ja: second.digest, en: null } }], operation),
        /URL is reserved/,
    )
    assert.equal((await models.read('posts', id, 'ja'))?.id, id)
    assert.deepEqual((await models.resolveUrl(`/ja/posts/${id}`))?.kind, 'redirect')
    assert.equal((await models.resolveUrl(`/ja/posts/${id}`))?.url, `/ja/posts/${id}-moved`)
    const fallbackId = crypto.randomUUID(),
        collisionId = crypto.randomUUID(),
        japaneseSlug = `${fallbackId}-日本語`
    const fallback = await models.save(
        'posts',
        fallbackId,
        { data: { title: 'Fallback route', slug: japaneseSlug, tags: [] } },
        { ...operation, ifDigest: null, locale: 'ja' },
    )
    await models.publish([{ model: 'posts', id: fallbackId, digests: { ja: fallback.digest, en: null } }], operation)
    assert.equal((await models.resolveUrl(`/en/posts/${japaneseSlug}`))?.entry.id, fallbackId)
    const originalCollision = await models.save(
        'posts',
        collisionId,
        { data: { title: 'Other original', slug: collisionId, tags: [] } },
        { ...operation, ifDigest: null, locale: 'ja' },
    )
    const englishCollision = await models.save(
        'posts',
        collisionId,
        { data: { title: 'English collision', slug: japaneseSlug } },
        { ...operation, ifDigest: null, locale: 'en' },
    )
    await assert.rejects(
        models.publish(
            [
                {
                    model: 'posts',
                    id: collisionId,
                    digests: { ja: originalCollision.digest, en: englishCollision.digest },
                },
            ],
            operation,
        ),
        /URL is reserved/,
    )
    checks.push('stable identity and atomic current/historical URL reservations')

    const linked = await models.save(
        'works',
        work,
        { data: { name: 'Referenced work', post: id } },
        { ...operation, ifDigest: null },
    )
    await models.publish([{ model: 'works', id: work, digests: { und: linked.digest } }], operation)
    await assert.rejects(
        models.remove('posts', id, { ...operation, ifDigest: moved.digest, locale: 'ja' }),
        /still references/,
    )
    await models.remove('works', work, { ...operation, ifDigest: linked.digest })
    await models.remove('posts', id, { ...operation, ifDigest: english.digest, locale: 'en' })
    await models.remove('posts', id, { ...operation, ifDigest: moved.digest, locale: 'ja' })
    const preOrphan = (await history.head({ ref: 'published' }))!.id
    await assert.rejects(
        models.publish([{ model: 'posts', id, digests: { ja: null, en: null } }], operation),
        /Missing posts/,
    )
    assert.equal((await history.head({ ref: 'published' }))?.id, preOrphan)
    await models.restore('posts', id, first.revision, { ...operation, ifDigest: null, locale: 'ja' })
    checks.push('JSON Content, current and published reference guards, deletion and restore')

    const a = crypto.randomUUID(),
        b = crypto.randomUUID()
    await models.save('cards', a, { data: { name: 'A' } }, { ...operation, ifDigest: null })
    await models.save('cards', b, { data: { name: 'B' } }, { ...operation, ifDigest: null })
    const draftHead = (await history.head({ ref: 'draft' }))!
    const cardFiles = await (await history.open(draftHead.id)).list('cards', { recursive: true })
    const oldIds = cardFiles
        .filter((file) => file.type === 'file')
        .map((file) => file.path.split('/')[1]!)
        .filter((value) => value !== a && value !== b)
    const ordering = [b, a, ...oldIds]
    await models.reorder('cards', ordering, { ...operation, ifHead: draftHead.id })
    assert.equal((await models.readDraft('cards', b, operation))?.order, 0)
    assert.equal(await models.read('cards', b), null)
    const cards = await Promise.all(
        ordering.map(async (id) => ({
            model: 'cards',
            id,
            digests: { und: (await models.readDraft('cards', id, operation))!.digest },
        })),
    )
    await assert.rejects(models.publish(cards.slice(0, 1), operation), /Publish every current model entry/)
    await models.publish(cards, operation)
    assert.deepEqual(
        (await models.query('cards')).items.slice(0, 2).map((item) => item.id),
        [b, a],
    )
    const guardedHead = (await history.head({ ref: 'published' }))!.id
    await assert.rejects(
        history.commit({ ref: 'published', ifHead: guardedHead, changes: { delete: [`cards/${b}/und.json`] } }),
        /only through content.publish|authorized Model operation/,
    )
    await assert.rejects(
        content.commitPublished({ ifHead: guardedHead, changes: { delete: [`cards/${b}/und.json`] } }),
        /authorized Model operation/,
    )
    const firstDate = (await models.read('cards', a))!.publication!.firstPublishedAt
    await models.unpublish('cards', a, { ...operation, ifHead: (await history.head({ ref: 'published' }))!.id })
    assert.equal(await models.read('cards', a), null)
    assert.equal((await models.readDraft('cards', a, operation))?.data.name, 'A')
    await models.publish(cards, operation)
    assert.equal((await models.read('cards', a))?.publication?.firstPublishedAt, firstDate)
    const noOpHead = (await history.head({ ref: 'published' }))!.id
    await models.publish(cards, operation)
    assert.equal((await history.head({ ref: 'published' }))?.id, noOpHead)
    const scheduledId = crypto.randomUUID()
    const scheduled = await models.save(
        'posts',
        scheduledId,
        { data: { title: 'Scheduled candidate', slug: scheduledId, tags: [] } },
        { ...operation, ifDigest: null, locale: 'ja' },
    )
    const selected = [{ model: 'posts', id: scheduledId, digests: { ja: scheduled.digest, en: null } }]
    const cancelled = await models.schedule(selected, at, operation)
    await models.cancelSchedule(cancelled.id, operation)
    assert.equal((await models.publishDue(operation, at)).completed.includes(cancelled.id), false)
    const conflicted = await models.schedule(selected, at, operation)
    const manuallyEdited = await models.save(
        'posts',
        scheduledId,
        { data: { title: 'New manual publication', slug: scheduledId, tags: [] } },
        { ...operation, ifDigest: scheduled.digest, locale: 'ja' },
    )
    await models.publish(
        [{ model: 'posts', id: scheduledId, digests: { ja: manuallyEdited.digest, en: null } }],
        operation,
    )
    assert.ok((await models.publishDue(operation, at)).failed.some((failure) => failure.id === conflicted.id))
    assert.equal((await models.read('posts', scheduledId, 'ja'))?.data.title, 'New manual publication')
    await models.cancelSchedule(conflicted.id, operation)

    const hookId = crypto.randomUUID()
    let hookFailures = true
    const stop = registerWorkspacePlugin('content', {
        id: `receipt-${hookId}`,
        hooks: {
            'write:after': (input) => {
                if (hookFailures && input.path === `posts/${hookId}/ja.md`) throw new Error('PRIVATE_AFTER_HOOK_ERROR')
            },
        },
    })
    try {
        const receipt = await models.save(
            'posts',
            hookId,
            { data: { title: 'Committed receipt', slug: hookId, tags: [] } },
            { ...operation, ifDigest: null, locale: 'ja' },
        )
        assert.equal(receipt.postCommitErrors.length, 1)
        assert.equal((await models.readDraft('posts', hookId, operation, 'ja'))?.digest, receipt.digest)
        const committedPublication = await models.publish(
            [{ model: 'posts', id: hookId, digests: { ja: receipt.digest, en: null } }],
            operation,
        )
        assert.equal(committedPublication.postCommitErrors.length, 1)
        assert.equal(JSON.stringify(committedPublication).includes('PRIVATE_'), false)
        assert.equal((await models.read('posts', hookId, 'ja'))?.data.title, 'Committed receipt')
    } finally {
        hookFailures = false
        stop()
    }
    checks.push('atomic reorder publication, unpublish without draft loss and no-op date stability')
    return { checks, documentId: id }
})
