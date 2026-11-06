import { defineContentModel, field } from '@litijs/model'
import { z } from 'zod'
export const memos = defineContentModel({
    name: 'memos',
    fields: { title: field(z.string()), secret: field(z.string(), { public: false }) },
    authorize: ({ actor, id }) =>
        typeof actor.email === 'string' && actor.email.startsWith('editor-') && (!id || id === actor.id),
})
