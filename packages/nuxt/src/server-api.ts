import type { RegisteredLitiSchema, ActionMetadata } from '../../liti/src/query'
import type { ActionResult } from '../../liti/src/plugins'
type Actions = RegisteredLitiSchema['actions']
import type { RequestEvent } from 'nuxt/server'
import { litiModels, type createAdminClient } from '../../liti/src/admin-client'
import type {
    LitiFormModels,
    LitiPublicModels,
    LitiPublicSummaryModels,
    PublicPage,
    PublicListOptions,
    PublicMarkdownListOptions,
} from '../../liti/src/client'
import { serializeAdminInput } from '../../liti/src/entry-preparation'
import { presentAdminValue, litiAsset } from '../../liti/src/management-assets'
import type { LitiEntryMutation, LitiEntry, LitiManagementClient } from '../../liti/src/client'
import { LitiError } from '../../liti/src/errors'
import { createManagementOperations } from '../../liti/src/server/operations'
import { projectMarkdownListSummary } from '../../liti/src/markdown/list-summary'
import { useLitiRuntime } from './nuxt/server'
import { withLitiContext } from './runtime/context'
export { getNitroRequest } from './runtime/nitro2'

export interface ServerContent {
    get<Name extends Extract<keyof LitiPublicModels, string>>(
        model: Name,
        id: string,
        options?: PublicListOptions,
    ): Promise<LitiPublicModels[Name] | null>
    list<Name extends Extract<keyof LitiPublicModels, string>>(
        model: Name,
        options: PublicMarkdownListOptions & { markdown: 'summary' },
    ): Promise<LitiPublicSummaryModels[Name][]>
    list<Name extends Extract<keyof LitiPublicModels, string>>(
        model: Name,
        options?: PublicMarkdownListOptions & { markdown?: 'full' },
    ): Promise<LitiPublicModels[Name][]>
    page<Name extends Extract<keyof LitiPublicModels, string>>(
        model: Name,
        page: { limit: number; offset: number },
        options: PublicMarkdownListOptions & { markdown: 'summary' },
    ): Promise<PublicPage<LitiPublicSummaryModels[Name]>>
    page<Name extends Extract<keyof LitiPublicModels, string>>(
        model: Name,
        page: { limit: number; offset: number },
        options?: PublicMarkdownListOptions & { markdown?: 'full' },
    ): Promise<PublicPage<LitiPublicModels[Name]>>
    resolve(
        path: string,
        options?: PublicListOptions,
    ): ReturnType<import('../../liti/src/server/liti').Liti['resolvePath']>
}
export type ServerAdmin = ReturnType<typeof createAdminClient<LitiFormModels>> & {
    content: ServerContent
    tasks: {
        publishDue(now?: Date): Promise<import('../../liti/src/server/types').PublishDueResult>
        collectAssets(): Promise<import('../../liti/src/client').LitiAssetGCResult>
        syncAssets(): Promise<import('../../liti/src/server/types').AssetSyncResult>
        rebuildSearch(): Promise<{ indexed: number }>
    }
}

