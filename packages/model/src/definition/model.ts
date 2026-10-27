import type { StandardSchemaV1, StandardJSONSchemaV1 } from '@standard-schema/spec'
import { ModelError } from './errors'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type FieldSchema = StandardSchemaV1 & StandardJSONSchemaV1
export interface FieldOptions {
    label?: string
    description?: string
    localized?: boolean
    input?: 'text' | 'textarea' | 'number' | 'checkbox' | 'date' | 'image' | 'relation' | 'json'
    reference?: string
    public?: boolean
}
/** Field validators must be pure and idempotent on their canonical JSON output. */
export interface ModelField<S extends FieldSchema = FieldSchema> extends FieldOptions {
    schema: S
}
export type Fields = Record<string, ModelField>
type OptionalFieldKeys<F extends Fields> = {
    [K in keyof F]: undefined extends StandardSchemaV1.InferOutput<F[K]['schema']> ? K : never
}[keyof F]
export type InferData<F extends Fields> = {
    [K in Exclude<keyof F, OptionalFieldKeys<F>>]: StandardSchemaV1.InferOutput<F[K]['schema']>
} & { [K in OptionalFieldKeys<F>]?: StandardSchemaV1.InferOutput<F[K]['schema']> }
export type InferPublicData<F extends Fields> = Omit<
    InferData<F>,
    { [K in keyof F]: F[K] extends { public: false } ? K : never }[keyof F]
>
type OptionalInputKeys<F extends Fields> = {
    [K in keyof F]: undefined extends StandardSchemaV1.InferInput<F[K]['schema']> ? K : never
}[keyof F]
export type InferInput<F extends Fields> = {
    [K in Exclude<keyof F, OptionalInputKeys<F>>]: StandardSchemaV1.InferInput<F[K]['schema']>
} & { [K in OptionalInputKeys<F>]?: StandardSchemaV1.InferInput<F[K]['schema']> }
export type ModelData<M extends { fields: Fields }> = string extends keyof M['fields']
    ? Record<string, unknown>
    : InferData<M['fields']>
export type ModelInput<M extends { fields: Fields }> = string extends keyof M['fields']
    ? Record<string, unknown>
    : InferInput<M['fields']>
export type ModelPublicData<M extends { fields: Fields }> = string extends keyof M['fields']
    ? Record<string, unknown>
    : InferPublicData<M['fields']>
export const field = <S extends FieldSchema, const O extends FieldOptions = {}>(
    schema: S,
    options?: O,
): Readonly<{ schema: S } & O> => Object.freeze({ schema, ...options }) as Readonly<{ schema: S } & O>
export type ModelAction =
    | 'readDraft'
    | 'save'
    | 'remove'
    | 'restore'
    | 'publish'
    | 'schedule'
    | 'reorder'
    | `${string}:${string}`
export interface Actor {
    id: string
    [key: string]: unknown
}
export interface AuthorizationContext {
    actor: Actor
    action: ModelAction
    model: string
    id?: string
    locale?: string
    signal?: AbortSignal
}
export interface ReferenceDefinition {
    path: string
    model: string
    optional?: boolean
}
export interface ModelValidationContext {
    action: ModelAction
    id: string
    locale: string
    actor: Actor
    body?: string
    revision?: string
    signal?: AbortSignal
    previous: Record<string, unknown> | null
}
export interface ModelSaveInput {
    data: Record<string, unknown>
    /** Null clears a translated body override; omission retains its current presence. */
    body?: string | null
    order?: number
}
export interface ModelOptions<F extends Fields = Fields> {
    name: string
    label?: string
    fields: F
    title?: keyof F & string
    references?: readonly ReferenceDefinition[]
    authorize(context: AuthorizationContext): boolean | Promise<boolean>
    prepare?(input: ModelSaveInput, context: ModelValidationContext): ModelSaveInput | Promise<ModelSaveInput>
    validate?(data: InferData<F>, context: ModelValidationContext): void | Promise<void>
}
export interface ContentModelOptions<F extends Fields = Fields> extends ModelOptions<F> {
    locales?: { default: string; supported: readonly string[] }
    format?: 'markdown' | 'json'
    url?(entry: { id: string; locale: string; data: InferPublicData<F> }): string | null
}
export interface RecordModelOptions<F extends Fields = Fields> extends ModelOptions<F> {
    unique?: readonly (readonly (keyof F & string)[])[]
}
export type ContentModel<F extends Fields = Fields> = Readonly<ContentModelOptions<F> & { storage: 'content' }>
export type RecordModel<F extends Fields = Fields> = Readonly<RecordModelOptions<F> & { storage: 'records' }>
export type Model = ContentModel | RecordModel

function checkModel(options: ModelOptions) {
    if (!/^[a-z][a-zA-Z0-9]*$/u.test(options.name))
        throw new ModelError('LITI_INVALID_MODEL', 'Model names must be identifiers beginning with a lowercase letter.')
    for (const key of Object.keys(options.fields)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(key) || ['body', 'id', 'version', 'createdAt', 'updatedAt'].includes(key))
            throw new ModelError('LITI_INVALID_MODEL', `Reserved or invalid model field: ${key}`)
    }
    if (!Object.keys(options.fields).length) throw new ModelError('LITI_INVALID_MODEL', 'A model needs fields.')
    if (options.title && !(options.title in options.fields))
        throw new ModelError('LITI_INVALID_MODEL', 'Unknown title field.')
    if (typeof options.authorize !== 'function')
        throw new ModelError('LITI_INVALID_MODEL', 'Models require an explicit authorization policy.')
}
export function defineContentModel<const F extends Fields, const N extends string>(
    options: Omit<ContentModelOptions<F>, 'name'> & { name: N },
): ContentModel<F> & { readonly name: N } {
    checkModel(options)
    if (options.locales) {
        const { supported, default: defaultLocale } = options.locales
        if (
            !supported.includes(defaultLocale) ||
            new Set(supported).size !== supported.length ||
            supported.some((locale) => !/^[a-zA-Z0-9-]{1,35}$/u.test(locale))
        )
            throw new ModelError('LITI_INVALID_MODEL', 'Invalid model locales.')
    } else if (Object.values(options.fields).some((value) => value.localized))
        throw new ModelError('LITI_INVALID_MODEL', 'Localized fields require model locales.')
    return Object.freeze({ ...options, storage: 'content' as const })
}
export function defineRecordModel<const F extends Fields, const N extends string>(
    options: Omit<RecordModelOptions<F>, 'name'> & { name: N },
): RecordModel<F> & { readonly name: N } {
    checkModel(options)
    if (Object.values(options.fields).some((value) => value.localized))
        throw new ModelError('LITI_INVALID_MODEL', 'Translated entries belong in Content.')
    for (const tuple of options.unique ?? [])
        if (!tuple.length || tuple.some((key) => !options.fields[key]))
            throw new ModelError('LITI_INVALID_MODEL', 'Invalid unique tuple.')
    return Object.freeze({ ...options, storage: 'records' as const })
}
export function describeModel(model: Model, audience: 'public' | 'management' = 'public') {
    return {
        name: model.name,
        label: model.label ?? model.name,
        storage: model.storage,
        title: model.title,
        fields: Object.fromEntries(
            Object.entries(model.fields)
                .filter(([, definition]) => audience === 'management' || definition.public !== false)
                .map(([key, { schema, ...options }]) => [
                    key,
                    {
                        ...options,
                        schema: schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
                    },
                ]),
        ),
        locales: model.storage === 'content' ? model.locales : undefined,
    }
}
