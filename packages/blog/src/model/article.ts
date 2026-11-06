import { defineContentModel, field, ModelError, type ContentModelOptions, type Fields } from '@litijs/model'
import { image } from '@vite-hub/blob/reference'
import { optional } from '@vite-hub/content/collections'

import { z } from 'zod'
import { articleSlug } from './slug'

const standardFields = {
    title: field(z.string().trim().min(1), { localized: true }),
    slug: field(
        z
            .string()
            .min(1)
            .max(210)
            .regex(/^[^\s/?#\\]+$/u)
            .refine((value) => value !== '.' && value !== '..', 'Use one article path segment.'),
        { localized: true },
    ),
    summary: field(z.string().optional(), { localized: true, input: 'textarea' }),
    tags: field(z.array(z.string()).default([])),
    author: field(z.string().optional()),
    cover: field(optional(image()), { input: 'image' }),
    authoredAt: field(
        z
            .union([z.iso.date(), z.iso.datetime({ offset: true })])
            .nullable()
            .optional(),
        { input: 'date' },
    ),
}
export interface ArticleOptions<F extends Fields, N extends string> extends Omit<
    ContentModelOptions<typeof standardFields & F>,
    'name' | 'fields' | 'format' | 'title'
> {
    name: N
    fields?: F
}

/** Native Content owns body/history; publication dates come from Model's successful native commit. */
// oxlint-disable-next-line typescript/no-generated-empty-object-type -- No extra fields preserves inference for the standard article fields.
export function defineArticle<const F extends Fields = Record<never, never>, const N extends string = 'posts'>(
    options: ArticleOptions<F, N>,
) {
    for (const key of Object.keys(options.fields ?? {}))
        if (key in standardFields)
            throw new ModelError('LITI_INVALID_MODEL', `Article field ${key} is already standardized.`)
    const { fields, prepare, validate, ...rest } = options
    const defaultUrl = ({ locale, data }: { locale: string; data: object }) => {
        if (!('slug' in data) || typeof data.slug !== 'string') return null
        return `${options.locales ? `/${locale}` : ''}/${options.name}/${encodeURIComponent(data.slug)}`
    }
    return defineContentModel({
        ...rest,
        locales: options.locales ?? { default: 'und', supported: ['und'] },
        format: 'markdown',
        title: 'title',
        fields: { ...standardFields, ...fields } as typeof standardFields & F,
        url: options.url ?? defaultUrl,
        async prepare(input, context) {
            const prepared = prepare ? await prepare(input, context) : input
            const data = { ...prepared.data }
            const original = context.locale === (options.locales?.default ?? 'und')
            if (original || Object.hasOwn(data, 'slug') || Object.hasOwn(data, 'title')) {
                if (typeof data.slug === 'string' && data.slug.trim()) data.slug = data.slug.trim()
                else if (typeof context.previous?.slug === 'string' && context.previous.slug)
                    data.slug = context.previous.slug
                else if (original || typeof data.title === 'string')
                    data.slug = articleSlug(String(data.title ?? ''), context.id)
            }
            return { ...prepared, data }
        },
        async validate(data, context) {
            if ((context.action === 'publish' || context.action === 'schedule') && !context.body?.trim())
                throw new ModelError('LITI_INVALID_INPUT', 'Write an article body.', [
                    { path: ['body'], message: 'An article body is required.' },
                ])
            await validate?.(data, context)
        },
    })
}
