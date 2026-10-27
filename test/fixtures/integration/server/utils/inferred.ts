import { databases } from 'vite-hub/database/drizzle'
export function inferredNativeTables() {
    const schema = databases.default.schema
    const game = schema.games.id,
        content = schema.contentSessions
    // @ts-expect-error contributions retain their exact names alongside native Content tables
    const missing = schema.absentModel
    return { game, content, missing }
}
