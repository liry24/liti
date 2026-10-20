import {
    computed,
    effectScope,
    getCurrentInstance,
    getCurrentScope,
    inject,
    onScopeDispose,
    readonly,
    shallowRef,
    toValue,
    useId,
    watch,
    type App,
    type InjectionKey,
    type MaybeRefOrGetter,
    type Ref,
} from 'vue'
import type { LitiClient } from '../../liti/src/public-client'
import type { LitiBrowserBridge, LitiDescriptor } from '../../liti/src/descriptor'
import type { LitiEntry, LitiEntryPage, LitiManagementClient } from '../../liti/src/client'
import { LitiClientError } from '../../liti/src/client'
import { litiModelCatalog } from '../../liti/src/admin-client'
import { normalizeLitiQuery, type LitiQueryOptions, type LitiSchema } from '../../liti/src/query'
import {
    createLitiModel,
    litiModelContext,
    litiModelError,
    litiSnapshot,
    type LitiModelData,
    type LitiModelError,
    type LitiSessionDraft,
} from './model'
import { projectQuery, type ReactiveLitiQueryOptions } from './query'
import { useEntryForm, type UseEntryFormOptions } from './form'
import type { EntryPrepareContext } from '../../liti/src/entry-preparation'

export interface LitiVueOptions<Schema extends LitiSchema = LitiSchema> {
    client: LitiClient<Schema>
    bridge: LitiBrowserBridge
    authScope?: MaybeRefOrGetter<string>
    locale?: MaybeRefOrGetter<string | undefined>
    prepare?: (context: EntryPrepareContext) => void | Promise<void>
}

interface CachedResource {
    data: Ref<unknown>
    status: Ref<'idle' | 'pending' | 'success' | 'error'>
    error: Ref<LitiModelError | undefined>
    users: number
    stale: boolean
    pending?: Promise<void>
    controller?: AbortController
    load(force?: boolean): Promise<void>
}

export type VueFormOptions = UseEntryFormOptions<Record<string, unknown>> & {
    id?: MaybeRefOrGetter<string | null | undefined>
    instance?: MaybeRefOrGetter<string | undefined>
    locale?: MaybeRefOrGetter<string | undefined>
}

const key: InjectionKey<ReturnType<typeof createRuntime>> = Symbol('liti-vue')

export const createLitiVue = <Schema extends LitiSchema>(options: LitiVueOptions<Schema>) => ({
    install(app: App) {
        const lifetime = effectScope(true)
        const runtime = lifetime.run(() => createRuntime(options as unknown as LitiVueOptions))!
        app.provide(key, runtime)
        app.onUnmount(() => lifetime.stop())
    },
})

export const useLitiRuntime = () => {
    const runtime = inject(key)
    if (!runtime) throw new Error('[liti] Install createLitiVue({ client, bridge }) before using composables.')
    return runtime
}