/** Capture the event now; resolve database bindings only when an operation needs them. */
export const useAdmin = (event?: RequestEvent, platformContext?: object): ServerAdmin => {
    const runtime = useLitiRuntime()
    const instance = () => runtime.getLiti(event, platformContext)
    const raw = createManagementOperations<RequestEvent, LitiFormModels>(
        instance,
        event?.req,
        event,
        runtime.managementBase,
    )
    const clients = new Map<string, LitiManagementClient<LitiFormModels>>()
    const forModel = (model: string) => {
        if (!clients.has(model))
            clients.set(
                model,
                createManagementOperations<RequestEvent, LitiFormModels>(
                    instance,
                    event?.req,
                    event,
                    runtime.managementBase,
                    model,
                ),
            )
        return clients.get(model)!
    }
    type ModelName = Extract<keyof LitiFormModels, string>
    const descriptor = async (model: string) => {
        const definition = (await instance()).descriptor.models[model]
        if (!definition) throw new LitiError('LITI_MODEL_NOT_FOUND', 'Unknown model.')
        return definition
    }
    const encode = async <
        Input extends { data?: Record<string, unknown>; translations?: import('../../liti/src/i18n').TranslationInput },
    >(
        model: string,
        input: Input,
    ) => serializeAdminInput(await descriptor(model), input)
    const present = async <Value extends LitiEntryMutation>(model: string, value: Value): Promise<Value> => {
        if (!('data' in value)) return value
        return presentAdminValue(await descriptor(model), value, raw.assetUrl)
    }
    const publicValue = (document: { data: Record<string, unknown> } | null) => {
        if (!document) return null
        const { _liti, ...data } = document.data
        return { ...Object(_liti), data }
    }
    const task = async (kind: 'publishDue' | 'collectAssets' | 'syncAssets' | 'rebuildSearch', now?: Date) => {
        const admin = await instance()
        const actor = event
            ? await admin.authorizeRequest(event.req, event)
            : { id: `liti:task:${kind}`, roles: ['admin'] }
        if (event) {
            if (kind === 'publishDue') admin.assertPermission(actor, 'system', 'publishDue')
            else if (kind === 'rebuildSearch') admin.assertPermission(actor, 'system', 'rebuildSearch')
            else admin.assertPermission(actor, 'asset', 'gc')
        }
        if (kind === 'publishDue')
            return admin.publishDue(now, {
                actor,
                ...(event ? { request: event.req, signal: event.req.signal } : {}),
                ...(platformContext ? { platformContext } : {}),
            })
        if (kind === 'collectAssets') return admin.runAssetGC()
        if (kind === 'rebuildSearch') return admin.rebuildSearch()
        return admin.syncAssetCopies()
    }
    const api = {
        models: async () => litiModels(await raw.models()),
        entries: {
            list: async <Model extends ModelName>(
                model: Model,
                options?: import('../../liti/src/client').ManagementListOptions,
            ) => {
                const page = await forModel(model).listEntries(model, options)
                const definition = await descriptor(model)
                return {
                    ...page,
                    items: page.items.map((entry) => presentAdminValue(definition, entry, raw.assetUrl)),
                }
            },
            get: async <Model extends ModelName>(model: Model, id: string) =>
                present(model, await forModel(model).getEntry<LitiFormModels[Model]>(id)),
            create: async <Model extends ModelName>(
                model: Model,
                input: import('../../liti/src/client').LitiCreateEntryInput<LitiFormModels[Model]>,
            ) => present(model, await forModel(model).createEntry(model, await encode(model, input))),
            update: async <Model extends ModelName>(
                model: Model,
                selected: { id: string; version: number },
                input: {
                    data?: Partial<LitiFormModels[Model]>
                    translations?: import('../../liti/src/i18n').TranslationInput<LitiFormModels[Model]>
                },
            ) =>
                present(
                    model,
                    await forModel(model).updateEntry<LitiFormModels[Model]>(selected.id, {
                        ...(await encode(model, input)),
                        expectedVersion: selected.version,
                    }),
                ),
            publish: async <Model extends ModelName>(
                model: Model,
                selected: { id: string; version: number },
                input?: {
                    data?: Partial<LitiFormModels[Model]>
                    translations?: import('../../liti/src/i18n').TranslationInput<LitiFormModels[Model]>
                },
            ) =>
                present(
                    model,
                    await forModel(model).publishEntry<LitiFormModels[Model]>(selected.id, {
                        expectedVersion: selected.version,
                        ...(input && Object.keys(input).length ? { draft: await encode(model, input) } : {}),
                    }),
                ),
            schedule: async <Model extends ModelName>(
                model: Model,
                selected: { id: string; version: number },
                input: {
                    data?: Partial<LitiFormModels[Model]>
                    translations?: import('../../liti/src/i18n').TranslationInput<LitiFormModels[Model]>
                    at: Date | string
                },
            ) => {
                const at = new Date(input.at)
                if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())
                    throw new LitiError('LITI_INVALID_INPUT', 'Choose a future publication time.')
                const { at: _at, ...candidate } = input
                return present(
                    model,
                    await forModel(model).schedulePublish<LitiFormModels[Model]>(selected.id, {
                        expectedVersion: selected.version,
                        at: at.toISOString(),
                        ...(Object.keys(candidate).length ? { draft: await encode(model, candidate) } : {}),
                    }),
                )
            },
            remove: <Model extends ModelName>(model: Model, selected: { id: string; version: number }) =>
                forModel(model).deleteEntry(selected.id, { expectedVersion: selected.version }),
            unpublish: async <Model extends ModelName>(model: Model, selected: { id: string; version: number }) =>
                present(
                    model,
                    await forModel(model).unpublishEntry<LitiFormModels[Model]>(selected.id, {
                        expectedVersion: selected.version,
                    }),
                ),
            cancelSchedule: async <Model extends ModelName>(model: Model, selected: { id: string; version: number }) =>
                present(
                    model,
                    await forModel(model).cancelScheduledPublish<LitiFormModels[Model]>(selected.id, {
                        expectedVersion: selected.version,
                    }),
                ),
            reorder: <Model extends ModelName>(model: Model, entries: LitiEntry<LitiFormModels[Model]>[]) =>
                forModel(model).setSortOrders(
                    model,
                    entries.map((entry, sortOrder) => ({ id: entry.id, expectedVersion: entry.version, sortOrder })),
                ),
            references: <Model extends ModelName>(
                model: Model,
                id: string,
                options: import('../../liti/src/client').LitiReferencesOptions,
            ) => forModel(model).referencesTo(id, options),
        },
        revisions: {
            list: async <Model extends ModelName>(model: Model, id: string) => {
                const revisions = await forModel(model).listRevisions<LitiFormModels[Model]>(id)
                const definition = await descriptor(model)
                return revisions.map((revision) => presentAdminValue(definition, revision, raw.assetUrl))
            },
            restore: async <Model extends ModelName>(
                model: Model,
                selected: { id: string; version: number },
                revisionId: string,
            ) =>
                present(
                    model,
                    await forModel(model).restoreRevision<LitiFormModels[Model]>(selected.id, revisionId, {
                        expectedVersion: selected.version,
                    }),
                ),
        },
        assets: {
            upload: async (file: File) => litiAsset(await raw.uploadAsset(file), raw.assetUrl),
            get: async (id: string) => litiAsset(await raw.getAsset(id), raw.assetUrl),
            download: (id: string) => raw.downloadAsset(id),
            remove: (id: string) => raw.deleteAsset(id),
        },
        actions: {
            run: async <Name extends Extract<keyof Actions, string>>(
                name: Name,
                input: Actions[Name]['input'],
            ): Promise<ActionResult<Actions[Name]['output'], ActionMetadata<Actions[Name]>>> => {
                if (!event) throw new LitiError('LITI_AUTH_REQUIRED', 'AI actions require a request event.')
                if (!runtime.executeAction) throw new LitiError('LITI_AI_UNAVAILABLE', 'AI actions are unavailable.')
                return (await runtime.executeAction(event, name, input)) as ActionResult<
                    Actions[Name]['output'],
                    ActionMetadata<Actions[Name]>
                >
            },
        },
        content: {
            get: async <Name extends Extract<keyof LitiPublicModels, string>>(
                model: Name,
                id: string,
                options: { locale?: string } = {},
            ) =>
                publicValue(await (await instance()).contentDocument(model, id, options?.locale)) as
                    | LitiPublicModels[Name]
                    | null,
            list: async <Name extends Extract<keyof LitiPublicModels, string>>(
                model: Name,
                options?: PublicMarkdownListOptions,
            ) => {
                const admin = await instance()
                const documents = await admin.contentList(model, options?.locale)
                const items =
                    options?.markdown === 'summary'
                        ? await projectMarkdownListSummary(
                              documents,
                              model,
                              admin.config,
                              (id) => runtime.publicBase + '/_assets/' + encodeURIComponent(id),
                          )
                        : documents
                return items.map(publicValue) as LitiPublicModels[Name][]
            },
            page: async <Name extends Extract<keyof LitiPublicModels, string>>(
                model: Name,
                page: { limit: number; offset: number },
                options?: PublicMarkdownListOptions,
            ) => {
                const admin = await instance()
                const result = await admin.contentPage(model, page, options?.locale)
                const documents =
                    options?.markdown === 'summary'
                        ? await projectMarkdownListSummary(
                              result.items,
                              model,
                              admin.config,
                              (id) => runtime.publicBase + '/_assets/' + encodeURIComponent(id),
                          )
                        : result.items
                return { ...result, items: documents.map(publicValue) as LitiPublicModels[Name][] }
            },
            resolve: async (path: string, options: { locale?: string } = {}) =>
                (await instance()).resolvePath(path, options?.locale),
        } as ServerContent,
        tasks: {
            publishDue: async (now?: Date) =>
                (await task('publishDue', now)) as import('../../liti/src/server/types').PublishDueResult,
            collectAssets: async () =>
                (await task('collectAssets')) as import('../../liti/src/client').LitiAssetGCResult,
            syncAssets: async () => (await task('syncAssets')) as import('../../liti/src/server/types').AssetSyncResult,
            rebuildSearch: async () => (await task('rebuildSearch')) as { indexed: number },
        },
    }
    for (const [namespace, group] of Object.entries(api)) {
        if (typeof group === 'function') {
            Object.assign(api, { [namespace]: () => withLitiContext(platformContext ?? event?.context, group) })
            continue
        }
        for (const [name, method] of Object.entries(group)) {
            Object.assign(group, {
                [name]: (...args: unknown[]) =>
                    withLitiContext(platformContext ?? event?.context, () => Reflect.apply(method, group, args)),
            })
        }
    }
    return api
}
