import { expect, expectTypeOf, test } from 'vite-plus/test'
import { z } from 'zod'
import { getTableColumns, type InferSelectModel } from 'drizzle-orm'
import { defineRecordModel, field } from '@litijs/model'
import { recordSchema } from '@litijs/model/records/schema'

test('native record tables expose model columns and nullable raw SQL values', () => {
    const games = defineRecordModel({
        name: 'games',
        authorize: () => false,
        fields: {
            slug: field(z.string()),
            igdbId: field(z.number().int()),
            metrics: field(z.array(z.object({ key: z.string() }))),
        },
    })
    const tables = recordSchema([games])
    expectTypeOf<InferSelectModel<typeof tables.games>>().toMatchTypeOf<{
        slug: string | null
        igdbId: number | null
        metrics: { key: string }[] | null
    }>()
    expect(getTableColumns(tables.games).slug.name).toBe('slug')
    expect(tables.games.igdbId.dataType).toBe('number')
    expect(tables.games.metrics.dataType).toBe('json')
})
