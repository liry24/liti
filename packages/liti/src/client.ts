import type { LitiDescriptor } from './descriptor'
import type { LitiIssue } from './errors'
import type { ActionResult } from './plugins'
import type { LitiSchema, ActionMetadata } from './query'
import type {
    AssetRecord,
    EntryInput,
    EntryMutationReceipt,
    EntryPage,
    EntryRecord,
    IncomingReference,
    PublicEntry,
    PublishEntryInput,
    PublishDueResult,
    RevisionRecord,
    LitiInspection,
    UpdateEntryInput,
} from './server/types'
export type { PublicEntry, PublicEntrySeo, PublicEntrySeoImage, PublicEntrySeoValue } from './server/types'
export type { PublicAsset } from './fields'
export type { InferPublicModelData, InferLitiModels, InferLitiPublicModels } from './config'

import type { LitiClientRegistry } from './public-client'
export type { LitiClientRegistry } from './public-client'
type ModelMetas = LitiClientRegistry extends { modelMeta: infer Meta }
    ? Meta
    : Record<string, import('./presentation').ModelMeta>
export type LitiModelMeta<Name extends string = string> = Name extends keyof ModelMetas
    ? ModelMetas[Name]
    : ModelMetas[keyof ModelMetas]

export type LitiPublicModels = LitiClientRegistry extends { publicModels: infer Models }
    ? Models
    : Record<string, PublicEntry>
export type LitiPublicSummaryModels = LitiClientRegistry extends { publicSummaryModels: infer Models }
    ? Models
    : Record<string, PublicEntry>
export type LitiManagementModels = LitiClientRegistry extends { managementModels: infer Models }
    ? Models
    : Record<string, Record<string, unknown>>
export type LitiFormModels = LitiClientRegistry extends { formModels: infer Models } ? Models : LitiManagementModels
export { presentLitiData, serializeLitiData, litiAsset } from './management-assets'
export type { LitiAsset } from './management-assets'

type ModelName<Models> = Extract<keyof Models, string>
type ManagementData<Models> = Models[keyof Models]
export type LitiEntry<Data = Record<string, unknown>> = Omit<EntryRecord, 'data'> & { data: Data }
export type LitiRevision<Data = Record<string, unknown>> = Omit<RevisionRecord, 'data'> & { data: Data }
export type LitiEntryMutation<Data = Record<string, unknown>> = LitiEntry<Data> | EntryMutationReceipt
export type LitiEntryPage<Data = Record<string, unknown>> = Omit<EntryPage, 'items'> & {
    items: LitiEntry<Data>[]
}
export type LitiCreateEntryInput<Data = Record<string, unknown>> = Omit<
    EntryInput,
    'actorId' | 'data' | 'translations'
> & {
    data: Data
    translations?: import('./i18n').TranslationInput<Data>
}
export type LitiUpdateEntryInput<Data = Record<string, unknown>> = Omit<UpdateEntryInput, 'actorId' | 'data'> & {
    data?: Partial<Data>
}
/** Authenticated asset presentation stays inside the management adapter. */
export const managementAssetUrl = (id: string, base = '/api/liti'): string =>
    `${base.replace(/\/$/u, '')}/assets/${encodeURIComponent(id)}/content`

export interface LitiClientOptions {
    basePath?: string
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    origin?: string
}

export interface LitiManagementClientOptions extends LitiClientOptions {
    credentials?: RequestCredentials
    /** Successful entry mutations only. Observer failures cannot turn a saved mutation into a failed request. */
    onMutation?: (mutation: LitiMutation) => Promise<void> | void
}

export interface LitiMutation {
    id: string
    model?: string
}

export interface LitiRequestOptions {
    signal?: AbortSignal
}

export interface PublicPage<Data> {
    items: Data[]
    total: number
    limit: number
    offset: number
}

export interface PublicListOptions {
    locale?: string
    signal?: AbortSignal
}

export interface PublicMarkdownListOptions extends PublicListOptions {
    markdown?: 'full' | 'summary'
}

export interface PublicRouteResult {
    path?: string
    origin?: string
    entry?: Record<string, unknown>
    kind: 'page' | 'redirect'
    status?: number
    target?: string
}

