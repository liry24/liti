import { createPublicClient, createLitiManagementClient, LitiClientError } from '../../../liti/src/client'
import type {
    LitiClient,
    LitiClientOptions,
    PublicPage,
    LitiManagementClient,
    LitiManagementClientOptions,
    PublicRouteResult,
} from '../../../liti/src/client'
import { useRequestFetch, useRequestURL, useState, useRoute } from '#app'
import type { AsyncData, AsyncDataOptions, KeysOf, PickFrom } from '#app'
import type { NuxtApp, NuxtError } from '#app'
import type { LitiPublicModels, LitiPublicSummaryModels } from '../../../liti/src/client'
import type { LitiIssue } from '../../../liti/src/index'
import type { LitiEntry, LitiFormModels, LitiManagementModels, LitiMutation } from '../../../liti/src/client'
import { presentLitiData } from '../../../liti/src/client'
import { createLitiModel, litiModelError } from '../../../vue/src/model'
// oxlint-disable-next-line no-unused-vars -- declaration emit must name the resource's unique symbol property
import type { litiModelContext } from '../../../vue/src/model'
import type { LitiFailure, LitiModelActions, LitiModelError, LitiSessionDraft } from '../../../vue/src/model'
import type { ModelDescriptor, LitiDescriptor } from '../../../liti/src/descriptor'
import { clearNuxtData, refreshNuxtData, useNuxtApp } from '#app'
import { defineUseFetchAddon } from '#app/composables/addons'
import { hashKey } from '#app'
import type { UseFetchOptions } from '#app'
import type { AsyncDataMiddleware } from '#app'
import type { ActionResult } from '../../../liti/src/plugins'
type Actions = RegisteredLitiSchema['actions']
import {
    computed,
    getCurrentInstance,
    nextTick,
    readonly,
    toValue,
    useId,
    watch,
    ref,
    shallowRef,
    type Ref,
    type MaybeRefOrGetter,
} from 'vue'
import type { EntryPrepareContext } from '../../../vue/src/model'
import { useEntryForm, type UseEntryFormOptions } from '../../../vue/src/form'
import { normalizeLitiQuery } from '../../../liti/src/query'
import type { LitiQueryModel, LitiQueryResult, RegisteredLitiSchema, ActionMetadata } from '../../../liti/src/query'
import {
    projectQuery,
    queryTotal,
    type ReactiveLitiQueryOptions,
    type ReactiveQuerySelection,
    type QuerySource,
} from '../../../vue/src/query'
import { litiModelCatalog } from '../../../liti/src/admin-client'
import type { LitiFormExtensionRegistry, LitiFormExtensions } from '../../../vue/src/extensions'

declare module '#app' {
    interface RuntimeNuxtHooks {
        'liti:entry:prepare': (context: EntryPrepareContext) => void | Promise<void>
    }
}

import type { UseAsyncData } from '#app'
import type { UseFetch, UseFetchAddon } from '#app'

declare global {
    interface ImportMeta {
        server: boolean
        client: boolean
        dev: boolean
        prerender: boolean
    }
}

type AsyncDataExecuteOptions = NonNullable<Parameters<AsyncData<unknown, unknown>['execute']>[0]>
type PublicModelName = Extract<keyof LitiPublicModels, string>

export interface UseLitiQuery {
    <
        Mode extends 'many' | 'one' = 'many',
        View extends 'published' | 'current' = 'published',
        Markdown extends 'full' | 'summary' = 'full',
        Name extends LitiQueryModel<RegisteredLitiSchema, { view: View }> = LitiQueryModel<
            RegisteredLitiSchema,
            { view: View }
        >,
        DataT = unknown,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
    >(
        model: Name,
        options: { mode?: Mode; view?: View; markdown?: Markdown } & ReactiveQuerySelection<Mode, View, Markdown> &
            Omit<
                AsyncDataOptions<
                    LitiQueryResult<RegisteredLitiSchema, Name, { mode: Mode; view: View; markdown: Markdown }>,
                    NoInfer<DataT>,
                    PickKeys,
                    NoInfer<DataT>
                >,
                'default' | 'transform'
            > & {
                transform: (
                    data: LitiQueryResult<RegisteredLitiSchema, Name, { mode: Mode; view: View; markdown: Markdown }>,
                ) => DataT | Promise<DataT>
                default?: () => NoInfer<DataT>
                authScope?: MaybeRefOrGetter<string>
            },
    ): AsyncData<PickFrom<DataT, PickKeys>, NuxtError<LitiFailure> | undefined> &
        (Mode extends 'many' ? { total: Readonly<Ref<number>> } : {}) &
        (View extends 'current' ? { remove(entry?: LitiEntry<FormData<Name>>): Promise<unknown> } : {})
    <
        Mode extends 'many' | 'one' = 'many',
        View extends 'published' | 'current' = 'published',
        Markdown extends 'full' | 'summary' = 'full',
        Name extends LitiQueryModel<RegisteredLitiSchema, { view: View }> = LitiQueryModel<
            RegisteredLitiSchema,
            { view: View }
        >,
        DataT = LitiQueryResult<RegisteredLitiSchema, Name, { mode: Mode; view: View; markdown: Markdown }>,
        PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
    >(
        model: Name,
        options?: { mode?: Mode; view?: View; markdown?: Markdown } & ReactiveQuerySelection<Mode, View, Markdown> &
            Omit<
                AsyncDataOptions<
                    LitiQueryResult<RegisteredLitiSchema, Name, { mode: Mode; view: View; markdown: Markdown }>,
                    NoInfer<DataT>,
                    PickKeys,
                    NoInfer<DataT>
                >,
                'default' | 'transform'
            > & {
                transform?: never
                default?: () => NoInfer<DataT>
                authScope?: MaybeRefOrGetter<string>
            },
    ): AsyncData<PickFrom<DataT, PickKeys>, NuxtError<LitiFailure> | undefined> &
        (Mode extends 'many' ? { total: Readonly<Ref<number>> } : {}) &
        (View extends 'current' ? { remove(entry?: LitiEntry<FormData<Name>>): Promise<unknown> } : {})
}

