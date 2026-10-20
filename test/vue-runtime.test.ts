import { expect, it } from 'vitest'
import { createRenderer, nextTick, ref } from 'vue'
import { createLitiVue, useLitiForm, useLitiModels, useLitiQuery } from '../packages/vue/src'
import { createLitiClient } from '../packages/liti/src/public-client'
import { createLitiDescriptor } from '../packages/liti/src/descriptor'
import { formConfig, modelEntry } from './model-fixture'
import type { LitiClientOptions } from '../packages/liti/src/client'

const renderer = createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    patchProp: () => {},
    parentNode: () => null,
    nextSibling: () => null,
})
const descriptor = createLitiDescriptor(formConfig)
const mount = <Value>(setup: () => Value, fetch: NonNullable<LitiClientOptions['fetch']>) => {
    let value!: Value
    const app = renderer.createApp({
        setup() {
            value = setup()
            return () => null
        },
    })
    app.use(createLitiVue({ client: createLitiClient({ fetch }), bridge: { descriptor } }))
    app.mount({})
    return { value, stop: () => app.unmount() }
}

it('shares a descriptor DTO while exposing a catalog and stable query handles in ordinary Vue', async () => {
    const requests: string[] = []
    const runtime = mount(
        () => ({
            models: useLitiModels(),
            implicit: useLitiQuery('posts'),
            explicit: useLitiQuery('posts', { mode: 'many' }),
            one: useLitiQuery('posts', { mode: 'one', id: undefined }),
        }),
        async (input) => {
            requests.push(String(input))
            return Response.json(
                String(input).endsWith('/models')
                    ? descriptor
                    : [{ data: { _liti: { id: 'one', model: 'posts' }, title: 'First' } }],
            )
        },
    )
    try {
        const { implicit, explicit, one, models } = runtime.value
        const data = implicit.data
        expect(data.value).toEqual([])
        expect(one.data.value).toBeNull()
        expect((await implicit).data).toBe(data)
        await explicit
        await models
        expect(data.value[0]?.data.title).toBe('First')
        expect(models.data.value.posts?.name).toBe('posts')
        expect(requests.filter((url) => url.endsWith('/content/posts'))).toHaveLength(1)
        expect('remove' in implicit).toBe(false)
    } finally {
        runtime.stop()
    }
})

it('keeps a fixed field on the native form across reset and identity changes', async () => {
    const id = ref<string | null>('one')
    const runtime = mount(
        () => {
            const editor = useLitiForm('posts', { id, instance: 'editor' })
            return { editor, title: editor.field('title') }
        },
        async (input) => {
            if (String(input).endsWith('/models')) return Response.json(descriptor)
            const selected = String(input).split('/').at(-1)!
            return Response.json(modelEntry(selected, 1, { title: selected }))
        },
    )
    try {
        const { editor, title } = runtime.value
        const state = editor.state,
            values = editor.values,
            field = editor.field
        await editor
        expect(editor.state).toBe(state)
        expect(editor.values).toBe(values)
        expect(title.value).toBe('one')
        title.value = 'Changed'
        title.blur()
        expect(editor.form.state.values.title).toBe('Changed')
        expect(state.value.dirty).toBe(true)
        editor.form.reset({ ...editor.form.state.values, title: 'Reset' })
        expect(field('title')).toBe(title)
        expect(title.value).toBe('Reset')
        id.value = 'two'
        await nextTick()
        await editor.refresh()
        expect(title.value).toBe('two')
        expect(editor.state).toBe(state)
        expect(editor.form.state.values.title).toBe('two')
    } finally {
        runtime.stop()
    }
})

it('isolates simultaneous new editors with distinct instances', async () => {
    const runtime = mount(
        () => {
            const first = useLitiForm('posts', { instance: 'first' })
            const second = useLitiForm('posts', { instance: 'second' })
            return { first, second, a: first.field('title'), b: second.field('title') }
        },
        async () => Response.json(descriptor),
    )
    try {
        const { first, second, a, b } = runtime.value
        await Promise.all([first, second])
        a.value = 'First draft'
        b.value = 'Second draft'
        expect(first.values.value.title).toBe('First draft')
        expect(second.values.value.title).toBe('Second draft')
        expect(first.state.value.identity).not.toBe(second.state.value.identity)
        expect(first.state.value.canLeave).toBe(true)
    } finally {
        runtime.stop()
    }
})