export interface ManagementListOptions {
    limit?: number
    locale?: string
    offset?: number
    q?: string
    signal?: AbortSignal
}

export interface LitiVersionInput {
    expectedVersion: number
}

export type LitiPublishInput<Data = Record<string, unknown>> = LitiVersionInput &
    (PublishEntryInput<Data> extends infer Input ? (Input extends object ? Omit<Input, 'actorId'> : never) : never)

export type LitiScheduleInput<Data = Record<string, unknown>> = LitiPublishInput<Data> & { at: string }

export interface LitiSortInput extends LitiVersionInput {
    id: string
    sortOrder: number | null
}

export interface LitiReferencesOptions {
    field?: string
    from?: string
    view: 'current' | 'published'
}

export interface LitiAssetUploadOptions extends LitiRequestOptions {
    contentType?: string
    filename: string
}

export interface LitiRouteRecord {
    entryId: string
    kind: 'historical' | 'page' | 'redirect'
    locale: string
    path: string
    status: number | null
    targetPath: string | null
}

export interface LitiAssetGCResult {
    deleted: string[]
    failed: Array<{ id: string; message: string }>
}

export class LitiClientError extends Error {
    readonly code: string
    readonly issues?: LitiIssue[]
    readonly status: number
    committed?: boolean
    receipt?: { id: string; model: string; version: number; deleted?: boolean }
    effects?: { assets: 'pending' }

    constructor(code: string, message: string, status: number, issues?: LitiIssue[]) {
        super(message)
        this.name = 'LitiClientError'
        this.code = code
        this.status = status
        if (issues !== undefined) this.issues = issues
    }
}

const normalizeBase = (origin: string, basePath: string): string =>
    `${origin.replace(/\/$/u, '')}/${basePath.split('/').filter(Boolean).join('/')}`

const responseError = async (response: Response): Promise<LitiClientError> => {
    const payload = (await response.json().catch(() => null)) as {
        error?: {
            code?: string
            message?: string
            issues?: LitiIssue[]
            committed?: boolean
            receipt?: LitiClientError['receipt']
            effects?: LitiClientError['effects']
        }
    } | null
    const failure = payload?.error
    const error = new LitiClientError(
        failure?.code ?? 'LITI_REQUEST_FAILED',
        failure?.message ?? `Request failed with status ${response.status}.`,
        response.status,
        failure?.issues,
    )
    const receipt = failure?.receipt
    if (
        failure?.committed &&
        receipt &&
        typeof receipt.id === 'string' &&
        typeof receipt.model === 'string' &&
        Number.isSafeInteger(receipt.version) &&
        receipt.version > 0
    ) {
        error.committed = true
        error.receipt = {
            id: receipt.id,
            model: receipt.model,
            version: receipt.version,
            ...(receipt.deleted === true ? { deleted: true } : {}),
        }
        if (failure.effects?.assets === 'pending') error.effects = { assets: 'pending' }
    }
    return error
}

const transport = (options: LitiClientOptions, defaultBase: string, credentials?: RequestCredentials) => {
    const request = options.fetch ?? globalThis.fetch
    const base = normalizeBase(options.origin ?? '', options.basePath ?? defaultBase)
    const urlFor = (path: string, query?: Record<string, string | number | undefined>): string => {
        const url = new URL(`${base}${path}`, options.origin || globalThis.location?.origin || 'http://localhost')
        for (const [name, value] of Object.entries(query ?? {}))
            if (value !== undefined) url.searchParams.set(name, String(value))
        return options.origin ? url.href : `${url.pathname}${url.search}`
    }
    const response = async (
        path: string,
        init: RequestInit = {},
        query?: Record<string, string | number | undefined>,
        nullable = false,
    ): Promise<Response | null> => {
        init.signal?.throwIfAborted()
        const result = await request(urlFor(path, query), {
            ...(credentials === undefined ? {} : { credentials }),
            ...init,
        })
        init.signal?.throwIfAborted()
        if (nullable && result.status === 404) return null
        if (!result.ok) throw await responseError(result)
        return result
    }
    const json = async <Value>(
        path: string,
        init?: RequestInit,
        query?: Record<string, string | number | undefined>,
        nullable = false,
    ): Promise<Value | null> => {
        const result = await response(path, init, query, nullable)
        if (!result || result.status === 204) return null
        return (await result.json()) as Value
    }
    const mutate = <Value>(
        path: string,
        method: string,
        body: unknown,
        requestOptions: LitiRequestOptions = {},
    ): Promise<Value> =>
        json<Value>(path, {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
            method,
            ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
        }) as Promise<Value>
    return { base, json, mutate, response }
}

