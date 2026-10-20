import { createSSRApp, h, nextTick, onMounted, onServerPrefetch, ref } from 'vue'
import { createLitiClient } from 'liti/client'
import { createLitiVue, useLitiForm } from 'liti/vue'

const descriptor = {
    assets: false,
    models: {
        posts: {
            fields: {
                title: { kind: 'text', required: true, serverValidation: false },
                items: {
                    kind: 'array',
                    required: true,
                    serverValidation: false,
                    item: { kind: 'text', required: true, serverValidation: false },
                },
            },
            public: true,
            publishing: false,
            scheduling: false,
            revisions: false,
            sortable: false,
            serverValidation: false,
        },
    },
}
const check = (value, message) => {
    if (!value) throw new Error(message)
}
export const createApp = () => {
    const app = createSSRApp({
        setup() {
            const editor = useLitiForm('posts', { defaultValues: { title: 'initial', items: ['first'] } })
            const title = editor.field('title')
            const state = editor.state
            const values = editor.values
            const visible = ref(true)
            let nativeField
            onServerPrefetch(() => editor.then(() => {}))
            onMounted(async () => {
                try {
                    await editor
                    await nextTick()
                    check(window.__ssrInput === document.querySelector('#title'), 'Hydration replaced the native field')
                    check(title.value === 'initial', 'Initial value changed')
                    title.value = 'accessor'
                    await nextTick()
                    check(document.querySelector('#title').value === 'accessor', 'Accessor did not update native Field')
                    check(
                        document.querySelector('#subscription').textContent === 'accessor',
                        'Subscribe lost the shared form',
                    )
                    nativeField.handleChange('native')
                    await nextTick()
                    check(
                        title.value === 'native' && values.value.title === 'native',
                        'Native change did not update accessor',
                    )
                    editor.form.pushFieldValue('items', 'second')
                    editor.form.swapFieldValues('items', 0, 1)
                    editor.form.removeFieldValue('items', 1)
                    await nextTick()
                    check(JSON.stringify(values.value.items) === '["second"]', 'Native array operations diverged')
                    editor.form.reset({ title: 'reset', items: [] })
                    await nextTick()
                    check(title.value === 'reset', 'Reset did not update accessor')
                    visible.value = false
                    await nextTick()
                    visible.value = true
                    await nextTick()
                    check(document.querySelector('#title').value === 'reset', 'Remounted field lost the form value')
                    check(
                        editor.state === state && editor.values === values && editor.field('title') === title,
                        'Handles changed identity',
                    )
                    window.__litiProbe = { done: true, ok: true }
                } catch (error) {
                    window.__litiProbe = { done: true, ok: false, error: String(error.stack ?? error) }
                }
            })
            return () =>
                h('main', [
                    visible.value
                        ? h(
                              editor.form.Field,
                              { name: 'title' },
                              {
                                  default: ({ field }) => {
                                      nativeField = field
                                      return h('input', { id: 'title', value: field.state.value })
                                  },
                              },
                          )
                        : null,
                    h(
                        editor.form.Subscribe,
                        { selector: (current) => current.values.title },
                        {
                            default: (value) => h('output', { id: 'subscription' }, value),
                        },
                    ),
                ])
        },
    })
    app.use(
        createLitiVue({
            client: createLitiClient({ fetch: async () => Response.json(descriptor) }),
            bridge: { descriptor },
        }),
    )
    return app
}

if (typeof document !== 'undefined') {
    window.__ssrInput = document.querySelector('#title')
    createApp().mount('#app')
}