export interface LitiLocaleOptions {
    locale?: MaybeRefOrGetter<string | undefined>
}

export type LitiBatchRequest<Name extends string = PublicModelName> =
    | {
          list: Name
          markdown?: 'full' | 'summary'
          page?: MaybeRefOrGetter<{ limit: number; offset: number }>
          entry?: never
          id?: never
      }
    | { entry: Name; id: MaybeRefOrGetter<string>; path?: never; list?: never; markdown?: never }
    | { entry: Name; path: MaybeRefOrGetter<string>; id?: never; list?: never; markdown?: never }

export interface LitiBatchItemError {
    code: string
    message: string
    status: number
    issues?: LitiIssue[]
}

export interface LitiBatchItem<Data> {
    data: Data
    error: LitiBatchItemError | null
}

type LitiBatchListData<Name extends PublicModelName, Mode> = Mode extends 'summary'
    ? LitiPublicSummaryModels[Name & keyof LitiPublicSummaryModels][]
    : LitiPublicModels[Name][]

type LitiBatchMode<Request> = Request extends { markdown: infer Mode }
    ? Mode
    : Request extends { markdown?: infer Mode }
      ? Mode | undefined
      : 'full'
type LitiBatchRequestData<Request> = Request extends { list: infer Name extends PublicModelName }
    ? Request extends { page: unknown }
        ? PublicPage<LitiBatchListData<Name, LitiBatchMode<Request>>[number]>
        : LitiBatchListData<Name, LitiBatchMode<Request>>
    : Request extends { entry: infer Name extends PublicModelName }
      ? LitiPublicModels[Name] | null
      : never

export type LitiBatchResult<Requests extends Record<string, LitiBatchRequest>> = {
    [Name in keyof Requests]: LitiBatchItem<LitiBatchRequestData<Requests[Name]>>
}

type LitiResolvedBatchRequest = {
    name: string
    operation: 'list' | 'entry'
    model: string
    selector: string | null
    byPath?: boolean
    markdown?: 'summary'
    page?: { limit: number; offset: number }
}

export type ManagementModelName = Extract<keyof LitiFormModels, string>

type FormData<Name extends string> = Name extends ManagementModelName
    ? Extract<LitiFormModels[Name], Record<string, unknown>>
    : Record<string, unknown>

type ScopedManagementClient = { connection: LitiManagementClientOptions; scope: string; client: unknown }

export interface LitiModelOptions
    extends LitiLocaleOptions, Pick<AsyncDataOptions<unknown>, 'watch' | 'timeout' | 'dedupe' | 'deep'> {
    defaultLocale?: string
    page?: Ref<number>
    pageSize?: number
    queryPage?: MaybeRefOrGetter<{ limit: number; offset: number }>
    all?: boolean
    q?: MaybeRefOrGetter<string | undefined>
    authScope?: MaybeRefOrGetter<string>
    immediate?: boolean
    server?: boolean
    lazy?: boolean
}

export type LitiFormOptions<Data extends Record<string, unknown>> = LitiModelOptions &
    UseEntryFormOptions<Data> & {
        id?: MaybeRefOrGetter<string | null | undefined>
        instance?: MaybeRefOrGetter<string | undefined>
    }

type Handled<Methods> = {
    [Key in keyof Methods]: Methods[Key] extends (...args: infer Args) => Promise<infer Result>
        ? (...args: Args) => Promise<Result | undefined>
        : Methods[Key]
}

type LitiModelResource<Name extends string, Result> = Omit<
    AsyncData<Result, LitiModelError | undefined>,
    'then' | 'catch' | 'finally'
> &
    Handled<Omit<LitiModelActions<FormData<Name>>, 'data' | 'status' | 'error' | 'refresh' | 'meta'>> & {
        meta: Readonly<import('../../../liti/src/client').LitiModelMeta<Name>>
        page: Ref<number>
    }

type ModelActions<Name extends string> = LitiModelActions<FormData<Name>>

type SingleResource<Name extends string> = Omit<
    LitiModelResource<Name, LitiEntry<FormData<Name>> | null>,
    'publish' | 'schedule'
> & {
    publish: (value?: FormData<Name>) => Promise<Awaited<ReturnType<ModelActions<Name>['publish']>> | undefined>
    schedule: (
        at: Date | string,
        value?: FormData<Name>,
    ) => Promise<Awaited<ReturnType<ModelActions<Name>['schedule']>> | undefined>
}

type FormResource<Name extends string> = ReturnType<typeof useEntryForm<FormData<Name>>> &
    Pick<SingleResource<Name>, 'meta' | 'data' | 'status' | 'error' | 'refresh' | 'features' | 'display' | 'remove'> &
    LitiFormExtensions<Name>

type ValidModel<Name extends string> = Name &
    (Name extends ManagementModelName ? unknown : string extends Name ? unknown : never)

type AiActionName = Extract<keyof Actions, string>

export type UseAiOptions<Name extends AiActionName> = Pick<
    UseFetchOptions<Actions[Name]['output']>,
    'immediate' | 'lazy' | 'timeout' | 'dedupe' | 'deep'
> & {
    input: MaybeRefOrGetter<Actions[Name]['input']>
    authScope?: MaybeRefOrGetter<string>
    locale?: MaybeRefOrGetter<string | undefined>
}

