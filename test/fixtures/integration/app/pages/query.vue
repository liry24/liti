<script setup lang="ts">
const route = useRoute()
const { data, total, status } = await useLitiQuery('posts', { locale: 'ja', limit: 1 })
const { data: one } = await useLitiQuery('posts', { mode: 'one', id: () => String(route.query.id), locale: 'en' })
const { data: transformed, total: transformedTotal } = await useLitiQuery('posts', {
    locale: 'ja',
    limit: 1,
    transform: (entries) => entries.map((entry) => entry.data.title),
})
const { data: sparse } = await useLitiQuery('posts', {
    mode: 'one',
    id: () => String(route.query.id),
    locale: 'en',
    fallback: false,
})
useLitiSeo(() => ({ url: one.value?.url ?? null, title: one.value?.data.title, publication: one.value?.publication }), {
    origin: 'https://example.test',
})
if (false) {
    if (sparse.value) {
        const entry = sparse.value!
        const tags: string[] = entry.data.tags
        const slug: string | undefined = entry.data.slug
        // @ts-expect-error A sparse translated field may be absent without fallback.
        const requiredSlug: string = entry.data.slug
        console.log(tags, slug, requiredSlug)
    }
    const title: string | undefined = one.value?.data.title
    // @ts-expect-error Public types must omit server-only fields.
    console.log(one.value?.data.secret)
    // @ts-expect-error Model names are generated from server/models.
    void useLitiQuery('absentModel')
    console.log(title)
}
onMounted(() => {
    document.documentElement.dataset.hydrated = 'true'
    if (route.query.bundle === '1') {
        const scripts = performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((name) => new URL(name).pathname.startsWith('/_nuxt/') && new URL(name).pathname.endsWith('.js'))
        ;(window as unknown as { __litiProbe: object }).__litiProbe = { done: true, scripts }
    }
})
</script>
<template>
    <main>
        <p id="status">{{ status }}</p>
        <p id="total">{{ total }}</p>
        <p id="one">{{ one?.data.title }}</p>
        <p id="many">{{ data.length }}</p>
        <p id="transformed">{{ transformed.join(',') }}</p>
        <p id="transformed-total">{{ transformedTotal }}</p>
    </main>
</template>
