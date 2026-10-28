<script setup lang="ts">
import { ref, onMounted } from 'vue'
const source = ref({ identity: 'actor:entry:ja', body: 'Original. `code`', revision: 'one' })
const title = ref('Keep this unrelated edit')
const review = useArticleReview({
    source,
    execute: async () => ({ body: 'Reviewed. `code`' }),
    apply: (body) => {
        source.value = { ...source.value, body }
    },
})
const date = {
    data: { authoredAt: '2020-01-02' },
    publication: { firstPublishedAt: '2021-01-01T00:00:00Z', updatedAt: '2022-01-01T00:00:00Z' },
}
const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message)
}
onMounted(async () => {
    const checks: string[] = []
    try {
        await review.propose()
        check(review.canApply.value, 'A validated proposal must be reviewable')
        source.value = { ...source.value, body: 'Later editing' }
        check(review.stale.value && !review.canApply.value, 'Later editing must invalidate a proposal')
        let rejected = false
        try {
            await review.apply()
        } catch {
            rejected = true
        }
        check(rejected && source.value.body === 'Later editing', 'Stale proposal overwrote the current article')
        source.value = { ...source.value, body: 'Original. `code`' }
        await review.propose()
        await review.apply()
        check(
            source.value.body === 'Reviewed. `code`' && title.value === 'Keep this unrelated edit',
            'Apply must preserve unrelated edits',
        )
        source.value = { ...source.value, identity: 'actor:other:en' }
        check(review.state.value.status === 'idle', 'Changing article/locale must clear the prior review')
        check(
            document.querySelector('time')?.getAttribute('datetime') === '2020-01-02',
            'Authored date component failed hydration',
        )
        checks.push(
            'Blog Vue/Nuxt review preserves later edits, rejects stale proposals, resets identity and hydrates article dates',
        )
        Object.assign(window, { __litiProbe: { done: true, success: true, checks } })
    } catch (error) {
        Object.assign(window, { __litiProbe: { done: true, success: false, error: String(error), checks } })
    }
})
</script>
<template>
    <main>
        <h1>Article review probe</h1>
        <LitiArticleDate :entry="date" locale="ja" />
        <p>{{ source.body }}</p>
    </main>
</template>
