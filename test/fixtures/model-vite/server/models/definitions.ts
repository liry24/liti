import { defineRecordModel, defineContentModel, field } from '@litijs/model'
import { recordSchema } from '@litijs/model/records/schema'
import { z } from 'zod'
const authorize = ({ actor }: { actor: { id: string } }) => actor.id === 'writer'
export const games = defineRecordModel({
    name: 'games',
    fields: { slug: field(z.string().min(1)), igdbId: field(z.number().int().positive()) },
    unique: [['slug'], ['igdbId']],
    authorize,
})
export const stats = defineRecordModel({
    name: 'stats',
    fields: { game: field(z.string(), { reference: 'games' }), period: field(z.string()) },
    unique: [['game', 'period']],
    authorize,
})
export const notes = defineContentModel({
    name: 'notes',
    fields: {
        title: field(z.string().min(1)),
        slug: field(z.string().min(1)),
        game: field(z.string(), { reference: 'games' }),
    },
    url: ({ data }) => `/notes/${data.slug}`,
    authorize,
})
export const tables = recordSchema([games, stats])
