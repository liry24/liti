import { databases, db, schema } from 'vite-hub/database/drizzle'
export function inferredNativeTables() {
    const schema = databases.default.schema
    const game = schema.games.id,
        content = schema.contentSessions
    // @ts-expect-error contributions retain their exact names alongside native Content tables
    const missing = schema.absentModel
    return { game, content, missing }
}
export async function typedNativeRecords() {
    const [game] = await db.select({ slug: schema.games.slug, igdbId: schema.games.igdbId }).from(schema.games).limit(1)
    if (!game) return null
    const slug: string | null = game.slug,
        igdbId: number | null = game.igdbId
    return { slug, igdbId }
}
