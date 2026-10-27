import { defineContentModel, defineRecordModel, field } from '@litijs/model'
import { recordSchema } from '@litijs/model/records/schema'
import { z } from 'zod'

const authorize = ({ actor, action }: { actor: { id: string; email?: unknown }; action: string }) =>
    actor.id === 'writer' ||
    actor.id === 'scheduler' ||
    (typeof actor.email === 'string' && actor.email.startsWith('editor-')) ||
    (actor.id === 'write-only' && action === 'save')
export const games = defineRecordModel({
    name: 'games',
    fields: {
        igdbId: field(z.number().int().positive()),
        slug: field(z.string().min(1)),
        privateNote: field(z.string().optional(), { public: false }),
        optionalCode: field(z.string().nullable().optional()),
    },
    unique: [['igdbId'], ['slug'], ['optionalCode']],
    authorize,
})
export const gameStats = defineRecordModel({
    name: 'gameStats',
    fields: {
        game: field(z.string(), { reference: 'games' }),
        periodKey: field(z.string().regex(/^\d{4}-\d{2}$/u)),
        count: field(z.number().int().nonnegative()),
    },
    unique: [['game', 'periodKey']],
    authorize,
})
export const posts = defineContentModel({
    name: 'posts',
    title: 'title',
    locales: { default: 'ja', supported: ['ja', 'en'] },
    fields: {
        title: field(z.string().min(1), { localized: true }),
        slug: field(z.string().min(1), { localized: true }),
        tags: field(z.array(z.string())),
        game: field(z.string().optional(), { reference: 'games' }),
        secret: field(z.string().optional(), { public: false }),
    },
    url: ({ locale, data }) => `/${locale}/posts/${data.slug}`,
    authorize,
    prepare: (input, context) => {
        if (input.data.secret === 'EXPECT_BODY_CONTEXT' && context.body !== 'Retained Markdown body')
            throw new Error('Preparation must receive the retained Markdown body.')
        return input
    },
    validate: (data) => {
        if (data.title === 'FORBIDDEN') throw new Error('MODEL_RULE_REJECTED')
    },
})
export const works = defineContentModel({
    name: 'works',
    format: 'json',
    fields: { name: field(z.string()), post: field(z.string().optional(), { reference: 'posts' }) },
    authorize,
})
export const cards = defineContentModel({
    name: 'cards',
    format: 'json',
    fields: { name: field(z.string()) },
    authorize,
})
export const tables = recordSchema([games, gameStats])
