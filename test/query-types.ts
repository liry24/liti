import { createLitiClient, type LitiSchema } from '../packages/liti/src/public-client'
import type { UseLitiQuery } from '../packages/nuxt/src/runtime/composables'
import type { UseLitiQuery as VueQuery } from '../packages/vue/src'
import { ref } from 'vue'

type Schema = {
    publicModels: { posts: { id: string; data: { title: string; body: { nodes: unknown[] } } } }
    publicSummaryModels: { posts: { id: string; data: { title: string; body: { nodes: unknown[]; meta: {} } } } }
    managementModels: { posts: { title: string; body: string }; private: { secret: string } }
    formModels: { posts: { title: string; body: string }; private: { secret: string } }
    actions: {}
}
const schemaCheck: Schema extends LitiSchema ? true : false = true
const client = createLitiClient<Schema>()
declare const query: UseLitiQuery
declare const vueQuery: VueQuery

async function contracts() {
    const implicit = await client.query('posts')
    const explicit = await client.query('posts', { mode: 'many' })
    const title: string = implicit[0]!.data.title
    const same: typeof implicit = explicit
    const page = await client.queryPage('posts', { page: { limit: 20, offset: 0 } })
    const pageTitle: string = page.items[0]!.data.title
    // @ts-expect-error Page queries require pagination.
    await client.queryPage('posts', {})
    // @ts-expect-error One queries cannot request page metadata.
    await client.queryPage('posts', { mode: 'one', id: 'post', pageSize: 20 })
    const one = await client.query('posts', { mode: 'one', id: 'post' })
    const current = await client.query('posts', { mode: 'one', view: 'current', id: 'post' })
    const source: string | undefined = current?.data.body
    const nodes: unknown[] | undefined = one?.data.body.nodes
    await client.query('private', { view: 'current' })
    // @ts-expect-error A private model has no published query.
    await client.query('private')
    // @ts-expect-error one requires a selector.
    await client.query('posts', { mode: 'one' })
    // @ts-expect-error one selectors are exclusive.
    await client.query('posts', { mode: 'one', id: 'one', path: '/one' })
    // @ts-expect-error An id does not infer one mode.
    await client.query('posts', { id: 'one' })
    // @ts-expect-error Current entries have no published route selector.
    await client.query('posts', { mode: 'one', view: 'current', path: '/one' })
    // @ts-expect-error Model names come from the generated schema.
    await client.query('missing')

    const many = query('posts')
    const listTitle: string = many.data.value[0]!.data.title
    const total: number = many.total.value
    const single = query('posts', { mode: 'one', id: ref<string | undefined>() })
    const singleTitle: string | undefined = single.data.value?.data.title
    // @ts-expect-error A single entry has no collection total.
    void single.total
    const transformed = query('posts', {
        transform: (entries) => entries.map((entry) => entry.data.title),
        default: () => [],
    })
    const titles: string[] = transformed.data.value
    const selected = query('posts', { mode: 'one', id: 'id', pick: ['data'] })
    // @ts-expect-error pick removes identity.
    void selected.data.value?.id
    // @ts-expect-error Published queries have no mutation methods.
    many.remove()
    const managed = query('posts', { view: 'current' })
    await managed.remove(managed.data.value[0])
    // @ts-expect-error Wrong default shape must not widen the inferred DTO.
    void query('posts', { default: () => 42 })
    // @ts-expect-error A one query must have a selector.
    void query('posts', { mode: 'one' })
    // @ts-expect-error Multiple selectors are rejected.
    void query('posts', { mode: 'one', id: 'id', path: '/path' })
    const vue = vueQuery('posts')
    const vueTitle: string = vue.data.value[0]!.data.title
    const vueTransformed = vueQuery('posts', { transform: (rows) => rows.map((row) => row.data.title) })
    const vueTitles: string[] = vueTransformed.data.value
    // @ts-expect-error Published Vue queries have no mutations.
    vue.remove()
    // @ts-expect-error Plain Vue also requires a selector.
    void vueQuery('posts', { mode: 'one' })
    // @ts-expect-error Selector presence does not infer one mode.
    void vueQuery('posts', { id: 'one' })
    // @ts-expect-error Wrong defaults cannot widen the query result.
    void vueQuery('posts', { default: () => 42 })
    void [vueTitle, vueTitles]
    void [schemaCheck, title, same, source, nodes, listTitle, singleTitle, titles, pageTitle, total, vue.total.value]
}
void contracts
