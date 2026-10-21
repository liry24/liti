import {
    array,
    datetime,
    image,
    markdown,
    object,
    select,
    text,
    LitiError,
    type FieldRecord,
    type ModelDefinition,
    type ModelPreparationContext,
    type PublicEntry,
    type PublicEntrySeo,
} from 'liti'
import { availableSlug, slugFromTitle } from './slug'

export { createProofreader, protectedMarkdown, validateProofreading } from './proofreading'
export type { ProofreadingOptions, ProofreadingInput } from './proofreading'

const defaultFields = (mode: 'auto' | 'manual', i18n = false) => ({
    title: text({ required: true, i18n }),
    content: markdown({ required: true, i18n }),
    slug: text({ default: '', maxLength: 80, i18n }),
    tags: array(text(), { required: true, default: [] }),
    cover: image(),
    authoredAt: datetime(),
    byline: text(),
    publication: object({ slug: select(['auto', 'manual'], { default: mode }) }, { i18n, default: { slug: mode } }),
})

export type BlogRole = keyof ReturnType<typeof defaultFields>
export type BlogEditorOptions = {
    fields: Record<BlogRole, string>
    proofreading: string | null
    guard: 'none' | 'pending' | 'required'
}
export interface BlogModelOptions extends Omit<
    ModelDefinition,
    'fields' | 'publishing' | 'scheduling' | 'publicMeta' | 'editor'
> {
    fields?: FieldRecord
    i18n?: boolean
    mapping?: Partial<Record<BlogRole, string>>
    proofreading?: string | { action: string; guard?: BlogEditorOptions['guard'] }
    slug?: {
        mode: 'auto' | 'manual'
        action?: string
        generate?: (
            input: { title: string; context?: string },
            context: ModelPreparationContext,
        ) => { slug: string } | Promise<{ slug: string }>
    }
}
type MappedFields<Options> = {
    [
        Role in BlogRole as Options extends { mapping: infer Mapping }
            ? Role extends keyof Mapping
                ? Extract<Mapping[Role], string>
                : Role
            : Role
    ]: ReturnType<typeof defaultFields>[Role]
}
type BlogFields<Options> = Options extends { fields: infer Fields extends FieldRecord }
    ? Omit<MappedFields<Options>, keyof Fields> & Fields
    : MappedFields<Options>
export type ArticleDates = {
    date: string | null
    authoredAt: string | null
    firstPublishedAt: string | null
    updatedAt: string
}
type BlogModel<Options> = Omit<ModelDefinition<BlogFields<Options>>, 'publicMeta' | 'editor'> & {
    publicMeta(entry: PublicEntry): { blog: ArticleDates }
    editor: { blog: BlogEditorOptions }
}

