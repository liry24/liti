import { defineEventHandler } from 'nuxt/server'
import { useLitiRuntime } from 'liti/internal/nuxt/server'
import { withLitiContext } from 'liti/internal/runtime/context'

export default defineEventHandler((event) =>
    withLitiContext(event.context, async () => {
        const core = await useLitiRuntime().getLiti(event)
        const entry = await core.createEntry('posts', {
            data: { title: 'ΣΟΣ '.repeat(250), slug: 'synthetic-unicode-search' },
        })
        const started = performance.now()
        const data = await core.pageEntries({ models: ['posts'], q: 'σος' }, { limit: 1, offset: 0 })
        const result = { data, elapsed: performance.now() - started }
        await core.deleteEntry(entry.id, { expectedVersion: entry.version })
        return result
    }),
)
