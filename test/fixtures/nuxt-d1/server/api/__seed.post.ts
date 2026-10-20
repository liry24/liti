import { defineEventHandler, getQuery } from 'nuxt/server'
import { useLitiRuntime } from 'liti/internal/nuxt/server'
import { withLitiContext } from 'liti/internal/runtime/context'

export default defineEventHandler((event) =>
    withLitiContext(event.context, async () => {
        const site = await useLitiRuntime().getLiti(event)
        const kind = getQuery(event).kind === 'scheduled' ? 'scheduled' : 'manual'
        const entry = await site.createEntry('posts', { data: { title: `D1 ${kind} runtime`, slug: kind } })
        const scheduled = await site.schedulePublish(entry.id, {
            expectedVersion: entry.version,
            at: new Date(Date.now() + 500),
        })
        return { id: entry.id, scheduledAt: scheduled.scheduledAt, firstPublishedAt: scheduled.firstPublishedAt }
    }),
)
