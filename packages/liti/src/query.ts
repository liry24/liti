import type {
    LitiClientRegistry,
    LitiEntry,
    LitiFormModels,
    LitiManagementModels,
    LitiPublicModels,
    LitiPublicSummaryModels,
} from './client'
import { LitiClientError } from './client'
import type {
    LitiConfig,
    InferLitiModels,
    InferLitiFormModels,
    InferLitiPublicModels,
    InferLitiModelExtensions,
} from './config'
import type { ActionResult, PluginActions } from './plugins'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/** A generated module supplies these maps without importing server configuration at runtime. */
export interface LitiSchema {
    publicModels: Record<string, unknown>
    publicSummaryModels: Record<string, unknown>
    managementModels: Record<string, unknown>
    formModels: Record<string, unknown>
    actions: Record<string, { input: unknown; output: unknown; metadata?: unknown }>
}
export type ActionMetadata<Action> = Action extends { metadata: infer Metadata } ? Metadata : unknown

export type InferLitiActions<Config> = {
    [Name in keyof PluginActions<Config>]: PluginActions<Config>[Name] extends {
        input: StandardSchemaV1<infer Input, unknown>
        output: StandardSchemaV1<unknown, infer Output>
        execute: (
            ...args: never[]
        ) => ActionResult<unknown, infer Metadata> | Promise<ActionResult<unknown, infer Metadata>>
    }
        ? { input: Input; output: Output; metadata: Metadata }
        : never
}

export type InferLitiSchema<Config extends LitiConfig> = {
    publicModels: InferLitiPublicModels<Config>
    publicSummaryModels: InferLitiPublicModels<Config, 'summary'>
    managementModels: InferLitiModels<Config>
    formModels: InferLitiFormModels<Config>
    actions: InferLitiActions<Config>
    modelExtensions: InferLitiModelExtensions<Config>
}

export interface RegisteredLitiSchema extends LitiSchema {
    publicModels: LitiPublicModels
    publicSummaryModels: LitiPublicSummaryModels
    managementModels: LitiManagementModels
    formModels: LitiFormModels
    actions: LitiClientRegistry extends { actions: infer Actions extends LitiSchema['actions'] } ? Actions : {}
}

export interface QueryPage {
    limit: number
    offset: number
}

type Selector = { id: string | null | undefined; path?: never } | { path: string | null | undefined; id?: never }

type PublishedQuery =
    | { mode?: 'many'; view?: 'published'; id?: never; path?: never; page?: QueryPage; pageSize?: number }
    | ({ mode: 'one'; view?: 'published'; page?: never; pageSize?: never } & Selector)
type CurrentQuery =
    | { mode?: 'many'; view: 'current'; id?: never; path?: never; page?: QueryPage; pageSize?: number; q?: string }
    | {
          mode: 'one'
          view: 'current'
          id: string | null | undefined
          path?: never
          page?: never
          pageSize?: never
          q?: never
      }

export type LitiQueryOptions = (PublishedQuery | CurrentQuery) & {
    locale?: string
    markdown?: 'full' | 'summary'
    signal?: AbortSignal
}

export type LitiQueryPageOptions = Extract<LitiQueryOptions, { mode?: 'many' }> &
    ({ page: QueryPage } | { pageSize: number })

export type LitiQueryPage<Schema extends LitiSchema, Name extends string, Options> = QueryPage & {
    items: LitiQueryItem<Schema, Name, Options>[]
    total: number
}

export type LitiQuerySelection<
    Mode extends 'many' | 'one',
    View extends 'published' | 'current',
    Markdown extends 'full' | 'summary',
> = {
    locale?: string
    markdown?: Markdown
    signal?: AbortSignal
} & (View extends 'current' ? { view: View } : { view?: View }) &
    (Mode extends 'one'
        ? { mode: Mode; page?: never; pageSize?: never; q?: never } & (View extends 'current'
              ? { id: string | null | undefined; path?: never }
              : Selector)
        : { mode?: Mode; id?: never; path?: never; page?: QueryPage; pageSize?: number } & (View extends 'current'
              ? { q?: string }
              : { q?: never }))

