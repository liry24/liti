import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import { blog } from '../packages/blog/src'
import blogExtensions, { type BlogForm } from '../packages/blog/src/vue'
import { createLitiDescriptor } from '../packages/liti/src/descriptor'
import { useEntryForm } from '../packages/vue/src/form'
import { modelEntry, modelFixture } from './model-fixture'

const scopes: EffectScope[] = []
afterEach(() => {
    for (const scope of scopes.splice(0)) scope.stop()
})
const setup = (proofreading: string | null = 'proofread', existing = true) => {
    const plugin = blog({ models: { posts: { ...(proofreading ? { proofreading } : {}) } } })
    const descriptor = createLitiDescriptor({ models: plugin.models }).models.posts!
    const data = { title: 'Title', content: 'Original.', tags: [], slug: 'post', publication: { slug: 'manual' } }
    const action = vi.fn(async () => Response.json({ data: { content: 'Corrected.' } }))
    const writes = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body))
        return Response.json(
            modelEntry('one', (input.expectedVersion ?? 0) + 1, input.data ?? input.draft?.data ?? data),
        )
    })
    const scope = effectScope()
    scopes.push(scope)
    const fixture = scope.run(() =>
        modelFixture(
            (url, init) => (String(url).includes('/actions/') ? action() : writes(url, init)),
            existing ? modelEntry('one', 1, data) : null,
            {},
            { model: 'posts', descriptor },
        ),
    )!
    const editor = scope.run(() => useEntryForm(fixture.resource, { defaultValues: data }, blogExtensions))!
    const namespace = editor.blog as BlogForm
    return { editor, namespace, fixture, scope, action, writes }
}

it('exposes stable review operations, keeps title edits, and applies only the body without saving', async () => {
    const {
        editor,
        namespace: { review, proofread, applyProofreading, discardProofreading },
        action,
        writes,
        scope,
    } = setup()
    const response = Promise.withResolvers<Response>()
    action.mockReturnValueOnce(response.promise)
    const body = scope.run(() => editor.field('content'))!
    const pending = proofread()
    expect(editor.state.value.busy).toBe(true)
    expect(editor.state.value.canLeave).toBe(false)
    editor.form.setFieldValue('title', 'Edited during proofreading')
    response.resolve(Response.json({ data: { content: 'Corrected.' } }))
    await pending
    expect(review.value).toMatchObject({ original: 'Original.', proposal: 'Corrected.', stale: false, canApply: true })
    expect(editor.state.value.can.publish).toBe(false)
    expect(editor.state.value.can.save).toBe(true)
    await applyProofreading()
    expect(body.value).toBe('Corrected.')
    expect(editor.values.value.title).toBe('Edited during proofreading')
    expect(review.value.applied).toBe(true)
    expect(editor.state.value.can.publish).toBe(true)
    expect(writes).not.toHaveBeenCalled()
    discardProofreading()
    expect(body.value).toBe('Corrected.')
})

it('allows draft saves with a proposal and guards direct publish and schedule calls', async () => {
    const { editor, namespace, writes } = setup()
    await namespace.proofread()
    await editor.save()
    expect(writes).toHaveBeenCalledTimes(1)
    expect(namespace.review.value).toMatchObject({ stale: false, canApply: true })
    await editor.publish()
    await editor.schedule('2099-01-01T00:00:00Z')
    expect(writes).toHaveBeenCalledTimes(1)
    expect(editor.state.value.blocked.publish).toBe('review-pending')
    namespace.discardProofreading()
    await editor.publish()
    expect(writes).toHaveBeenCalledTimes(2)
})

it('keeps a new editor local during proofreading and invalidates proposals only for changed content or identity', async () => {
    const { editor, namespace, fixture, action, writes } = setup('proofread', false)
    await namespace.proofread()
    expect(fixture.id.value).toBeNull()
    expect(writes).not.toHaveBeenCalled()
    editor.form.setFieldValue('content', 'Author revision.')
    expect(namespace.review.value.stale).toBe(true)
    await expect(namespace.applyProofreading()).rejects.toThrow('cannot be applied')
    expect(editor.values.value.content).toBe('Author revision.')
    const response = Promise.withResolvers<Response>()
    action.mockReturnValueOnce(response.promise)
    const pending = namespace.proofread()
    fixture.identity.value = 'alice:posts:other:ja'
    response.resolve(Response.json({ data: { content: 'Late proposal.' } }))
    await pending
    expect(namespace.review.value).toMatchObject({ status: 'idle', proposal: null })
})

it('preserves the namespace without AI and rejects invalid protected fragments or late disposed results', async () => {
    const disabled = setup(null)
    expect(disabled.namespace.review.value.availability).toBe('unavailable')
    expect(disabled.editor.state.value.can.proofread).toBe(false)
    await expect(disabled.namespace.proofread()).rejects.toThrow('not configured')
    expect(disabled.action).not.toHaveBeenCalled()
    const fixture = setup()
    fixture.editor.form.setFieldValue('content', 'Keep `code`.')
    fixture.action.mockResolvedValueOnce(Response.json({ data: { content: 'Keep `changed`.' } }))
    await fixture.namespace.proofread()
    expect(fixture.namespace.review.value).toMatchObject({ invalid: true, canApply: false })
    expect(fixture.editor.values.value.content).toBe('Keep `code`.')
    const response = Promise.withResolvers<Response>()
    fixture.action.mockReturnValueOnce(response.promise)
    const pending = fixture.namespace.proofread()
    fixture.scope.stop()
    response.resolve(Response.json({ data: { content: 'Late.' } }))
    await pending
    expect(fixture.namespace.review.value.proposal).toBeNull()
})