const createRuntime = (options: LitiVueOptions) => {
    const cache = new Map<string, CachedResource>()
    const drafts: Record<string, LitiSessionDraft> = Object.create(null)
    const scope = computed(() => toValue(options.authScope) ?? 'anonymous')
    const locale = (provided?: MaybeRefOrGetter<string | undefined>) =>
        computed(() => toValue(provided) ?? toValue(options.locale))
    const dispose = () => {
        for (const resource of cache.values()) resource.controller?.abort()
        cache.clear()
        for (const name of Object.keys(drafts)) delete drafts[name]
    }
    watch(scope, dispose, { flush: 'sync' })
    onScopeDispose(dispose)

    const resource = (
        identity: () => string,
        loader: (signal: AbortSignal, identity: string) => Promise<unknown>,
        initial: unknown,
        immediate = true,
    ) => {
        const get = () => {
            const id = identity()
            let entry = cache.get(id)
            if (!entry) {
                const created: CachedResource = {
                    data: shallowRef(initial),
                    error: shallowRef(),
                    status: shallowRef('idle'),
                    users: 0,
                    stale: true,
                    async load(force = false) {
                        if (created.pending) return created.pending
                        if (!force && !created.stale) {
                            if (created.error.value) throw created.error.value
                            return
                        }
                        const controller = new AbortController()
                        created.controller = controller
                        created.status.value = 'pending'
                        created.error.value = undefined
                        created.pending = (async () => {
                            try {
                                const value = await loader(controller.signal, id)
                                controller.signal.throwIfAborted()
                                created.data.value = value
                                created.status.value = 'success'
                                created.stale = false
                            } catch (error) {
                                if (!controller.signal.aborted) {
                                    created.error.value = litiModelError(error)
                                    created.status.value = 'error'
                                    created.stale = false
                                }
                                throw error
                            } finally {
                                delete created.pending
                            }
                        })()
                        return created.pending
                    },
                }
                entry = created
                cache.set(id, entry)
            }
            return entry
        }
        let subscribed: CachedResource | undefined
        watch(
            identity,
            () => {
                if (subscribed) subscribed.users--
                subscribed = get()
                subscribed.users++
                if (immediate) void subscribed.load().catch(() => {})
            },
            { immediate: true, flush: 'sync' },
        )
        if (getCurrentScope())
            onScopeDispose(() => {
                if (subscribed) subscribed.users--
            })
        const data = computed({
            get: () => get().data.value,
            set: (value) => {
                get().data.value = value
            },
        })
        const status = computed({
            get: () => get().status.value,
            set: (value) => {
                get().status.value = value
            },
        })
        const error = computed({
            get: () => get().error.value,
            set: (value) => {
                get().error.value = value
            },
        })
        const refresh = () => get().load(true)
        const handle = {
            data,
            status,
            error,
            refresh,
            execute: refresh,
            clear: () => {
                const entry = get()
                entry.controller?.abort()
                entry.data.value = initial
                entry.status.value = 'idle'
                entry.error.value = undefined
                entry.stale = true
            },
        }
        return { handle, ensure: () => get().load(), ready: () => get().pending?.catch(() => {}) ?? Promise.resolve() }
    }

    const invalidate = async (model: string) => {
        const pending = []
        for (const [id, entry] of cache) {
            const [, , type, name] = JSON.parse(id)
            if (type !== 'models' && name !== model) continue
            entry.stale = true
            if (entry.users) pending.push(entry.load(true))
        }
        await Promise.allSettled(pending)
    }
    const management = (model: string) =>
        new Proxy(options.client, {
            get(target, name, receiver) {
                const value: unknown = Reflect.get(target, name, receiver)
                if (typeof value !== 'function') return value
                if (
                    ![
                        'createEntry',
                        'updateEntry',
                        'deleteEntry',
                        'publishEntry',
                        'unpublishEntry',
                        'schedulePublish',
                        'cancelScheduledPublish',
                        'restoreRevision',
                        'setSortOrders',
                    ].includes(String(name))
                )
                    return value.bind(target)
                return async (...args: unknown[]) => {
                    const startedScope = scope.value
                    try {
                        const result = await Reflect.apply(value, target, args)
                        if (scope.value === startedScope) await invalidate(model)
                        return result
                    } catch (error) {
                        if (scope.value === startedScope && error instanceof LitiClientError && error.committed)
                            await invalidate(model)
                        throw error
                    }
                }
            },
        }) as unknown as LitiManagementClient<Record<string, Record<string, unknown>>>

    const describe = () =>
        resource(
            () => JSON.stringify([scope.value, toValue(options.locale), 'models']),
            (signal, identity) => {
                const [, uiLocale] = JSON.parse(identity) as [string, string | null]
                return options.client.models({ signal, ...(uiLocale ? { uiLocale } : {}) })
            },
            undefined,
        )

    const query = (
        model: string,
        input: ReactiveLitiQueryOptions = {},
        immediate = true,
        instance?: () => string | undefined,
    ) => {
        const language = locale(input.locale)
        const snapshot = computed(() =>
            normalizeLitiQuery({
                ...input,
                ...('id' in input ? { id: toValue(input.id) } : {}),
                ...('path' in input ? { path: toValue(input.path) } : {}),
                ...(input.page ? { page: toValue(input.page) } : {}),
                ...('q' in input ? { q: toValue(input.q) } : {}),
                ...(language.value ? { locale: language.value } : {}),
            } as LitiQueryOptions),
        )
        return resource(
            () => litiSnapshot([scope.value, language.value, snapshot.value.view, model, snapshot.value, instance?.()]),
            (signal, identity) => {
                const [, , , requestedModel, request] = JSON.parse(identity) as [
                    string,
                    string,
                    string,
                    string,
                    LitiQueryOptions,
                ]
                return options.client.query(requestedModel, { ...request, signal } as LitiQueryOptions)
            },
            undefined,
            immediate,
        )
    }

    const modelResource = (
        model: string,
        source: ReturnType<typeof query>,
        input: VueFormOptions = {},
        editorId?: Ref<string | null>,
        editorInstance?: () => string,
    ) => {
        const models = describe()
        const language = locale(input.locale)
        const id = editorId ?? shallowRef(toValue(input.id) ?? null)
        const generated = getCurrentInstance() ? useId() : crypto.randomUUID()
        const instance = editorInstance ?? (() => toValue(input.instance) ?? generated)
        watch(
            [() => toValue(input.id), instance, scope],
            ([value]) => {
                id.value = value ?? null
            },
            { flush: 'sync' },
        )
        const stateData = computed<LitiModelData<Record<string, unknown>>>({
            get: () => {
                const data = source.handle.data.value
                return Array.isArray(data)
                    ? { items: data, total: data.length, limit: data.length, offset: 0 }
                    : (data as LitiModelData<Record<string, unknown>>)
            },
            set: (value) => {
                source.handle.data.value = value && 'items' in value ? value.items : value
            },
        })
        const descriptor = computed(() => (models.handle.data.value as LitiDescriptor | undefined)?.models[model])
        const localStatus = shallowRef(source.handle.status.value)
        const localError = shallowRef(source.handle.error.value)
        watch(
            [source.handle.status, source.handle.error],
            ([status, error]) => {
                if (error || status === 'pending') localError.value = error
                localStatus.value = localError.value ? 'error' : status
            },
            { flush: 'sync' },
        )
        const actions = createLitiModel(
            {
                data: stateData,
                status: localStatus,
                error: localError,
                refresh: source.ensure,
            },
            {
                model,
                descriptor,
                id,
                identity: () =>
                    'liti-management:' +
                    JSON.stringify([
                        'vue',
                        'client',
                        scope.value,
                        'form',
                        model,
                        toValue(input.id) ?? null,
                        language.value ?? null,
                        instance(),
                    ]),
                scope,
                group: () => JSON.stringify([scope.value, model, toValue(input.id) ?? null, instance()]),
                instance,
                locale: language,
                client: management(model),
                drafts,
                ...(options.bridge.descriptor.i18n?.defaultLocale
                    ? { defaultLocale: options.bridge.descriptor.i18n.defaultLocale }
                    : {}),
                ...(options.prepare ? { prepare: options.prepare } : {}),
            },
        )
        return {
            actions,
            models,
            resource: { ...source.handle, ...actions, data: stateData, refresh: source.handle.refresh },
        }
    }

    return {
        models() {
            const source = describe()
            const projection = projectQuery(source.handle, {}, {}, (value) => litiModelCatalog(value as LitiDescriptor))
            const handle = {
                ...projection.handle,
                data: readonly(projection.handle.data) as Readonly<Ref<ReturnType<typeof litiModelCatalog>>>,
            }
            return Object.assign(
                source.ready().then(() => handle),
                handle,
            )
        },
        query(
            model: string,
            input: ReactiveLitiQueryOptions & {
                immediate?: boolean
                transform?: (data: unknown) => unknown
                default?: () => unknown
                pick?: readonly string[]
            } = {},
        ) {
            const { transform, default: initial, pick, immediate, ...queryInput } = input
            const source = query(model, queryInput, immediate !== false)
            const projection = projectQuery(source.handle, input.mode === 'one' ? null : [], {
                ...(transform ? { transform } : {}),
                ...(initial ? { default: initial } : {}),
                ...(pick ? { pick } : {}),
            })
            const operations =
                input.view === 'current'
                    ? modelResource(model, source, input.mode === 'one' ? { id: input.id } : {}).actions
                    : undefined
            const handle = { ...projection.handle, ...(operations ? { remove: operations.remove } : {}) }
            return Object.assign(
                source.ready().then(async () => {
                    await projection.ready()
                    return handle
                }),
                handle,
            )
        },
        form(model: string, input: VueFormOptions = {}) {
            const id = shallowRef(toValue(input.id) ?? null)
            const generated = getCurrentInstance() ? useId() : crypto.randomUUID()
            const instance = () => toValue(input.instance) ?? generated
            const source = query(
                model,
                { mode: 'one', view: 'current', id: () => id.value, ...(input.locale ? { locale: input.locale } : {}) },
                true,
                () => (id.value ? undefined : instance()),
            )
            const { resource: modelState, models } = modelResource(model, source, input, id, instance)
            const form = useEntryForm(modelState, input)
            const handle = { ...modelState, ...form }
            return Object.assign(
                Promise.all([source.ready(), models.ready()]).then(() => handle),
                handle,
            )
        },
    }
}
