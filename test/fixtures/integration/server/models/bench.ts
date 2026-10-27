import { defineContentModel, field } from '@litijs/model'
import { z } from 'zod'
export const bench = defineContentModel({
    name: 'bench',
    locales: { default: 'ja', supported: ['ja', 'en'] },
    fields: {
        title: field(z.string(), { localized: true }),
        slug: field(z.string(), { localized: true }),
        dataset: field(z.string()),
        cover: field(z.object({ pathname: z.string(), size: z.number() })),
    },
    url: ({ locale, data }) => `/${locale}/bench/${data.slug}`,
    authorize: ({ actor }) => actor.id === 'writer',
})
