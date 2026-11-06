import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const games = sqliteTable('probe_games', {
    id: text('id').primaryKey(),
    igdbId: integer('igdb_id').notNull().unique(),
    slug: text('slug').notNull().unique(),
})

export const gameStats = sqliteTable(
    'probe_game_stats',
    {
        id: text('id').primaryKey(),
        game: text('game')
            .notNull()
            .references(() => games.id, { onDelete: 'restrict' }),
        periodKey: text('period_key').notNull(),
    },
    (table) => [uniqueIndex('probe_stats_game_period').on(table.game, table.periodKey)],
)

export const recordsSchema = { games, gameStats }