export const litiAiFetchOptions: {
    method: 'post'
    watch: false
    retry: number
    dedupe: 'defer'
    addons: UseFetchAddon<{}, Pick<AsyncData<unknown, unknown>, 'execute' | 'refresh'>>[]
} = {
    method: 'post' as const,
    watch: false as const,
    retry: 0,
    dedupe: 'defer' as const,
    addons: [
        defineUseFetchAddon({
            setup: (options) => {
                Object.assign(options, { method: 'post', watch: false, retry: 0 })
                // Nuxt normalizes non-Error reasons to AbortError; timeout/provider errors retain native error state.
                const isCancellation = (reason: unknown) => !(reason instanceof Error) || reason.name === 'AbortError'
                const abortMiddleware: AsyncDataMiddleware = async (next, { signal }) => {
                    const key = toValue(options.key)
                    // Public clear settles Nuxt 4.6's external-abort promise after transport cancellation.
                    const abort = () => {
                        if (isCancellation(signal.reason) && key) clearNuxtData(key)
                    }
                    signal.addEventListener('abort', abort, { once: true })
                    try {
                        return await next()
                    } catch (cause) {
                        if (isCancellation(cause)) throw cause
                        throw litiModelError(cause)
                    } finally {
                        signal.removeEventListener('abort', abort)
                    }
                }
                options.middleware.push(abortMiddleware)
                return (asyncData) => {
                    const refresh = asyncData.refresh
                    const execute = (execution?: AsyncDataExecuteOptions): Promise<void> => {
                        if (execution?.signal?.aborted && isCancellation(execution.signal.reason)) {
                            // An already-cancelled invocation must not poison defer or cancel a healthy shared request.
                            if (asyncData.status.value !== 'pending') asyncData.clear()
                            return Promise.resolve()
                        }
                        const key = toValue(options.key)
                        const pending = refresh(execution)
                        // A synchronous status watcher can abort before middleware or promise registration.
                        if (execution?.signal?.aborted && isCancellation(execution.signal.reason) && key)
                            clearNuxtData(key)
                        return pending
                    }
                    return { execute, refresh: execute }
                }
            },
        }),
    ],
}

