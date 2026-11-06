import { defineArticle } from '@litijs/blog'
import { field } from '@litijs/model'
import { z } from 'zod'
export const articles = defineArticle({
    name: 'articles',
    locales: { default: 'ja', supported: ['ja', 'en'] },
    fields: {
        game: field(z.string().optional(), { reference: 'games' }),
        secret: field(z.string().optional(), { public: false }),
    },
    authorize: ({ actor }) =>
        actor.id === 'writer' ||
        actor.id === 'scheduler' ||
        (typeof actor.email === 'string' && actor.email.startsWith('editor-')),
})