const entry = <Value>(document: { data: Record<string, unknown> } | null): Value | null => {
    if (!document) return null
    const { _liti, ...data } = document.data
    if (!_liti || typeof _liti !== 'object') {
        throw new LitiClientError('LITI_INVALID_RESPONSE', 'Public entry metadata is missing.', 502)
    }
    return { ..._liti, data } as Value
}

export interface LitiClient<Models = LitiPublicModels, SummaryModels = LitiPublicSummaryModels> {
    assetUrl(this: void, id: string): string
    get<Name extends ModelName<Models>>(
        this: void,
        model: Name,
        id: string,
        options?: PublicMarkdownListOptions,
    ): Promise<Models[Name] | null>
    get<Value>(
        this: void,
        model: ModelName<Models>,
        id: string,
        options?: PublicMarkdownListOptions,
    ): Promise<Value | null>
    list<Name extends ModelName<Models> & keyof SummaryModels>(
        this: void,
        model: Name,
        options: PublicMarkdownListOptions & { markdown: 'summary' },
    ): Promise<SummaryModels[Name][]>
    list<Name extends ModelName<Models>>(
        this: void,
        model: Name,
        options?: PublicListOptions & { markdown?: 'full' },
    ): Promise<Models[Name][]>
    list<Value>(this: void, model: ModelName<Models>, options?: PublicListOptions): Promise<Value[]>
    page<Name extends ModelName<Models> & keyof SummaryModels>(
        this: void,
        model: Name,
        page: { limit: number; offset: number },
        options: PublicMarkdownListOptions & { markdown: 'summary' },
    ): Promise<PublicPage<SummaryModels[Name]>>
    page<Name extends ModelName<Models>>(
        this: void,
        model: Name,
        page: { limit: number; offset: number },
        options?: PublicListOptions & { markdown?: 'full' },
    ): Promise<PublicPage<Models[Name]>>
    models(options?: LitiRequestOptions & { uiLocale?: string }): Promise<LitiDescriptor>
    resolveRoute(this: void, path: string, options?: PublicMarkdownListOptions): Promise<PublicRouteResult | null>
}

export const createPublicClient = <
    Models extends { [Name in keyof Models]: PublicEntry<unknown> } = LitiPublicModels,
    SummaryModels = LitiPublicSummaryModels,
>(
    options: LitiClientOptions = {},
): LitiClient<Models, SummaryModels> => {
    const { base, json } = transport(options, '/api/content')
    return {
        assetUrl: (id) => `${base}/_assets/${encodeURIComponent(id)}`,
        get: (model: ModelName<Models>, id: string, requestOptions: PublicMarkdownListOptions = {}) =>
            json<{ data: Record<string, unknown> }>(
                `/${encodeURIComponent(model)}/${encodeURIComponent(id)}`,
                { method: 'GET', ...(requestOptions.signal ? { signal: requestOptions.signal } : {}) },
                { locale: requestOptions.locale, markdown: requestOptions.markdown },
                true,
            ).then(entry),
        list: (model: ModelName<Models>, requestOptions?: PublicMarkdownListOptions) => {
            const listOptions = requestOptions ?? {}
            return json<Array<{ data: Record<string, unknown> }>>(
                `/${encodeURIComponent(model)}`,
                { method: 'GET', ...(listOptions.signal ? { signal: listOptions.signal } : {}) },
                {
                    locale: listOptions.locale,
                    ...(listOptions.markdown === 'summary' ? { markdown: 'summary' } : {}),
                },
            ).then((items) => (items ?? []).map((item) => entry(item)!))
        },
        page: (
            model: ModelName<Models>,
            page: { limit: number; offset: number },
            requestOptions?: PublicMarkdownListOptions,
        ) =>
            json<PublicPage<{ data: Record<string, unknown> }>>(
                '/' + encodeURIComponent(model),
                { method: 'GET', ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}) },
                { ...page, locale: requestOptions?.locale, markdown: requestOptions?.markdown },
            ).then((result) => ({ ...result!, items: result!.items.map((item) => entry(item)!) })),
        models: (requestOptions = {}) =>
            json<LitiDescriptor>('/models', {
                method: 'GET',
                ...(requestOptions.signal ? { signal: requestOptions.signal } : {}),
            }) as Promise<LitiDescriptor>,
        resolveRoute: (path, requestOptions = {}) =>
            json<PublicRouteResult>(
                '/_route',
                { method: 'GET', ...(requestOptions.signal ? { signal: requestOptions.signal } : {}) },
                { locale: requestOptions.locale, markdown: requestOptions.markdown, path },
                true,
            ),
    } as LitiClient<Models, SummaryModels>
}

