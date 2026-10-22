import { expect, it, vi } from 'vitest'
import { createRenderer, nextTick, ref } from 'vue'
import { createLitiVue, useAi, useLitiForm, useLitiModels, useLitiQuery } from '../packages/vue/src'
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

it('runs Vue actions explicitly and discards a proposal when its reactive input changes', async () => {
    const input = ref({ content: 'First' })
    const response = Promise.withResolvers<Response>()
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({ input: { content: 'First' } })
        return response.promise
    })
    const runtime = mount(() => useAi('proofread', { input }), fetch)
    try {
        const handle = await runtime.value
        expect(fetch).not.toHaveBeenCalled()
        const pending = handle.execute()
        input.value.content = 'Second'
        response.resolve(Response.json({ data: { content: 'Obsolete' }, metadata: { usage: { inputTokens: 3 } } }))
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(handle.data.value).toBeUndefined()
        expect(handle.metadata.value).toBeUndefined()
        expect(handle.status.value).toBe('idle')
        fetch.mockImplementation(async () =>
            Response.json({ data: { content: 'Second corrected' }, metadata: { usage: { inputTokens: 4 } } }),
        )
        await handle.execute()
        expect(handle.data.value).toEqual({ content: 'Second corrected' })
        expect(handle.metadata.value).toEqual({ usage: { inputTokens: 4 } })
    } finally {
        runtime.stop()
    }
})

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
    const onSuccess = vi.fn()
    const runtime = mount(
        () => {
            const editor = useLitiForm('posts', { id, instance: 'editor', onSuccess })
            return { editor, title: editor.field('title') }
        },
        async (input, init) => {
            if (String(input).endsWith('/models')) return Response.json(descriptor)
            const selected = String(input).split('/').at(-1)!
            if (init?.method === 'PATCH')
                return Response.json(modelEntry(selected, 2, JSON.parse(String(init.body)).data))
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
        editor.form.setFieldValue('title', 'Saved')
        await editor.form.handleSubmit()
        expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }), {
            operation: 'save',
            hasUnsavedChanges: false,
        })
    } finally {
        runtime.stop()
    }
})

it.each(['published', 'current'] as const)(
    'retains the %s page total before projection and across page changes',
    async (view) => {
        const page = ref({ limit: 1, offset: 0 })
        const requests: string[] = []
        const runtime = mount(
            () => useLitiQuery('posts', { view, page, transform: (rows) => rows.map((row) => row.data.title) }),
            async (input) => {
                const url = new URL(String(input), 'http://test')
                if (url.pathname.endsWith('/models')) return Response.json(descriptor)
                requests.push(url.href)
                const offset = Number(url.searchParams.get('offset'))
                return Response.json({
                    items: [
                        view === 'current'
                            ? modelEntry(`entry-${offset}`, 1, { title: String(offset) })
                            : {
                                  data: { _liti: { id: `entry-${offset}`, model: 'posts' }, title: String(offset) },
                              },
                    ],
                    total: 37,
                    limit: 1,
                    offset,
                })
            },
        )
        try {
            const { total } = runtime.value
            expect(total.value).toBe(0)
            expect((await runtime.value).total).toBe(total)
            expect(runtime.value.data.value).toEqual(['0'])
            expect(total.value).toBe(37)
            page.value = { limit: 1, offset: 1 }
            expect(total.value).toBe(0)
            await runtime.value.refresh()
            expect(runtime.value.data.value).toEqual(['1'])
            expect(total.value).toBe(37)
            expect(requests).toHaveLength(2)
            runtime.value.clear()
            expect(total.value).toBe(0)
        } finally {
            runtime.stop()
        }
    },
)

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
