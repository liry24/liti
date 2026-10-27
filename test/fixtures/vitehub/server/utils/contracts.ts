import assert from 'node:assert/strict'
import { registerWorkspacePlugin, useWorkspace } from 'vite-hub/workspace'
import { content } from '../content'

export async function verifyContentContracts() {
    const checks: string[] = []
    const posts = content.collection('posts')
    const records = content.collection('records')
    const id = crypto.randomUUID()
    assert.equal(await content.can({ collection: 'posts', action: 'write' }), false)
    assert.equal(
        await content.can({
            collection: 'posts',
            action: 'write',
            user: { id: 'editor', email: 'editor-probe@example.test' },
        }),
        true,
    )
    checks.push('explicit authorization policy')

    const first = await posts.save(id, { data: { title: 'Reviewed' }, body: '![Cover](/synthetic-cover.png)\n' })
    assert.equal(await posts.get(id), null)
    assert.equal((await posts.get(id, { ref: 'draft' }))?.body, first.body)
    const json = await records.save(id, { data: { name: 'Synthetic record' } })
    await content.publish({
        expect: [
            { collection: 'posts', id, digest: first.digest },
            { collection: 'records', id, digest: json.digest },
        ],
    })
    assert.equal((await posts.get(id))?.data.title, 'Reviewed')
    assert.equal((await records.get(id))?.data.name, 'Synthetic record')
    checks.push('Markdown/JSON draft separation and atomic publish')

    const races = await Promise.allSettled(
        ['One', 'Two'].map((title) =>
            posts.save(id, { data: { title }, body: first.body }, { ifDigest: first.digest }),
        ),
    )
    assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(races.filter((result) => result.status === 'rejected').length, 1)
    const restored = await posts.restore(id, first.revision, {
        ifDigest: (await posts.get(id, { ref: 'draft' }))!.digest,
    })
    assert.equal(restored.data.title, 'Reviewed')
    checks.push('concurrent digest guard and history restore')

    const reviewed = await posts.save(
        id,
        { data: { title: 'Scheduled snapshot' }, body: first.body },
        { ifDigest: restored.digest },
    )
    const at = new Date(Date.now() + 60_000)
    const schedule = await content.schedule({ at, expect: [{ collection: 'posts', id, digest: reviewed.digest }] })
    const later = await posts.save(
        id,
        { data: { title: 'Later draft' }, body: 'Keep later edits' },
        { ifDigest: reviewed.digest },
    )
    const due = await content.publishDue({ now: new Date(at.getTime() + 1) })
    assert.equal(
        due.failed.some((item) => item.id === schedule.id && item.failure?.code === 'WORKSPACE_CONFLICT'),
        true,
    )
    assert.equal((await posts.get(id, { ref: 'draft' }))?.data.title, 'Later draft')
    assert.equal((await posts.get(id))?.data.title, 'Reviewed')
    await content.unschedule(schedule.id)
    checks.push('native schedule rejects edited drafts without losing edits')

    const workspace = useWorkspace('content', { mode: 'write' })
    const snapshot = await workspace.history.open(reviewed.revision)
    const reviewedBytes = await snapshot.readFile(reviewed.path)
    const head = await workspace.history.head({ ref: 'published' })
    await workspace.history.commit({
        ref: 'published',
        ifHead: head?.id ?? null,
        changes: { put: { [reviewed.path]: reviewedBytes } },
        message: 'Publish immutable reviewed snapshot',
    })
    assert.equal((await posts.get(id))?.data.title, 'Scheduled snapshot')
    assert.equal((await posts.get(id, { ref: 'draft' }))?.digest, later.digest)
    checks.push('immutable Workspace snapshot publication preserves newer draft')

    const unregister = registerWorkspacePlugin('content', {
        id: 'liti-probe-validation',
        hooks: {
            'write:validate': (input) => {
                if (input.path.startsWith('posts/') && String(input.content).includes('FORBIDDEN_PROBE'))
                    throw new Error('PROBE_WRITE_REJECTED')
            },
        },
    })
    try {
        await assert.rejects(posts.save(id, { data: { title: 'FORBIDDEN_PROBE' }, body: '' }), /PROBE_WRITE_REJECTED/)
        const published = await workspace.history.head({ ref: 'published' })
        await assert.rejects(
            workspace.history.commit({
                ref: 'published',
                ifHead: published?.id ?? null,
                changes: { put: { [first.path]: '---\ntitle: FORBIDDEN_PROBE\n---\n' } },
            }),
            /PROBE_WRITE_REJECTED/,
        )
    } finally {
        unregister()
    }
    assert.equal((await posts.get(id, { ref: 'draft' }))?.digest, later.digest)
    checks.push('public Workspace hook blocks Content and direct publication writes')
    return { checks }
}