export interface LitiManagementClient<
    Models = LitiManagementModels,
    Actions extends LitiSchema['actions'] = LitiSchema['actions'],
> {
    assetUrl(this: void, id: string): string
    models(options?: LitiRequestOptions & { uiLocale?: string }): Promise<LitiDescriptor>
    listEntries<Name extends ModelName<Models>>(
        this: void,
        model: Name,
        options?: ManagementListOptions,
    ): Promise<LitiEntryPage<Models[Name]>>
    listEntries(
        this: void,
        model?: undefined,
        options?: ManagementListOptions,
    ): Promise<LitiEntryPage<ManagementData<Models>>>
    listAllEntries<Name extends ModelName<Models>>(
        this: void,
        model: Name,
        options?: Omit<ManagementListOptions, 'offset'>,
    ): Promise<LitiEntry<Models[Name]>[]>
    listAllEntries(
        this: void,
        model?: undefined,
        options?: Omit<ManagementListOptions, 'offset'>,
    ): Promise<LitiEntry<ManagementData<Models>>[]>
    getEntry<Data extends ManagementData<Models> = ManagementData<Models>>(
        this: void,
        id: string,
        options?: LitiRequestOptions,
    ): Promise<LitiEntry<Data>>
    createEntry<Name extends ModelName<Models>>(
        model: Name,
        input: LitiCreateEntryInput<Models[Name]>,
        options?: LitiRequestOptions,
    ): Promise<LitiEntryMutation<Models[Name]>>
    updateEntry<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: LitiUpdateEntryInput<Data>,
        options?: LitiRequestOptions,
    ): Promise<LitiEntryMutation<Data>>
    deleteEntry(id: string, input: LitiVersionInput, options?: LitiRequestOptions): Promise<void>
    publishEntry<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: LitiPublishInput<Data>,
        options?: LitiRequestOptions,
    ): Promise<LitiEntryMutation<Data>>
    unpublishEntry<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: LitiVersionInput,
        options?: LitiRequestOptions,
    ): Promise<LitiEntryMutation<Data>>
    schedulePublish<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: LitiScheduleInput<Data>,
        options?: LitiRequestOptions,
    ): Promise<LitiEntryMutation<Data>>
    cancelScheduledPublish<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        input: LitiVersionInput,
        options?: LitiRequestOptions,
    ): Promise<LitiEntryMutation<Data>>
    setSortOrder(
        id: string,
        sortOrder: number | null,
        expectedVersion: number,
    ): Promise<LitiEntryMutation<ManagementData<Models>>>
    setSortOrders<Name extends ModelName<Models>>(
        model: Name,
        items: LitiSortInput[],
    ): Promise<LitiEntryMutation<Models[Name]>[]>
    listRevisions<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
    ): Promise<LitiRevision<Data>[]>
    restoreRevision<Data extends ManagementData<Models> = ManagementData<Models>>(
        id: string,
        revisionId: string,
        input: LitiVersionInput,
        options?: LitiRequestOptions,
    ): Promise<LitiEntryMutation<Data>>
    pruneRevisions(id: string, retain: number): Promise<{ deleted: string[] }>
    referencesTo(this: void, id: string, options: LitiReferencesOptions): Promise<IncomingReference[]>
    executeAction<Name extends Extract<keyof Actions, string>>(
        this: void,
        name: Name,
        input: Actions[Name]['input'],
        options?: LitiRequestOptions,
    ): Promise<ActionResult<Actions[Name]['output'], ActionMetadata<Actions[Name]>>>
    uploadAsset(file: File): Promise<AssetRecord>
    uploadAsset(body: Blob, options: LitiAssetUploadOptions): Promise<AssetRecord>
    getAsset(id: string): Promise<AssetRecord>
    downloadAsset(id: string): Promise<Response>
    deleteAsset(id: string): Promise<void>
    publishDue(): Promise<PublishDueResult>
    runAssetGC(): Promise<LitiAssetGCResult>
    inspect(): Promise<LitiInspection>
    routeSnapshot(): Promise<LitiRouteRecord[]>
}

