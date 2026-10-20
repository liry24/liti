import { defineEventHandler } from 'nuxt/server'
import { db, sql } from 'void/db'
import type { AnyD1Database } from 'drizzle-orm/d1'
import { useVoidDatabase } from '@litijs/void/session'
import { withLitiContext } from 'liti/internal/runtime/context'
const schema = {}

export default defineEventHandler((event) =>
    withLitiContext(event.context, async () => {
        const adapter = useVoidDatabase(schema)
        const binding = (event.context.cloudflare as { env: { DB: AnyD1Database } }).env.DB
        const alternate = { ...event.context, cloudflare: { env: { DB: new Proxy(binding, {}) } } }
        const users = await db.all(sql`SELECT id FROM user`)
        return {
            users: users.length,
            sameAdapterInFreshContext: await withLitiContext(
                { ...event.context },
                () => useVoidDatabase(schema) === adapter,
            ),
            alternateAdapterIsolated: await withLitiContext(alternate, () => useVoidDatabase(schema) !== adapter),
            restoredOriginalBinding: useVoidDatabase(schema) === adapter,
        }
    }),
)
