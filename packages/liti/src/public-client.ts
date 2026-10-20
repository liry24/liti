import type { LitiEntry, LitiRevision, LitiFormModels, LitiPublicModels } from './client'
import {
    createPublicClient,
    createLitiManagementClient,
    LitiClientError,
    type LitiManagementClient,
    type LitiManagementClientOptions,
} from './client'
import { presentAdminValue } from './management-assets'
import { normalizeLitiQuery } from './query'
import type { LitiSchema, RegisteredLitiSchema, LitiQueryModel, LitiQueryOptions, LitiQueryResult } from './query'
export { LitiClientError } from './client'
export { normalizeLitiQuery } from './query'
export type { LitiSchema, RegisteredLitiSchema, LitiQueryModel, LitiQueryOptions, LitiQueryResult } from './query'
export type { LitiDescriptor, ModelDescriptor, FieldDescriptor } from './descriptor'

/** Generated declarations register model and action types through this public entry. */
export interface LitiClientRegistry {}

export interface LitiClientOptions extends Omit<LitiManagementClientOptions, 'basePath'> {
    baseURL?: string
    publicBaseURL?: string
}

export interface LitiClient<Schema extends LitiSchema = RegisteredLitiSchema> extends LitiManagementClient<
    Schema['managementModels']
> {
    query<
        const Options extends LitiQueryOptions = {},
        Name extends LitiQueryModel<Schema, Options> = LitiQueryModel<Schema, Options>,
    >(
        model: Name,
        options?: Options,
    ): Promise<LitiQueryResult<Schema, Name, Options>>
}

export const createLitiClient = <Schema extends LitiSchema = RegisteredLitiSchema>(
    options: LitiClientOptions = {},
): LitiClient<Schema> => {
    const base = (options.baseURL ?? '/api/liti').replace(/\/$/u, '')
    const management = createLitiManagementClient<Record<string, Record<string, unknown>>>({
        ...options,
        basePath: base,
    })
    const content = createPublicClient<
        Record<string, import('./client').PublicEntry>,
        Record<string, import('./client').PublicEntry>
    >({
        ...options,
        basePath: options.publicBaseURL ?? `${base}/content`,
    })
    const query = async (model: string, input: LitiQueryOptions = {}): Promise<unknown> => {
        const options = normalizeLitiQuery(input)
        options.signal?.throwIfAborted()
        if (options.waiting) return null
        const request = {
            ...(options.locale === undefined ? {} : { locale: options.locale }),
            ...(options.signal ? { signal: options.signal } : {}),
        }
        if (options.view === 'current') {
            const descriptor = (await management.models(request)).models[model]
            if (!descriptor) throw new LitiClientError('LITI_FORBIDDEN', 'Model is unavailable.', 403)
            const present = (entry: LitiEntry) => {
                if (entry.model !== model)
                    throw new LitiClientError(
                        'LITI_INVALID_RESPONSE',
                        'Entry does not belong to the requested model.',
                        502,
                    )
                return presentAdminValue(descriptor, entry, management.assetUrl)
            }
            if (options.mode === 'one') {
                try {
                    return present(await management.getEntry(options.id!, request))
                } catch (error) {
                    if (error instanceof LitiClientError && error.code === 'LITI_ENTRY_NOT_FOUND') return null
                    throw error
                }
            }
            const list = { ...request, ...('q' in options && options.q !== undefined ? { q: options.q } : {}) }
            return options.page
                ? (await management.listEntries(model, { ...list, ...options.page })).items.map(present)
                : (await management.listAllEntries(model, list)).map(present)
        }
        const projection = { ...request, ...(options.markdown ? { markdown: options.markdown } : {}) }
        if (options.mode === 'many') {
            if (options.page)
                return (
                    options.markdown === 'summary'
                        ? await content.page(model, options.page, { ...request, markdown: 'summary' })
                        : await content.page(model, options.page, request)
                ).items
            return options.markdown === 'summary'
                ? content.list(model, { ...request, markdown: 'summary' })
                : content.list(model, request)
        }
        if (options.path !== undefined) {
            const route = await content.resolveRoute(options.path!, projection)
            if (route?.entry?.model !== model) return null
            return route.entry
        }
        return content.get(model, options.id!, projection)
    }
    // The schema constrains names and DTO shapes; the transport receives the same checked options.
    return { ...management, query } as LitiClient<Schema>
}
export type Entry<Name extends string = string> = LitiEntry<
    Name extends keyof LitiFormModels ? LitiFormModels[Name] : Record<string, unknown>
>
export type Revision<Name extends string = string> = LitiRevision<
    Name extends keyof LitiFormModels ? LitiFormModels[Name] : Record<string, unknown>
>
export type Content<Name extends keyof LitiPublicModels = keyof LitiPublicModels> = LitiPublicModels[Name]
export type { LitiAsset as Asset } from './management-assets'
