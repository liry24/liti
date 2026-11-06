import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { useDatabase } from 'vite-hub/database/drizzle'
import { games, gameStats } from '../database/records'

export async function verifyRecords() {
    const { db, schema } = useDatabase('default')
    assert.ok('games' in schema && 'gameStats' in schema)
    const id = crypto.randomUUID()
    const igdbId = parseInt(id.replaceAll('-', '').slice(0, 12), 16)
    const race = await Promise.allSettled(
        [0, 1].map((index) =>
            db
                .insert(games)
                .values({ id: `${id}-${index}`, igdbId, slug: `${id}-${index}` })
                .returning(),
        ),
    )
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
    const saved = await db.select().from(games).where(eq(games.igdbId, igdbId))
    assert.equal(saved.length, 1)
    const game = saved[0]!

    const slugRace = await Promise.allSettled(
        [0, 1].map((index) =>
            db
                .insert(games)
                .values({ id: `${id}-slug-${index}`, igdbId: igdbId + index + 1, slug: `${id}-shared` })
                .returning(),
        ),
    )
    assert.equal(slugRace.filter((result) => result.status === 'fulfilled').length, 1)
    const statsRace = await Promise.allSettled(
        [0, 1].map((index) =>
            db
                .insert(gameStats)
                .values({ id: `${id}-stat-${index}`, game: game.id, periodKey: '2026-10' })
                .returning(),
        ),
    )
    assert.equal(statsRace.filter((result) => result.status === 'fulfilled').length, 1)
    await assert.rejects(
        db.insert(gameStats).values({ id: `${id}-missing`, game: 'missing-game', periodKey: '2026-10' }),
    )
    await assert.rejects(db.delete(games).where(eq(games.id, game.id)))
    assert.equal((await db.select().from(games).where(eq(games.id, game.id))).length, 1)

    await assert.rejects(
        db.batch([
            db.insert(games).values({ id: `${id}-rollback`, igdbId: igdbId + 100, slug: `${id}-rollback` }),
            db.insert(games).values({ id: `${id}-conflict`, igdbId, slug: `${id}-conflict` }),
        ]),
    )
    assert.equal(
        (
            await db
                .select()
                .from(games)
                .where(eq(games.id, `${id}-rollback`))
        ).length,
        0,
    )
    await db.delete(gameStats).where(eq(gameStats.game, game.id))
    await db.delete(games).where(eq(games.id, game.id))
    return ['Database contribution, native unique/FK constraints and atomic rollback']
}