/** Uses the existing authenticated, same-origin management HTTP API. */
export const createLitiManagementClient = <
    Models extends { [Name in keyof Models]: Record<string, unknown> } = LitiManagementModels,
    Actions extends LitiSchema['actions'] = LitiSchema['actions'],
>(
    options: LitiManagementClientOptions = {},
): LitiManagementClient<Models, Actions> => {
    const { base, json, mutate, response } = transport(options, '/api/liti', options.credentials ?? 'same-origin')
    const entryPath = (id: string): string => `/entries/${encodeURIComponent(id)}`
    const assetPath = (id: string): string => `/assets/${encodeURIComponent(id)}`
    const get = <Value>(
        path: string,
        query?: Record<string, string | number | undefined>,
        signal?: AbortSignal,
    ): Promise<Value> => json<Value>(path, { method: 'GET', ...(signal ? { signal } : {}) }, query) as Promise<Value>
    const notify = async (mutation: LitiMutation): Promise<void> => {
        try {
            await options.onMutation?.(mutation)
        } catch {
            /* A cache observer cannot undo a committed mutation. */
        }
    }
    const entriesPage = async <Value>(
        query: Record<string, string | number | undefined>,
        signal?: AbortSignal,
    ): Promise<Value> => {
        return get<Value>('/entries', query, signal)
    }

    const mutateEntry = async <Value extends LitiMutation | LitiMutation[]>(
        path: string,
        method: string,
        body: unknown,
        requestOptions?: LitiRequestOptions,
    ): Promise<Value> => {
        let result: Value
        try {
            result = await mutate<Value>(path, method, body, requestOptions)
        } catch (cause) {
            if (cause instanceof LitiClientError && cause.committed && cause.receipt) await notify(cause.receipt)
            throw cause
        }
        const mutations: LitiMutation[] = Array.isArray(result) ? result : [result as LitiMutation]
        await Promise.all(mutations.map(notify))
        return result
    }
    return {
        assetUrl: (id) => managementAssetUrl(id, base),
        models: (requestOptions = {}) => get('/models', { uiLocale: requestOptions.uiLocale }, requestOptions.signal),
        listEntries: (model: ModelName<Models> | undefined, requestOptions: ManagementListOptions = {}) => {
            const { signal, ...query } = requestOptions
            return entriesPage({ model, ...query }, signal)
        },
        listAllEntries: async (
            model: ModelName<Models> | undefined,
            requestOptions: Omit<ManagementListOptions, 'offset'> = {},
        ) => {
            const { signal, ...query } = requestOptions
            const items: LitiEntry<ManagementData<Models>>[] = []
            let total: number
            do {
                const page = await entriesPage<LitiEntryPage<ManagementData<Models>>>(
                    {
                        model,
                        ...query,
                        limit: requestOptions.limit ?? 100,
                        offset: items.length,
                    },
                    signal,
                )
                items.push(...page.items)
                total = page.total
                if (page.items.length === 0 && items.length < total) {
                    throw new LitiClientError('LITI_INVALID_RESPONSE', 'Entry list changed. Reload latest.', 502)
                }
            } while (items.length < total)
            return items
        },
        getEntry: (id, requestOptions = {}) => get(entryPath(id), undefined, requestOptions.signal),
        createEntry: (model, input, requestOptions) => mutateEntry(entryPath(model), 'POST', input, requestOptions),
        updateEntry: (id, input, requestOptions) => mutateEntry(entryPath(id), 'PATCH', input, requestOptions),
        deleteEntry: async (id, input, requestOptions) => {
            let result: Response | null
            try {
                result = await response(entryPath(id), {
                    ...requestOptions,
                    headers: { 'if-match': `"${input.expectedVersion}"` },
                    method: 'DELETE',
                })
            } catch (cause) {
                if (cause instanceof LitiClientError && cause.committed && cause.receipt) await notify(cause.receipt)
                throw cause
            }
            const model = result?.headers.get('x-liti-model')
            await notify({ id, ...(model ? { model } : {}) })
        },
        publishEntry: (id, input, requestOptions) =>
            mutateEntry(`${entryPath(id)}/publish`, 'POST', input, requestOptions),
        unpublishEntry: (id, input, requestOptions) =>
            mutateEntry(`${entryPath(id)}/unpublish`, 'POST', input, requestOptions),
        schedulePublish: (id, input, requestOptions) =>
            mutateEntry(`${entryPath(id)}/schedule`, 'POST', input, requestOptions),
        cancelScheduledPublish: (id, input, requestOptions) =>
            mutateEntry(`${entryPath(id)}/cancel-schedule`, 'POST', input, requestOptions),
        setSortOrder: (id, sortOrder, expectedVersion) =>
            mutateEntry(`${entryPath(id)}/sort`, 'PATCH', { expectedVersion, sortOrder }),
        setSortOrders: (model, items) => mutateEntry(`${entryPath(model)}/reorder`, 'POST', { items }),
        listRevisions: (id) => get(`${entryPath(id)}/revisions`),
        restoreRevision: (id, revisionId, input, requestOptions) =>
            mutateEntry(
                `${entryPath(id)}/revisions/${encodeURIComponent(revisionId)}/restore`,
                'POST',
                input,
                requestOptions,
            ),
        pruneRevisions: (id, retain) => mutate(`${entryPath(id)}/revisions/prune`, 'POST', { retain }),
        referencesTo: (id, requestOptions) => get(`${entryPath(id)}/references`, { ...requestOptions }),
        executeAction: (name, input, requestOptions) =>
            mutate('/actions/' + encodeURIComponent(name), 'POST', { input }, requestOptions),
        uploadAsset: async (body, uploadOptions) => {
            const filename = uploadOptions?.filename ?? ('name' in body ? String(body.name) : undefined)
            if (!filename) throw new TypeError('A filename is required to upload an asset.')
            const headers = new Headers({
                'x-filename': encodeURIComponent(filename),
                'x-upload-size': String(body.size),
            })
            const contentType = uploadOptions?.contentType ?? body.type
            if (contentType) headers.set('content-type', contentType)
            return (await json<AssetRecord>('/assets', {
                body,
                headers,
                method: 'POST',
                ...(uploadOptions?.signal ? { signal: uploadOptions.signal } : {}),
            }))!
        },
        getAsset: (id) => get(assetPath(id)),
        downloadAsset: (id) => response(`${assetPath(id)}/content`, { method: 'GET' }) as Promise<Response>,
        deleteAsset: async (id) => {
            await response(assetPath(id), { method: 'DELETE' })
        },
        publishDue: async () => {
            const result = await mutate<PublishDueResult>('/tasks/publish-due', 'POST', {})
            if (options.onMutation)
                await Promise.all(
                    result.published.map(async (id) => {
                        try {
                            await notify(await get<LitiEntry>(entryPath(id)))
                        } catch {
                            await notify({ id })
                        }
                    }),
                )
            return result
        },
        runAssetGC: () => mutate('/tasks/asset-gc', 'POST', {}),
        inspect: () => get('/diagnostics'),
        routeSnapshot: () => get('/routes'),
    } as LitiManagementClient<Models, Actions>
}