export type LitiQueryModel<Schema extends LitiSchema, Options> = Extract<
    keyof (Options extends { view: 'current' } ? Schema['managementModels'] : Schema['publicModels']),
    string
>

export type LitiQueryItem<Schema extends LitiSchema, Name extends string, Options> = Options extends { view: 'current' }
    ? Name extends keyof Schema['formModels']
        ? LitiEntry<Schema['formModels'][Name]>
        : never
    : Options extends { markdown: 'summary' }
      ? Name extends keyof Schema['publicSummaryModels']
          ? Schema['publicSummaryModels'][Name]
          : never
      : Name extends keyof Schema['publicModels']
        ? Schema['publicModels'][Name]
        : never

export type LitiQueryResult<Schema extends LitiSchema, Name extends string, Options> = Options extends { mode: 'one' }
    ? LitiQueryItem<Schema, Name, Options> | null
    : LitiQueryItem<Schema, Name, Options>[]

/** Validate JavaScript callers too; a missing reactive selector never becomes a list request. */
export const normalizeLitiQuery = (options: LitiQueryOptions = {}) => {
    const mode = options.mode ?? 'many'
    const view = options.view ?? 'published'
    const id = Object.hasOwn(options, 'id')
    const path = Object.hasOwn(options, 'path')
    const invalid = (message: string): never => {
        throw new LitiClientError('LITI_INVALID_INPUT', message, 400)
    }
    if (mode !== 'one' && mode !== 'many') invalid('Query mode must be one or many.')
    if (view !== 'published' && view !== 'current') invalid('Query view must be published or current.')
    if (mode === 'one' && id === path) invalid('A one query requires exactly one of id or path.')
    if (mode === 'many' && (id || path)) invalid('A many query cannot select an id or path.')
    if (mode === 'one' && (options.page !== undefined || options.pageSize !== undefined))
        invalid('A one query cannot specify a page.')
    if (view === 'current' && path) invalid('A current query selects an entry by id.')
    const selector = id ? options.id : options.path
    if (selector != null && typeof selector !== 'string') invalid('A query selector must be a string.')
    if (options.locale !== undefined && typeof options.locale !== 'string') invalid('Query locale must be a string.')
    if (
        'q' in options &&
        options.q !== undefined &&
        (view !== 'current' || mode !== 'many' || typeof options.q !== 'string')
    )
        invalid('Query search requires a current many query and a string.')
    if (
        options.pageSize !== undefined &&
        (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    )
        invalid('Query pageSize must be an integer from 1 to 100.')
    if (options.page && options.pageSize !== undefined && options.page.limit !== options.pageSize)
        invalid('Query page.limit and pageSize must agree.')
    if (
        options.page &&
        (!Number.isSafeInteger(options.page.limit) ||
            options.page.limit < 1 ||
            options.page.limit > 100 ||
            !Number.isSafeInteger(options.page.offset) ||
            options.page.offset < 0)
    )
        invalid('Query page requires a limit from 1 to 100 and a non-negative integer offset.')
    if (options.markdown !== undefined && options.markdown !== 'full' && options.markdown !== 'summary')
        invalid('Query markdown must be full or summary.')
    return {
        mode,
        view,
        markdown: options.markdown ?? 'full',
        waiting: mode === 'one' && !selector,
        ...(id ? { id: options.id ?? null } : {}),
        ...(path ? { path: options.path ?? null } : {}),
        ...(options.locale === undefined ? {} : { locale: options.locale }),
        ...('q' in options && options.q !== undefined ? { q: options.q } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.page
            ? { page: options.page }
            : options.pageSize === undefined
              ? {}
              : { page: { limit: options.pageSize, offset: 0 } }),
    }
}