export const createLitiComposables = (
    configuration: {
        basePath: string
        managementBase: string
        origin?: string
        i18n?: boolean
        defaultLocale?: string
        auth?: boolean
        actions?: boolean
        editors?: Record<string, string[]>
    },
    litiAsyncData: UseAsyncData,
    litiAiFetch: UseFetch,
    getAuth?: () => { user: Ref<{ id?: string; role?: string | null } | null>; session: Ref<{ id?: string } | null> },
    extensions: LitiFormExtensionRegistry = {},
) => {
    const litiLocalFetches = new WeakMap<ReturnType<typeof useNuxtApp>, NonNullable<LitiClientOptions['fetch']>>()

    const useLocalFetch = (): NonNullable<LitiClientOptions['fetch']> => {
        if (!import.meta.server) return globalThis.fetch
        const nuxtApp = useNuxtApp()
        const cached = litiLocalFetches.get(nuxtApp)
        if (cached) return cached
        const requestFetch = import.meta.server ? useRequestFetch() : undefined
        const origin = useRequestURL().origin
        const fetch: NonNullable<LitiClientOptions['fetch']> = requestFetch
            ? async (input, init) => {
                  const url = new URL(String(input), origin)
                  const method = init?.method?.toLowerCase() ?? 'get'
                  if (
                      method !== 'get' &&
                      method !== 'head' &&
                      method !== 'post' &&
                      method !== 'put' &&
                      method !== 'patch' &&
                      method !== 'delete' &&
                      method !== 'options'
                  ) {
                      throw new TypeError('Unsupported liti HTTP method: ' + method)
                  }
                  let response: Response | undefined
                  await requestFetch(url.pathname + url.search, {
                      ...init,
                      method,
                      responseType: 'stream',
                      ignoreResponseError: true,
                      retry: 0,
                      onResponse: (context) => {
                          response = context.response
                      },
                  })
                  if (!response) throw new Error('liti internal fetch did not return a response.')
                  return response
              }
            : globalThis.fetch
        litiLocalFetches.set(nuxtApp, fetch)
        return fetch
    }

    const litiPublicClientOptions = (): LitiClientOptions => ({
        basePath: configuration.basePath,
        origin: configuration.origin ?? useRequestURL().origin,
        ...(configuration.origin ? {} : { fetch: useLocalFetch() }),
    })

    const litiManagementClientOptions = (): LitiManagementClientOptions => ({
        basePath: configuration.managementBase,
        origin: useRequestURL().origin,
        fetch: useLocalFetch(),
    })

    const useLitiRoute = () => useState<PublicRouteResult | null>('liti-route', () => null)

    const litiAttachAsyncData = <Data>(
        keySource: MaybeRefOrGetter<string>,
        handler: (app: NuxtApp, context: { signal: AbortSignal }) => Promise<Data>,
        options: Record<string, unknown> = {},
    ) => {
        // Commit each caller's computed key in Vue's job queue before native synchronous key watchers run.
        // This prevents sibling watchers from re-entering Nuxt while its shared entry is being constructed.
        const key = shallowRef(toValue(keySource))
        watch(
            () => toValue(keySource),
            (value) => {
                key.value = value
            },
        )
        return litiAsyncData<Data>(
            key,
            async (app, context) => {
                try {
                    return await handler(app, context)
                } catch (cause) {
                    context.signal.throwIfAborted()
                    if (cause instanceof Error && cause.name === 'AbortError') throw cause
                    throw litiModelError(cause)
                }
            },
            { dedupe: 'defer', ...options },
        )
    }

    const useLitiLocale = (provided?: LitiLocaleOptions['locale']) => {
        const i18n = configuration.i18n
            ? (useNuxtApp() as unknown as { $i18n?: { locale: Ref<string> } }).$i18n
            : undefined
        return computed(() => toValue(provided) ?? toValue(i18n?.locale))
    }

    const litiDataKey = (
        connection: LitiClientOptions,
        operation: 'entry' | 'list',
        model: string,
        selector: string | null,
        locale: string | undefined,
        markdown?: 'full' | 'summary',
        byPath = false,
        scope?: string,
    ): string =>
        'liti:' +
        JSON.stringify([
            connection.origin ?? 'same-origin',
            connection.basePath ?? configuration.basePath,
            operation,
            model,
            selector,
            locale ?? null,
            ...(byPath ? ['path'] : []),
            ...(markdown === 'summary' ? ['summary'] : []),
            { scope: scope ?? 'anonymous' },
        ])

    const litiSnapshotBatchRequests = (
        requests: Record<string, LitiBatchRequest<string>>,
    ): LitiResolvedBatchRequest[] =>
        Object.keys(requests)
            .sort()
            .map((name) => {
                const request = requests[name]!
                return request.list !== undefined
                    ? {
                          name,
                          operation: 'list',
                          model: request.list,
                          selector: null,
                          ...(request.markdown === 'summary' ? { markdown: 'summary' as const } : {}),
                          ...(request.page ? { page: toValue(request.page) } : {}),
                      }
                    : {
                          name,
                          operation: 'entry',
                          model: request.entry,
                          selector: toValue(request.id ?? request.path!),
                          ...(request.path === undefined ? {} : { byPath: true }),
                      }
            })

    const litiBatchDataKey = (
        connection: LitiClientOptions,
        requests: readonly LitiResolvedBatchRequest[],
        locale: string | undefined,
    ): string =>
        'liti:' +
        JSON.stringify([
            connection.origin ?? 'same-origin',
            connection.basePath ?? configuration.basePath,
            'batch',
            locale ?? null,
            requests.map(({ name, operation, model, selector, markdown, byPath, page }) => [
                name,
                operation,
                model,
                selector,
                ...(byPath ? ['path'] : []),
                ...(markdown ? [markdown] : []),
                ...(page ? [page] : []),
            ]),
        ])

    const litiBatchItemError = (error: unknown): LitiBatchItemError =>
        error instanceof LitiClientError
            ? {
                  code: error.code,
                  message: error.message,
                  status: error.status,
                  ...(error.issues ? { issues: error.issues.map(({ path, message }) => ({ path, message })) } : {}),
              }
            : {
                  code: 'LITI_REQUEST_FAILED',
                  message: error instanceof Error ? error.message : 'Request failed.',
                  status: 0,
              }

    const litiResolveBatch = async (
        client: LitiClient<
            Record<string, import('../../../liti/src/client').PublicEntry>,
            Record<string, import('../../../liti/src/client').PublicEntry>
        >,
        requests: readonly LitiResolvedBatchRequest[],
        locale: string | undefined,
        signal: AbortSignal,
    ): Promise<LitiBatchResult<Record<string, LitiBatchRequest>>> => {
        signal.throwIfAborted()
        const items = await Promise.all(
            requests.map(async ({ name, operation, model, selector, markdown, byPath, page }) => {
                try {
                    const options = { signal, ...(locale === undefined ? {} : { locale }) }
                    const resolved = byPath ? await client.resolveRoute(selector!, options) : undefined
                    const data =
                        operation === 'list'
                            ? page
                                ? markdown === 'summary'
                                    ? await client.page(model, page, { ...options, markdown })
                                    : await client.page(model, page, options)
                                : markdown === 'summary'
                                  ? await client.list(model, { ...options, markdown })
                                  : await client.list(model, options)
                            : byPath
                              ? resolved?.entry?.model === model
                                  ? resolved.entry
                                  : null
                              : await client.get(model, selector!, options)
                    return [name, { data, error: null }] as const
                } catch (error) {
                    signal.throwIfAborted()
                    if (error instanceof Error && error.name === 'AbortError') throw error
                    return [
                        name,
                        {
                            data: operation === 'list' ? (page ? { items: [], total: 0, ...page } : []) : null,
                            error: litiBatchItemError(error),
                        },
                    ] as const
                }
            }),
        )
        signal.throwIfAborted()
        // Every named response corresponds to the model and operation in its captured request.
        return Object.fromEntries(items) as LitiBatchResult<Record<string, LitiBatchRequest>>
    }

    function usePublishedSource(
        modelOrRequests: PublicModelName | MaybeRefOrGetter<Record<string, LitiBatchRequest>>,
        options: AsyncDataOptions<unknown> &
            LitiLocaleOptions & {
                id?: MaybeRefOrGetter<string | null | undefined>
                path?: MaybeRefOrGetter<string | null | undefined>
                markdown?: 'full' | 'summary'
                page?: MaybeRefOrGetter<{ limit: number; offset: number }>
                mode?: 'many' | 'one'
                authScope?: MaybeRefOrGetter<string>
            } = {},
    ) {
        const connection = litiPublicClientOptions()
        const client = createPublicClient<LitiPublicModels, LitiPublicSummaryModels>(connection)
        const locale = useLitiLocale(options.locale)
        const auth = useLitiAuthScope(options.authScope)
        const {
            locale: _locale,
            markdown: _markdown,
            id: _id,
            path: _path,
            page: _page,
            mode: _mode,
            authScope: _scope,
            ...asyncOptions
        } = options
        if (typeof modelOrRequests !== 'string') {
            const snapshot = computed(() => litiSnapshotBatchRequests(toValue(modelOrRequests)))
            const key = computed(() => litiBatchDataKey(connection, snapshot.value, locale.value))
            return litiAttachAsyncData(
                () => key.value,
                (_app, { signal }) => litiResolveBatch(client, snapshot.value, locale.value, signal),
                asyncOptions,
            )
        }
        const model = modelOrRequests
        if (options.id !== undefined && options.path !== undefined) throw new TypeError('[liti] Choose id or path.')
        const single = options.mode === 'one'
        const route = useLitiRoute()
        const path = useRoute()
        const key = computed(() =>
            litiDataKey(
                connection,
                single ? 'entry' : 'list',
                model,
                single
                    ? (toValue(options.id ?? options.path!) ?? null)
                    : options.page
                      ? JSON.stringify(toValue(options.page))
                      : null,
                locale.value,
                options.markdown,
                options.path !== undefined,
                auth.value,
            ),
        )
        return litiAttachAsyncData(
            () => key.value,
            async (_app, { signal }): Promise<unknown> => {
                const request = { signal, ...(locale.value === undefined ? {} : { locale: locale.value }) }
                if (!single && options.page)
                    return options.markdown === 'summary'
                        ? client.page(model, toValue(options.page), { ...request, markdown: 'summary' })
                        : client.page(model, toValue(options.page), request)
                if (!single)
                    return options.markdown === 'summary'
                        ? client.list(model, { ...request, markdown: 'summary' })
                        : client.list(model, request)
                const cachedRoute = route.value
                const entry = cachedRoute?.entry
                const selector = toValue(options.id ?? options.path!)
                if (!selector) return null
                // Reuse the route resolver's raw DTO before native AsyncData transform/pick.
                if (
                    options.markdown !== 'summary' &&
                    cachedRoute?.path === path.path &&
                    cachedRoute?.origin === connection.origin &&
                    entry?.model === model &&
                    (options.path !== undefined ? cachedRoute.path === selector : entry.id === selector) &&
                    (locale.value === undefined || entry.locale === locale.value)
                )
                    return Promise.resolve(entry)
                if (options.path !== undefined)
                    return client
                        .resolveRoute(selector, {
                            ...request,
                            ...(options.markdown ? { markdown: options.markdown } : {}),
                        })
                        .then((resolved) => (resolved?.entry?.model === model ? resolved.entry : null))
                return client.get(model, selector, {
                    ...request,
                    ...(options.markdown ? { markdown: options.markdown } : {}),
                })
            },
            asyncOptions,
        )
    }

    const litiManagementClients = new WeakMap<ReturnType<typeof useNuxtApp>, ScopedManagementClient[]>()

    const useLitiAuthScope = (
        provided?: MaybeRefOrGetter<string>,
        connection: LitiManagementClientOptions = litiManagementClientOptions(),
    ) => {
        const nuxtApp = useNuxtApp()
        const { user, session } = getAuth?.() ?? { user: ref(null), session: ref(null) }
        const scope = computed(
            () =>
                toValue(provided) ??
                JSON.stringify([
                    user.value?.id ?? null,
                    (user.value as { role?: string } | null)?.role ?? null,
                    session.value?.id ?? null,
                ]),
        )
        watch(
            scope,
            (_next, previous) =>
                nuxtApp.runWithContext(() => {
                    const clients = litiManagementClients.get(nuxtApp)
                    if (clients)
                        litiManagementClients.set(
                            nuxtApp,
                            clients.filter(
                                (item) =>
                                    !(
                                        item.scope === previous &&
                                        item.connection.origin === connection.origin &&
                                        item.connection.basePath === connection.basePath
                                    ),
                            ),
                        )
                    const drafts = useState<Record<string, LitiSessionDraft>>('liti:form-drafts', () =>
                        Object.create(null),
                    ).value
                    for (const key of Object.keys(drafts)) {
                        try {
                            const [origin, base, auth] = JSON.parse(key.slice('liti-management:'.length))
                            if (origin === connection.origin && base === connection.basePath && auth === previous)
                                delete drafts[key]
                        } catch {}
                    }
                    clearNuxtData((key) => {
                        if (!key.startsWith('liti-management:')) return false
                        try {
                            const [origin, base, auth] = JSON.parse(key.slice('liti-management:'.length))
                            return origin === connection.origin && base === connection.basePath && auth === previous
                        } catch {
                            return false
                        }
                    })
                }),
            { flush: 'sync' },
        )
        return scope
    }

    const litiManagementKey = (
        connection: LitiManagementClientOptions,
        scope: string,
        operation: string,
        model: string | null,
        identity: unknown,
        locale?: string,
        instance?: string,
    ): string =>
        'liti-management:' +
        JSON.stringify([
            connection.origin ?? 'same-origin',
            connection.basePath ?? configuration.managementBase,
            scope,
            operation,
            model,
            identity,
            locale ?? null,
            ...(instance === undefined ? [] : [instance]),
        ])

    const litiCachedEntryId = (data: unknown): string | undefined => {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
        const id = (data as { id?: unknown }).id
        return typeof id === 'string' ? id : undefined
    }

    const litiInvalidateMutation = async (
        connection: LitiManagementClientOptions,
        scope: string,
        mutation: LitiMutation,
    ): Promise<void> => {
        const keys: string[] = []
        // useNuxtData subscribes to AsyncData; mutation observers must only inspect serialized DTOs.
        const payload = useNuxtApp().payload.data
        clearNuxtData((key) => {
            let matches = false
            try {
                if (key.startsWith('liti-management:')) {
                    const [origin, base, auth, operation, model, id] = JSON.parse(key.slice('liti-management:'.length))
                    matches =
                        origin === connection.origin &&
                        base === connection.basePath &&
                        auth === scope &&
                        ((operation === 'list' && model === mutation.model) ||
                            ((operation === 'entry' || operation === 'form-entry') &&
                                (!mutation.model || model === mutation.model) &&
                                id === mutation.id))
                } else if (key.startsWith('liti:')) {
                    const [origin, base, operation, model, selector] = JSON.parse(key.slice('liti:'.length))
                    if (origin === connection.origin && base === configuration.basePath) {
                        if (operation === 'list') matches = model === mutation.model
                        // Native transform/pick may remove identity; conservatively clear that model's unidentifiable entries.
                        else if (operation === 'entry') {
                            const cachedId = litiCachedEntryId(payload[key])
                            matches =
                                model === mutation.model &&
                                (selector === mutation.id || cachedId === mutation.id || cachedId === undefined)
                        } else if (operation === 'batch') {
                            const cached = payload[key] as
                                | Record<string, { data: { id?: string } | unknown[] | null }>
                                | undefined
                            matches = (selector as Array<[string, string, string, string | null]>).some(
                                ([name, itemOperation, itemModel, id]) =>
                                    itemModel === mutation.model &&
                                    (itemOperation === 'list' ||
                                        id === mutation.id ||
                                        litiCachedEntryId(cached?.[name]?.data) === mutation.id ||
                                        litiCachedEntryId(cached?.[name]?.data) === undefined),
                            )
                        }
                    }
                }
            } catch {
                return false
            }
            if (matches) keys.push(key)
            return matches
        })
        if (keys.length) await refreshNuxtData(keys)
    }

    const createNuxtLitiManagementClient = <
        Models extends { [Name in keyof Models]: Record<string, unknown> } = LitiManagementModels,
    >(
        connection: LitiManagementClientOptions,
        auth: MaybeRefOrGetter<string>,
    ) => {
        const nuxtApp = useNuxtApp()
        const scoped = (): LitiManagementClient<Models> => {
            const scope = toValue(auth)
            const clients = litiManagementClients.get(nuxtApp) ?? []
            const cached = clients.find(
                (item) =>
                    item.scope === scope &&
                    item.connection.origin === connection.origin &&
                    item.connection.basePath === connection.basePath &&
                    item.connection.fetch === connection.fetch &&
                    item.connection.credentials === connection.credentials,
            )
            if (cached) return cached.client as LitiManagementClient<Models>
            const snapshot = { ...connection }
            const client = createLitiManagementClient<Models>({
                ...snapshot,
                onMutation: (mutation) =>
                    scope === toValue(auth)
                        ? nuxtApp.runWithContext(() => litiInvalidateMutation(snapshot, scope, mutation))
                        : undefined,
            })
            clients.push({ connection: snapshot, scope, client })
            litiManagementClients.set(nuxtApp, clients)
            return client
        }
        // Capture auth per invocation, including concurrent mutations and a user change while saving.
        return new Proxy(scoped(), {
            get(_target, property) {
                const method: unknown = Reflect.get(scoped(), property)
                if (typeof method !== 'function') return method
                return (...args: unknown[]) => {
                    const scope = toValue(auth)
                    const result = (Reflect.get(scoped(), property) as (...args: unknown[]) => unknown)(...args)
                    if (!(result instanceof Promise)) return result
                    return result.then((value) => {
                        if (scope !== toValue(auth))
                            throw new DOMException('Authentication changed during the request.', 'AbortError')
                        return value
                    })
                }
            },
        })
    }

    const useModelDescriptor = (
        connection: LitiManagementClientOptions,
        auth: MaybeRefOrGetter<string>,
        immediate = true,
    ) => {
        const client = createNuxtLitiManagementClient(connection, auth)
        const uiLocale = useLitiLocale()
        const key = computed(() => litiManagementKey(connection, toValue(auth), 'models', null, null, uiLocale.value))
        return litiAttachAsyncData(
            () => key.value,
            (_app, { signal }) => client.models({ signal, ...(uiLocale.value ? { uiLocale: uiLocale.value } : {}) }),
            { dedupe: 'defer', immediate },
        )
    }

    const litiReadModels = async (
        source: ReturnType<typeof useModelDescriptor>,
        auth: MaybeRefOrGetter<string>,
        signal: AbortSignal,
    ): Promise<LitiDescriptor> => {
        const scope = toValue(auth)
        await nextTick()
        signal.throwIfAborted()
        if (scope !== toValue(auth))
            throw new DOMException('Authentication changed while loading models.', 'AbortError')
        // A form/ID cancellation must not abort a descriptor request shared by other consumers.
        if (!source.data.value) await source.execute({ dedupe: 'defer' })
        signal.throwIfAborted()
        if (scope !== toValue(auth))
            throw new DOMException('Authentication changed while loading models.', 'AbortError')
        if (source.error.value) throw source.error.value
        if (!source.data.value)
            throw new LitiClientError('LITI_INVALID_RESPONSE', 'Model descriptor is unavailable.', 502)
        return source.data.value
    }

    const litiModelDescriptor = (source: LitiDescriptor, model: string): ModelDescriptor => {
        const descriptor = Object.hasOwn(source.models, model) ? source.models[model] : undefined
        if (!descriptor)
            throw new LitiClientError(
                'LITI_FORBIDDEN',
                '[liti] Form model "' + model + '" is unavailable to this actor.',
                403,
            )
        return descriptor
    }

    const useLitiModels = () => {
        const connection = litiManagementClientOptions()
        const scope = useLitiAuthScope(undefined, connection)
        const source = useModelDescriptor(connection, scope)
        const projection = projectQuery(source, {}, {}, (value) => litiModelCatalog(value as LitiDescriptor))
        const handle = {
            ...projection.handle,
            data: readonly(projection.handle.data) as Readonly<Ref<ReturnType<typeof litiModelCatalog>>>,
        }
        return Object.assign(
            source.then(async () => {
                await projection.ready()
                return handle
            }),
            handle,
        )
    }

    const useLitiQuery = (
        model: string,
        options: ReactiveLitiQueryOptions &
            AsyncDataOptions<unknown> & {
                authScope?: MaybeRefOrGetter<string>
            } = {},
    ) => {
        const { transform, pick, default: initial, page: _page, pageSize: _size, ...queryOptions } = options
        const locale = useLitiLocale(options.locale)
        const auth = useLitiAuthScope(options.authScope)
        const resolved = computed(() =>
            normalizeLitiQuery({
                ...queryOptions,
                ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
                ...('id' in options ? { id: toValue(options.id) } : {}),
                ...('path' in options ? { path: toValue(options.path) } : {}),
                ...(options.page ? { page: toValue(options.page) } : {}),
                ...(locale.value ? { locale: locale.value } : {}),
                ...('q' in options && options.q ? { q: toValue(options.q) } : {}),
            } as import('../../../liti/src/query').LitiQueryOptions),
        )
        const one = resolved.value.mode === 'one'
        const current = resolved.value.view === 'current'
        const source = current
            ? useAdminResource(model, {
                  ...queryOptions,
                  authScope: auth,
                  ...(one ? { id: () => resolved.value.id ?? null } : {}),
                  ...(resolved.value.page ? { queryPage: () => resolved.value.page! } : {}),
                  all: !resolved.value.page,
              })
            : usePublishedSource(
                  model as PublicModelName,
                  {
                      ...queryOptions,
                      authScope: auth,
                      ...(resolved.value.page ? { page: () => resolved.value.page! } : {}),
                      mode: one ? 'one' : 'many',
                  } as Parameters<typeof usePublishedSource>[1],
              )
        const projection = projectQuery(
            source as unknown as QuerySource<AsyncDataExecuteOptions>,
            one ? null : [],
            {
                ...(transform ? { transform } : {}),
                ...(pick ? { pick } : {}),
                ...(initial ? { default: initial } : {}),
            },
            (value) => (!one && value && typeof value === 'object' && 'items' in value ? value.items : value),
            () => JSON.stringify([auth.value, resolved.value]),
        )
        const handle = {
            ...projection.handle,
            ...(!one ? { total: queryTotal(source as unknown as QuerySource) } : {}),
            status: computed(() => (resolved.value.waiting ? 'idle' : projection.handle.status.value)),
            ...(current ? { remove: (source as ReturnType<typeof useAdminResource>).remove } : {}),
        }
        return Object.assign(
            source.then(async () => {
                await projection.ready()
                return handle
            }),
            handle,
        )
    }

    const useLitiForm = <Name extends string>(
        model: ValidModel<Name>,
        options: LitiFormOptions<FormData<Name>> = {},
    ): FormResource<Name> & Promise<FormResource<Name>> => {
        const generatedInstance = getCurrentInstance() ? useId() : crypto.randomUUID()
        const resource = useAdminResource(
            model,
            {
                ...options,
                id: () => toValue(options.id) ?? null,
                instance: () => toValue(options.instance) ?? generatedInstance,
            },
            true,
        ) as unknown as Promise<SingleResource<Name>> & SingleResource<Name>
        const editor = useEntryForm(
            resource,
            options,
            Object.fromEntries(
                Object.entries(extensions).filter(([name]) => configuration.editors?.[model]?.includes(name)),
            ),
        )
        const result = {
            ...editor,
            meta: resource.meta,
            data: resource.data,
            status: resource.status,
            error: resource.error,
            refresh: resource.refresh,
            features: resource.features,
            display: resource.display,
            remove: resource.remove,
        }
        return Object.assign(
            resource.then(() => result),
            result,
        ) as FormResource<Name> & Promise<FormResource<Name>>
    }

    function useAdminResource(
        model: string,
        options: LitiModelOptions & {
            id?: MaybeRefOrGetter<string | null | undefined>
            instance?: MaybeRefOrGetter<string | undefined>
        } = {},
        form = false,
    ) {
        const connection = litiManagementClientOptions()
        const auth = useLitiAuthScope(options.authScope, connection)
        const locale = useLitiLocale(options.locale)
        const client = createNuxtLitiManagementClient<Record<string, Record<string, unknown>>>(connection, auth)
        const modelsSource = useModelDescriptor(connection, auth, false)
        const descriptor = computed(() =>
            modelsSource.data.value && Object.hasOwn(modelsSource.data.value.models, model)
                ? modelsSource.data.value.models[model]
                : undefined,
        )
        const single = options.id !== undefined
        const id = ref(single ? (toValue(options.id!) ?? null) : null)
        watch(
            [() => toValue(options.id), () => toValue(options.instance), auth],
            ([value]) => {
                id.value = value ?? null
            },
            { flush: 'sync' },
        )
        const page = options.page ?? ref(1)
        const size = options.pageSize ?? 20
        if (!Number.isSafeInteger(size) || size < 1 || size > 100)
            throw new TypeError('[liti] pageSize must be an integer from 1 to 100.')
        watch(
            [locale, () => toValue(options.q)],
            () => {
                page.value = 1
            },
            { flush: 'sync' },
        )
        const query = computed(() => ({
            ...(locale.value === undefined ? {} : { locale: locale.value }),
            ...(toValue(options.q) === undefined ? {} : { q: toValue(options.q)! }),
            limit: size,
            offset: (Math.max(1, page.value) - 1) * size,
            ...toValue(options.queryPage),
        }))
        const identity = computed(() =>
            litiManagementKey(
                connection,
                auth.value,
                'form',
                model,
                toValue(options.instance) === undefined
                    ? (toValue(options.id) ?? null)
                    : [toValue(options.id) ?? null, toValue(options.instance)],
                locale.value,
            ),
        )
        const key = computed(() =>
            litiManagementKey(
                connection,
                auth.value,
                single ? 'entry' : 'list',
                model,
                single
                    ? id.value
                    : options.all
                      ? { locale: locale.value, q: toValue(options.q), all: true }
                      : query.value,
                locale.value,
                form && id.value === null ? toValue(options.instance) : undefined,
            ),
        )
        let retained: unknown
        let retainedKey: string | undefined
        const source = litiAttachAsyncData(
            () => key.value,
            async (_app, { signal }) => {
                const requestedKey = key.value
                const requestedId = id.value
                const requestedQuery = query.value
                if (single && requestedId === null && !form) return null
                const models = await litiReadModels(modelsSource, auth, signal)
                const modelDescriptor = litiModelDescriptor(models, model)
                const present = (entry: LitiEntry) => {
                    if (entry.model !== model)
                        throw new LitiClientError(
                            'LITI_INVALID_RESPONSE',
                            'Entry does not belong to the requested model and locale.',
                            502,
                        )
                    return { ...entry, data: presentLitiData(modelDescriptor, entry.data, client.assetUrl) }
                }
                const result = single
                    ? requestedId === null
                        ? null
                        : await client
                              .getEntry(requestedId, { signal })
                              .then(present)
                              .catch((error: unknown) => {
                                  if (error instanceof LitiClientError && error.code === 'LITI_ENTRY_NOT_FOUND')
                                      return null
                                  throw error
                              })
                    : options.all
                      ? await client.listAllEntries(model, { ...requestedQuery, limit: 100, signal }).then((items) => ({
                            items: items.map(present),
                            total: items.length,
                            limit: items.length,
                            offset: 0,
                        }))
                      : await client
                            .listEntries(model, { ...requestedQuery, signal })
                            .then((responsePage) => ({ ...responsePage, items: responsePage.items.map(present) }))
                signal.throwIfAborted()
                if (requestedKey === key.value) {
                    retained = result
                    retainedKey = requestedKey
                }
                return result
            },
            {
                immediate: options.immediate,
                server: options.server,
                lazy: options.lazy,
                watch: options.watch,
                timeout: options.timeout,
                deep: options.deep,
                dedupe: options.dedupe ?? 'defer',
                default: () => (retainedKey === key.value ? retained : undefined),
            },
        )
        const localStatus = shallowRef(source.status.value)
        const localError = shallowRef<LitiModelError | undefined>(source.error.value as LitiModelError | undefined)
        watch(
            [source.status, source.error],
            ([status, error]) => {
                if (error || status === 'pending') localError.value = error as LitiModelError | undefined
                localStatus.value = localError.value ? 'error' : status
            },
            { flush: 'sync' },
        )
        const nativeRefresh = source.refresh
        const correctPage = async () => {
            const result = source.data.value
            if (!single && !options.all && !options.queryPage && result && 'items' in result) {
                const last = Math.max(1, Math.ceil(result.total / size))
                if (page.value > last) {
                    page.value = last
                    await nextTick()
                    await nativeRefresh({ dedupe: 'defer' })
                }
            }
        }
        const refresh = async (...args: Parameters<typeof nativeRefresh>) => {
            await nextTick()
            await nativeRefresh(...args)
            await correctPage()
        }
        const nuxtApp = useNuxtApp()
        const core = createLitiModel(
            {
                data: source.data,
                status: localStatus,
                error: localError,
                refresh: async () => {
                    await nextTick()
                    if (source.status.value === 'idle' || source.status.value === 'pending')
                        await source.execute({ dedupe: 'defer' })
                    await correctPage()
                },
            },
            {
                model,
                descriptor,
                id,
                identity,
                scope: auth,
                group: () =>
                    litiManagementKey(connection, auth.value, 'form', model, [
                        toValue(options.id) ?? null,
                        toValue(options.instance) ?? null,
                    ]),
                locale,
                client,
                instance: options.instance,
                ...((options.defaultLocale ?? configuration.defaultLocale)
                    ? { defaultLocale: options.defaultLocale ?? configuration.defaultLocale! }
                    : {}),
                prepare: (context) => nuxtApp.runWithContext(() => nuxtApp.callHook('liti:entry:prepare', context)),
                drafts: useState<Record<string, LitiSessionDraft>>('liti:form-drafts', () => Object.create(null)).value,
            },
        )
        const nativeClear = source.clear
        const actions = {
            ...core,
            page,
            refresh,
            clear: () => {
                retained = undefined
                retainedKey = undefined
                nativeClear()
            },
            ...(single
                ? {
                      publish: (value?: Record<string, unknown>) => core.publish(undefined, value),
                      schedule: (at: string, value?: Record<string, unknown>) => core.schedule(at, undefined, value),
                  }
                : {
                      schedule: (entry: LitiEntry, at: Date | string) => core.schedule(at, entry),
                      restore: (entry: LitiEntry, revision: string) => core.restore(revision, entry),
                  }),
        }
        for (const name of [
            'save',
            'publish',
            'schedule',
            'remove',
            'unpublish',
            'cancelSchedule',
            'reorder',
            'revisions',
            'restore',
        ] as const) {
            if (typeof actions[name] !== 'function') continue
            const run = actions[name] as (...args: unknown[]) => Promise<unknown>
            Object.assign(actions, { [name]: (...args: unknown[]) => run(...args).catch(() => undefined) })
        }
        // Both the immediate object and Nuxt's awaited object expose the same extension.
        return Object.assign(
            source.then((value) => Object.assign(value, actions)),
            source,
            actions,
        )
    }

    function useAi<Name extends AiActionName>(
        name: Name,
        options: UseAiOptions<Name>,
    ): AsyncData<Actions[Name]['output'] | undefined, NuxtError | undefined> & {
        metadata: Readonly<Ref<ActionMetadata<Actions[Name]> | undefined>>
    } {
        const { input, authScope, locale: language, ...nativeOptions } = options
        const scope = useLitiAuthScope(authScope)
        const locale = useLitiLocale(language)
        const body = computed(() => ({ input: JSON.parse(JSON.stringify(toValue(input))) }))
        const path = configuration.managementBase.replace(/\/$/u, '') + '/actions/' + encodeURIComponent(name)
        const connection = litiManagementClientOptions()
        const key = computed(
            () => 'liti-ai:' + hashKey([connection.origin, path, scope.value, locale.value, body.value]),
        )
        // A changed input or scope invalidates an in-flight proposal before Nuxt reuses its cache.
        watch(key, (_next, previous) => clearNuxtData(previous), { flush: 'sync' })
        const source = litiAiFetch<ActionResult<Actions[Name]['output'], ActionMetadata<Actions[Name]>>>(path, {
            immediate: false,
            ...nativeOptions,
            server: false,
            key,
            body,
        })
        const projections = {
            data: computed(() => source.data.value?.data),
            metadata: computed(() => source.data.value?.metadata),
        }
        return Object.assign(
            source.then((value) => ({ ...value, ...projections })),
            source,
            projections,
        )
    }
    return {
        litiResolveBatch,
        litiSnapshotBatchRequests,
        litiBatchDataKey,
        usePublishedSource,
        useAi,
        litiPublicClientOptions,
        litiManagementClientOptions,
        useLitiRoute,
        litiAttachAsyncData,
        useLitiAuthScope,
        litiManagementKey,
        createNuxtLitiManagementClient,
        useLitiModels: useLitiModels as () => AsyncData<
            ReturnType<typeof litiModelCatalog>,
            NuxtError<LitiFailure> | undefined
        >,
        useModelDescriptor,
        useManagedSource: useAdminResource,
        useLitiQuery: useLitiQuery as unknown as UseLitiQuery,
        litiReadModels,
        useLitiForm,
    }
}