/** Article models contribute once; core owns persistence, revisions and the common public projection. */
export function blog<const Models extends Record<string, BlogModelOptions>>(configuration: { models: Models }) {
    const models: Record<string, ModelDefinition> = {}
    const actions: Array<{ name: string; contract: string }> = []
    for (const [name, options] of Object.entries(configuration.models)) {
        const mode = options.slug?.mode ?? 'manual'
        const defaults = defaultFields(mode, options.i18n)
        const mapping = Object.fromEntries(
            Object.keys(defaults).map((key) => [key, options.mapping?.[key as BlogRole] ?? key]),
        ) as Record<BlogRole, string>
        if (new Set(Object.values(mapping)).size !== Object.keys(mapping).length)
            throw new LitiError('LITI_INVALID_INPUT', `Blog "${name}" must map each role to a distinct field.`)
        const fields = {
            ...Object.fromEntries(Object.entries(defaults).map(([key, value]) => [mapping[key as BlogRole], value])),
            ...options.fields,
        }
        for (const role of Object.keys(defaults) as BlogRole[])
            if (fields[mapping[role]]?.kind !== defaults[role].kind)
                throw new LitiError(
                    'LITI_INVALID_INPUT',
                    `Blog "${name}" field "${mapping[role]}" must be ${defaults[role].kind}.`,
                )
        if (options.slug?.action && options.slug.generate)
            throw new LitiError('LITI_INVALID_INPUT', `Blog "${name}" must select one slug generator.`)
        if (options.slug?.action) actions.push({ name: options.slug.action, contract: 'liti.slug/v1' })
        const proofreading =
            typeof options.proofreading === 'string' ? options.proofreading : options.proofreading?.action
        if (proofreading) actions.push({ name: proofreading, contract: 'liti.proofread/v1' })
        const dates = (entry: PublicEntry): ArticleDates => {
            const authoredAt =
                typeof entry.data[mapping.authoredAt] === 'string' && entry.data[mapping.authoredAt]
                    ? (entry.data[mapping.authoredAt] as string)
                    : null
            return {
                date: authoredAt ?? entry.firstPublishedAt,
                authoredAt,
                firstPublishedAt: entry.firstPublishedAt,
                updatedAt: entry.updatedAt,
            }
        }
        const { mapping: _mapping, slug: _slug, proofreading: _proofreading, i18n: _i18n, ...model } = options
        models[name] = {
            ...model,
            fields,
            publishing: true,
            scheduling: true,
            route: options.route ?? `/${name}/:${mapping.slug}`,
            displayFields: options.displayFields ?? {
                title: mapping.title,
                description: mapping.content,
                image: mapping.cover,
            },
            editor: {
                blog: {
                    fields: mapping,
                    proofreading: proofreading ?? null,
                    guard:
                        typeof options.proofreading === 'object'
                            ? (options.proofreading.guard ?? 'pending')
                            : 'pending',
                },
            },
            publicMeta: (entry) => ({ blog: { ...dates(entry) } }),
            seo(entry, context) {
                const { date, updatedAt } = dates(entry)
                return {
                    type: 'article',
                    ...(date ? { articlePublishedTime: date } : {}),
                    articleModifiedTime: updatedAt,
                    ...(typeof options.seo === 'function' ? options.seo(entry, context) : options.seo),
                } satisfies PublicEntrySeo
            },
            async preparePublication(context) {
                await options.preparePublication?.(context)
                const data = context.data
                if (typeof data[mapping.slug] === 'string' && (data[mapping.slug] as string).trim()) {
                    data[mapping.slug] = (data[mapping.slug] as string).trim()
                    return
                }
                const settings = data[mapping.publication]
                const automatic =
                    settings &&
                    typeof settings === 'object' &&
                    !Array.isArray(settings) &&
                    'slug' in settings &&
                    settings.slug === 'auto'
                if (!automatic || context.previous?.firstPublishedAt) return
                const input = {
                    title: String(data[mapping.title] ?? ''),
                    context: String(data[mapping.content] ?? ''),
                }
                let result: unknown
                try {
                    result = options.slug?.action
                        ? (await context.executeAction(options.slug.action, input)).data
                        : await options.slug?.generate?.(input, context)
                } catch (error) {
                    context.signal?.throwIfAborted()
                    context.request?.signal.throwIfAborted()
                    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
                    if (
                        (context.deadline !== undefined && context.deadline <= Date.now()) ||
                        (error instanceof Error && error.name === 'AbortError') ||
                        (typeof code === 'string' &&
                            code.startsWith('LITI_') &&
                            ![
                                'LITI_ACTION_FAILED',
                                'LITI_ACTION_OUTPUT_INVALID',
                                'LITI_AI_FAILED',
                                'LITI_AI_OUTPUT_INVALID',
                                'LITI_AI_UNAVAILABLE',
                            ].includes(code))
                    )
                        throw error
                }
                const generated =
                    result &&
                    typeof result === 'object' &&
                    'slug' in result &&
                    typeof result.slug === 'string' &&
                    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result.slug) &&
                    result.slug.length <= 80
                        ? result.slug
                        : slugFromTitle(input.title)
                data[mapping.slug] = await availableSlug(context, mapping.slug, generated)
            },
            async validatePublication(context) {
                const slug = context.data[mapping.slug]
                if (typeof slug !== 'string' || !/^[^\s/?#]+$/u.test(slug) || slug.length > 80)
                    context.issues.push({ path: mapping.slug, message: 'Enter a valid slug before publishing.' })
                await options.validatePublication?.(context)
            },
        }
    }
    return {
        id: '@litijs/blog',
        apiVersion: 1 as const,
        vue: '@litijs/blog/vue',
        models: models as unknown as { [Name in keyof Models]: BlogModel<Models[Name]> },
        requires: { actions },
    }
}
