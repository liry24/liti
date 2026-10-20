import { createLitiDescriptor } from '../packages/liti/src/descriptor'
import {
    generatedRuntimeSource,
    nativeNuxtDependencies,
    nativeNuxtHash,
    nativeRuntimeSource,
    readNuxtSource,
} from './nuxt-native-runtime'
import { modelEntry as modelRecord } from './model-fixture'
import { createError } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
    createPublicClient,
    createLitiManagementClient,
    presentLitiData,
    LitiClientError,
    type LitiManagementClient,
    type LitiClientOptions,
} from '../packages/liti/src/client'
import { defineLitiConfig, image, text } from '../packages/liti/src'
import { litiNuxtClientTemplate } from '../packages/nuxt/src/nuxt/client-templates'
import { normalizeLitiQuery } from '../packages/liti/src/query'
import { litiModelCatalog } from '../packages/liti/src/admin-client'
import { projectQuery, queryTotal } from '../packages/vue/src/query'
import { useEntryForm } from '../packages/vue/src/form'
import { createLitiModel, litiModelError, type LitiModel } from '../packages/vue/src/model'

interface State {
    data: Vue.Ref<unknown>
    status: Vue.Ref<string>
    error: Vue.Ref<unknown>
    execute(options?: { signal?: AbortSignal; dedupe?: 'cancel' | 'defer' }): Promise<void>
    clear(): void
    refresh(options?: { cachedData?: unknown; signal?: AbortSignal; dedupe?: 'cancel' | 'defer' }): Promise<void>
}
interface Helpers {
    useLitiQuery(model: string, options?: Record<string, unknown>): State & Promise<State> & { total: Vue.Ref<number> }
    useLitiForm(model: string, options?: Record<string, unknown>): Promise<FormResource> & FormResource
    litiManagementKey(
        connection: import('../packages/liti/src/client').LitiManagementClientOptions,
        scope: string,
        operation: string,
        model: string | null,
        identity: unknown,
        locale?: string,
    ): string
    litiManagementClientOptions(): import('../packages/liti/src/client').LitiManagementClientOptions
    useAi(name: string, options: Record<string, unknown>): State & Promise<State>
    modelList(model: string, options?: Record<string, unknown>): State
    modelEntry(model: string, id: Vue.MaybeRefOrGetter<string>, options?: Record<string, unknown>): State
    publicList(model: string, options?: Record<string, unknown>): State
    publicEntry(model: string, id: string, options?: Record<string, unknown>): State
    publicBatch(requests: Record<string, unknown>, options?: Record<string, unknown>): State
    useLitiManagementClient(): LitiManagementClient<Record<string, Record<string, unknown>>>
    createNuxtLitiManagementClient(
        connection: {
            origin: string
            basePath: string
            fetch: NonNullable<LitiClientOptions['fetch']>
            credentials?: RequestCredentials
        },
        auth: Vue.MaybeRefOrGetter<string>,
    ): LitiManagementClient<Record<string, Record<string, unknown>>>
}

type FormResource = ReturnType<typeof useEntryForm<Record<string, unknown>>> &
    Pick<State, 'data' | 'status' | 'error' | 'refresh'>

const nativeEnvironment = async (
    request: NonNullable<LitiClientOptions['fetch']>,
    { i18n = false, aiActions = false, serverFetch = false, serverRuntime = false } = {},
) => {
    const native = nativeRuntimeSource(await readNuxtSource('composables/asyncData.js'), {
        serverRuntime,
        asyncData: true,
    })
    const hooks = new Map<string, Set<(...args: unknown[]) => unknown>>()
    const hook = (name: string, callback: (...args: unknown[]) => unknown) => {
        const callbacks = hooks.get(name) ?? new Set()
        callbacks.add(callback)
        hooks.set(name, callbacks)
        return () => {
            callbacks.delete(callback)
        }
    }
    const app = {
        $i18n: { locale: Vue.ref('ja') },
        _asyncData: Vue.shallowReactive({}),
        _asyncDataPromises: {},
        payload: {
            data: Vue.shallowReactive({} as Record<string, unknown>),
            _errors: Vue.shallowReactive({}),
            serverRendered: serverRuntime,
        },
        static: { data: {} as Record<string, unknown> },
        isHydrating: false,
        hook,
        hooks: {
            callHookParallel: async (name: string, ...args: unknown[]) => {
                await Promise.all([...(hooks.get(name) ?? [])].map((callback) => callback(...args)))
            },
        },
        callHook: async () => {},
        runWithContext: <Value>(callback: () => Value): Value => callback(),
    }
    const nativeDependencies = {
        ...(await nativeNuxtDependencies(app)),
        onNuxtReady: (callback: () => void) => callback(),
        toArray: (value: unknown) => (Array.isArray(value) ? value : [value]),
        defineKeyedFunctionFactory: (options: { factory: unknown }) => options.factory,
        hashKey: await nativeNuxtHash(),
        isPlainObject: (value: unknown) => Object.prototype.toString.call(value) === '[object Object]',
        alwaysRunFetchOnKeyChange: false,
        fetchDefaults: {},
        routeTypedFetch: false,
        $fetch: async (url: string, options: RequestInit) => {
            const response = await request(new URL(url, 'http://site.test'), {
                ...options,
                body: JSON.stringify(options.body),
            })
            if (!response.ok) throw createError({ statusCode: response.status, data: await response.json() })
            return response.json()
        },
    }
    const fetchSource = nativeRuntimeSource(await readNuxtSource('composables/fetch.js'), {
        serverRuntime,
    })
    const addonsSource = nativeRuntimeSource(await readNuxtSource('composables/addons.js'), {
        serverRuntime,
    })
    const runtime = new Function(
        ...Object.keys(nativeDependencies),
        `${native}\n${addonsSource}\n${fetchSource}; return { useAsyncData, clearNuxtData, refreshNuxtData, useNuxtData, createUseFetch, defineUseFetchAddon }`,
    )(...Object.values(nativeDependencies)) as Record<string, unknown>
    const generated = generatedRuntimeSource(
        litiNuxtClientTemplate({
            basePath: '/content',
            managementBase: '/manage',
            i18n,
            actions: aiActions,
        }),
        { serverFetch, asyncData: true },
    )
    let managementFactories = 0
    let requestFetches = 0
    const states = new Map<string, Vue.Ref<unknown>>()
    const dependencies = {
        normalizeLitiQuery,
        litiModelCatalog,
        projectQuery,
        queryTotal,
        useEntryForm,
        createLitiModel,
        litiModelError,
        useRoute: () => ({ path: '/' }),
        useState: (key: string, initialize: () => unknown) => {
            if (!states.has(key)) states.set(key, Vue.ref(initialize()))
            return states.get(key)!
        },
        ...nativeDependencies,
        ...runtime,
        litiAsyncData: runtime.useAsyncData,
        createPublicClient,
        createLitiManagementClient: (...args: Parameters<typeof createLitiManagementClient>) => {
            managementFactories += 1
            return createLitiManagementClient(...args)
        },
        presentLitiData,
        LitiClientError,
        useNuxtApp: () => app,
        useRequestURL: () => new URL('http://site.test'),
        useRequestFetch: () => {
            requestFetches += 1
            return async (
                url: string,
                options: RequestInit & { onResponse: (context: { response: Response }) => void },
            ) => {
                const response = await request(new URL(url, 'http://site.test'), options)
                options.onResponse({ response })
                return response
            }
        },
        globalThis: { fetch: request },
    }
    const helpers = new Function(
        ...Object.keys(dependencies),
        `${generated}; return { ${aiActions ? 'useAi,' : ''} useLitiForm, litiAttachAsyncData, useLitiQuery, useLitiModels, modelList: composables.useManagedSource, modelEntry: (model, id, opts) => composables.useManagedSource(model, { ...opts, id }), publicEntry: (model, id, opts) => useLitiQuery(model, { ...opts, mode: 'one', id }), publicList: useLitiQuery, publicBatch: composables.usePublishedSource, createNuxtLitiManagementClient, litiManagementClientOptions, useLitiModels, litiReadModels, litiManagementKey, useLitiAuthScope }`,
    )(...Object.values(dependencies)) as Helpers
    return {
        app,
        helpers,
        setRouteResult: (value: unknown) => {
            const route = states.get('liti-route')
            if (route) route.value = value
            else states.set('liti-route', Vue.ref(value))
        },
        refreshSubscribers: () => hooks.get('app:data:refresh')?.size ?? 0,
        managementFactories: () => managementFactories,
        requestFetches: () => requestFetches,
    }
}
const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Vue.nextTick()
}

it.each(['published', 'current'])(
    'keeps native Nuxt %s pagination totals separate from transformed data',
    async (view) => {
        const page = Vue.ref({ limit: 1, offset: 0 })
        const requests: string[] = []
        const { helpers } = await nativeEnvironment(async (input) => {
            const url = new URL(String(input), 'http://site.test')
            if (url.pathname.endsWith('/models'))
                return Response.json(
                    createLitiDescriptor(defineLitiConfig({ models: { posts: { fields: { title: text() } } } })),
                )
            requests.push(url.href)
            const offset = Number(url.searchParams.get('offset'))
            return Response.json({
                items: [
                    view === 'current'
                        ? modelRecord(`entry-${offset}`, 1, { title: String(offset) })
                        : {
                              data: { _liti: { id: `entry-${offset}`, model: 'posts' }, title: String(offset) },
                          },
                ],
                total: 37,
                limit: 1,
                offset,
            })
        })
        const scope = Vue.effectScope()
        const handle = scope.run(() =>
            helpers.useLitiQuery('posts', {
                view,
                page,
                transform: (rows: Array<{ data: { title: string } }>) => rows.map((row) => row.data.title),
            }),
        )!
        try {
            const { total } = handle
            expect(total.value).toBe(0)
            await handle
            expect(handle.total).toBe(total)
            expect(handle.data.value).toEqual(['0'])
            expect(total.value).toBe(37)
            page.value = { limit: 1, offset: 1 }
            await flush()
            expect(handle.data.value).toEqual(['1'])
            expect(total.value).toBe(37)
            expect(requests.every((url) => url.includes('limit=1'))).toBe(true)
            handle.clear()
            expect(total.value).toBe(0)
        } finally {
            scope.stop()
        }
    },
)
const settles = async (pending: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            pending.then(() => true),
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), 100)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}
const cancelledSignals = [
    ['AbortSignal.abort()', () => AbortSignal.abort()],
    [
        'an already-aborted controller',
        () => {
            const controller = new AbortController()
            controller.abort()
            return controller.signal
        },
    ],
    ['a string reason', () => AbortSignal.abort('Cancelled')],
    ['a custom non-Error reason', () => AbortSignal.abort({ cancelled: true })],
] as const
describe('native createUseFetch AI actions', () => {
    describe.each(['execute', 'refresh'] as const)('%s cancellation', (method) => {
        it.each(cancelledSignals)(
            'settles %s before execution and permits a subsequent defer retry',
            async (_, signal) => {
                let calls = 0
                const { helpers } = await nativeEnvironment(
                    async () => {
                        calls++
                        return Response.json({ data: 'Retried' })
                    },
                    { aiActions: true },
                )
                const scope = Vue.effectScope()
                // Exercise extensions on the awaited instance, as used by async component setup.
                const state = await scope.run(() =>
                    helpers.useAi('plain', { input: { content: 'A' }, immediate: false }),
                )!
                try {
                    await state.execute()
                    expect(state.status.value).toBe('success')
                    expect(await settles(state[method]({ signal: signal() }))).toBe(true)
                    expect(state.status.value).toBe('idle')
                    expect(state.error.value).toBeUndefined()
                    expect(state.data.value).toBeUndefined()
                    expect(calls).toBe(1)
                    expect(await settles(state.execute())).toBe(true)
                    expect(state.status.value).toBe('success')
                    expect(calls).toBe(2)
                } finally {
                    state.clear()
                    scope.stop()
                }
            },
        )
    })
    it('does not invoke transport for pre-aborted initial execution or interrupt a healthy deferred request', async () => {
        let calls = 0
        let complete!: () => void
        let transport: AbortSignal | undefined
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                transport = init?.signal ?? undefined
                await new Promise<void>((resolve) => {
                    complete = resolve
                })
                return Response.json({ data: 'Completed' })
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        // Also exercise extensions on the unawaited native composable return.
        const state = scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, immediate: false }))!
        try {
            expect(await settles(state.execute({ signal: AbortSignal.abort() }))).toBe(true)
            expect(state.status.value).toBe('idle')
            expect(calls).toBe(0)
            const first = state.execute()
            expect(await settles(state.execute({ signal: AbortSignal.abort('Cancelled') }))).toBe(true)
            expect(state.status.value).toBe('pending')
            expect(transport?.aborted).toBe(false)
            expect(calls).toBe(1)
            complete()
            expect(await settles(first)).toBe(true)
            expect(state.data.value).toBe('Completed')
        } finally {
            complete?.()
            state.clear()
            scope.stop()
        }
    })
    it.each([
        ['default AbortError', undefined, 'idle'],
        ['explicit AbortError', new DOMException('Cancelled', 'AbortError'), 'idle'],
        ['string reason', 'Cancelled', 'idle'],
        ['custom non-Error reason', { cancelled: true }, 'idle'],
        ['custom Error reason', new Error('Stopped'), 'error'],
    ] as const)('settles in-flight %s, aborts transport and permits retry', async (_description, reason, status) => {
        let calls = 0
        let transport: AbortSignal | undefined
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                if (calls === 1) {
                    transport = init?.signal ?? undefined
                    await new Promise<void>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                            once: true,
                        })
                    })
                }
                return Response.json({ data: 'Retried' })
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const state = await scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, immediate: false }))!
        try {
            const controller = new AbortController()
            const pending = state.execute({ signal: controller.signal })
            controller.abort(reason)
            expect(transport?.aborted).toBe(true)
            expect(await settles(pending)).toBe(true)
            expect(state.status.value).toBe(status)
            if (status === 'idle') expect(state.error.value).toBeUndefined()
            else expect(state.error.value).toMatchObject({ message: 'Stopped' })
            expect(await settles(state.execute())).toBe(true)
            expect(calls).toBe(2)
            expect(state.data.value).toBe('Retried')
            expect(state.status.value).toBe('success')
        } finally {
            state.clear()
            scope.stop()
        }
    })
    it('settles synchronous abort before middleware begins and allows retry', async () => {
        let calls = 0
        const { helpers } = await nativeEnvironment(
            async () => {
                calls++
                return Response.json({ data: 'Retried' })
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const state = await scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, immediate: false }))!
        const controller = new AbortController()
        const stop = Vue.watch(
            state.status,
            (status) => {
                if (status === 'pending') controller.abort('Cancelled')
            },
            { flush: 'sync' },
        )
        try {
            expect(await settles(state.execute({ signal: controller.signal }))).toBe(true)
            expect(state.status.value).toBe('idle')
            expect(calls).toBe(0)
            stop()
            expect(await settles(state.execute())).toBe(true)
            expect(calls).toBe(1)
            expect(state.status.value).toBe('success')
        } finally {
            stop()
            state.clear()
            scope.stop()
        }
    })
    it('retains native timeout and pre-aborted Error state and permits retry', async () => {
        let calls = 0
        let transport: AbortSignal | undefined
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                if (calls === 1) {
                    transport = init?.signal ?? undefined
                    await new Promise<void>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                            once: true,
                        })
                    })
                }
                return Response.json({ data: 'Retried' })
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const state = await scope.run(() =>
            helpers.useAi('plain', { input: { content: 'A' }, immediate: false, timeout: 5 }),
        )!
        try {
            expect(await settles(state.execute({ signal: AbortSignal.abort(new Error('Stopped')) }))).toBe(true)
            expect(calls).toBe(0)
            expect(state.status.value).toBe('error')
            expect(state.error.value).toMatchObject({ message: 'Stopped' })
            expect(await settles(state.execute())).toBe(true)
            expect(transport?.aborted).toBe(true)
            expect(state.status.value).toBe('error')
            expect(state.error.value).toMatchObject({ cause: { name: 'TimeoutError' } })
            expect(await settles(state.execute())).toBe(true)
            expect(calls).toBe(2)
            expect(state.status.value).toBe('success')
        } finally {
            state.clear()
            scope.stop()
        }
    })
    it('executes only explicitly with fixed POST/watch/retry and snapshots reactive input', async () => {
        const bodies: unknown[] = []
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                bodies.push(JSON.parse(String(init?.body)))
                expect(init?.method?.toLowerCase()).toBe('post')
                return Response.json({ data: { content: 'Corrected' } })
            },
            { aiActions: true },
        )
        const input = Vue.ref({ content: 'First' })
        const scope = Vue.effectScope()
        const state = scope.run(() =>
            helpers.useAi('proofread', { input, immediate: false, method: 'GET', retry: 3, watch: true }),
        )!
        await state
        input.value.content = 'Second'
        await flush()
        expect(bodies).toHaveLength(0)
        const pending = state.execute()
        input.value.content = 'Third'
        await pending
        expect(bodies).toEqual([{ input: { content: 'Second' } }])
        await flush()
        expect(bodies).toHaveLength(1)
        await state.execute()
        expect(state.data.value).toEqual({ content: 'Corrected' })
        scope.stop()
    })
    it('isolates different inputs and auth scopes, hydrates without inference twice', async () => {
        let calls = 0
        const { app, helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                return Response.json({ data: JSON.parse(String(init?.body)).input.content })
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const auth = Vue.ref('alice')
        const a = scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, authScope: auth }))!
        const b = scope.run(() => helpers.useAi('plain', { input: { content: 'B' }, authScope: auth }))!
        await Promise.all([a, b])
        expect(calls).toBe(0)
        await Promise.all([a.execute(), b.execute()])
        expect(a.data.value).toBe('A')
        expect(b.data.value).toBe('B')
        expect(calls).toBe(2)
        app.isHydrating = true
        app.payload.serverRendered = true
        const hydrated = scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, authScope: 'alice' }))!
        await hydrated
        expect(hydrated.data.value).toBe('A')
        expect(calls).toBe(2)
        app.isHydrating = false
        auth.value = 'bob'
        await flush()
        expect(a.data.value).toBeUndefined()
        expect(calls).toBe(2)
        await a.execute()
        expect(calls).toBe(3)
        scope.stop()
    })
    it('keeps failures in native error/status and supports cancellation and concurrent dedupe', async () => {
        let calls = 0
        let complete!: () => void
        const { helpers } = await nativeEnvironment(
            async (_, init) => {
                calls++
                await new Promise<void>((resolve, reject) => {
                    complete = resolve
                    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                        once: true,
                    })
                })
                return Response.json({ error: { code: 'LITI_AI_FAILED' } }, { status: 502 })
            },
            { aiActions: true },
        )
        const scope = Vue.effectScope()
        const state = scope.run(() => helpers.useAi('plain', { input: { content: 'A' }, immediate: false }))!
        const first = state.execute()
        const duplicate = state.execute()
        expect(calls).toBe(1)
        complete()
        await Promise.all([first, duplicate])
        expect(state.status.value).toBe('error')
        expect(state.error.value).toMatchObject({ statusCode: 502 })
        const controller = new AbortController()
        const cancelled = state.execute({ signal: controller.signal })
        controller.abort(new DOMException('Cancelled', 'AbortError'))
        await cancelled
        expect(state.status.value).toBe('idle')
        expect(state.error.value).toBeUndefined()
        scope.stop()
    })
})
const modelDescriptor = createLitiDescriptor(
    defineLitiConfig({
        models: {
            posts: { fields: { slug: text(), title: text({ required: true }), image: image() } },
            authors: { fields: { slug: text(), title: text({ required: true }) } },
        },
    }),
)

it('preserves public query failure codes, status and issues in native Nuxt payload errors', async () => {
    const { helpers, app } = await nativeEnvironment(async () =>
        Response.json(
            {
                error: {
                    code: 'LITI_INVALID_QUERY',
                    message: 'Invalid selector.',
                    issues: [{ path: 'id', message: 'Invalid.' }],
                },
            },
            { status: 422 },
        ),
    )
    const scope = Vue.effectScope()
    try {
        const query = scope.run(() => helpers.publicEntry('posts', 'invalid', { immediate: false }))!
        await query.execute()
        expect(query.status.value).toBe('error')
        expect(query.error.value).toMatchObject({
            statusCode: 422,
            message: 'Invalid selector.',
            data: { code: 'LITI_INVALID_QUERY', issues: [{ path: 'id', message: 'Invalid.' }] },
        })
        const payload = JSON.stringify(app.payload._errors)
        expect(payload).toContain('LITI_INVALID_QUERY')
        expect(payload).not.toContain('"cause"')
        expect(payload).not.toContain('"stack"')
    } finally {
        scope.stop()
    }
})

describe('native management AsyncData and mutation invalidation', () => {
    it('isolates immediate forms, restores their saved identities, and resets on instance or actor changes', async () => {
        const records = new Map<string, ReturnType<typeof modelRecord>>()
        const writes: Array<{ method: string; id: string; title: unknown }> = []
        let descriptions = 0
        const { helpers } = await nativeEnvironment(async (input, init) => {
            const url = new URL(String(input))
            if (url.pathname === '/manage/models') {
                descriptions++
                return Response.json(modelDescriptor)
            }
            if (!init?.method || init.method === 'GET')
                return Response.json(records.get(url.pathname.split('/').at(-1)!))
            const body = JSON.parse(String(init.body))
            const id = init.method === 'POST' ? 'created-' + (records.size + 1) : url.pathname.split('/').at(-1)!
            const entry = modelRecord(id, (body.expectedVersion ?? 0) + 1, body.data)
            records.set(id, entry)
            writes.push({ method: init.method, id, title: body.data.title })
            return Response.json(entry)
        })
        const actor = Vue.ref('alice')
        const instance = Vue.ref('a')
        const firstScope = Vue.effectScope()
        const a = firstScope.run(() => helpers.useLitiForm('posts', { instance, authScope: actor }))!
        const secondScope = Vue.effectScope()
        const b = secondScope.run(() => helpers.useLitiForm('posts', { instance: 'b', authScope: actor }))!
        expect(a.form.Field).toBeDefined()
        expect((await a).form).toBe(a.form)
        await b
        expect(descriptions).toBe(1)
        a.form.setFieldValue('title', 'A')
        b.form.setFieldValue('title', 'B')
        await a.form.handleSubmit()
        expect(a.draft.snapshot().entryId).toBe('created-1')
        expect(b.draft.snapshot().entryId).toBeNull()
        expect(b.form.state.values.title).toBe('B')
        expect(b.error.value).toBeUndefined()
        instance.value = 'c'
        await flush()
        expect(a.draft.snapshot()).toMatchObject({ entryId: null, version: null })
        expect(a.form.state.values.title).toBe('')
        a.form.setFieldValue('title', 'C')
        await a.form.handleSubmit()
        expect(writes.map((write) => write.method)).toEqual(['POST', 'POST'])
        instance.value = 'a'
        await flush()
        expect(a.draft.snapshot().entryId).toBe('created-1')
        expect(a.form.state.values.title).toBe('A')
        firstScope.stop()
        const reopenedScope = Vue.effectScope()
        const reopened = reopenedScope.run(() => helpers.useLitiForm('posts', { instance, authScope: actor }))!
        await reopened
        expect(reopened.draft.snapshot().entryId).toBe('created-1')
        reopened.form.setFieldValue('title', 'A again')
        await reopened.form.handleSubmit()
        expect(writes.at(-1)).toEqual({ method: 'PATCH', id: 'created-1', title: 'A again' })
        actor.value = 'bob'
        await flush()
        expect(reopened.draft.snapshot()).toMatchObject({ entryId: null, version: null })
        expect(reopened.form.state.values.title).toBe('')
        expect(b.form.state.values.title).toBe('')
        actor.value = 'alice'
        await flush()
        expect(b.form.state.values.title).toBe('')
        reopenedScope.stop()
        secondScope.stop()
    })

    it('does not submit before loading and protects another form while an instance changes during a save', async () => {
        const descriptor = Promise.withResolvers<Response>()
        const save = Promise.withResolvers<Response>()
        let saves = 0
        let saveSignal: AbortSignal | null | undefined
        const { helpers } = await nativeEnvironment(async (input, init) => {
            if (new URL(String(input)).pathname === '/manage/models') return descriptor.promise
            saves++
            saveSignal = init?.signal
            return save.promise
        })
        const instance = Vue.ref('a')
        const scope = Vue.effectScope()
        const a = scope.run(() => helpers.useLitiForm('posts', { instance, defaultValues: { title: 'A' } }))!
        const b = scope.run(() => helpers.useLitiForm('posts', { instance: 'b', defaultValues: { title: 'B' } }))!
        await a.form.handleSubmit()
        expect(saves).toBe(0)
        descriptor.resolve(Response.json(modelDescriptor))
        await Promise.all([a, b])
        const pending = a.form.handleSubmit()
        await vi.waitFor(() => expect(saves).toBe(1))
        expect(b.status.value).toBe('success')
        instance.value = 'c'
        expect(saveSignal?.aborted).toBe(true)
        save.resolve(Response.json(modelRecord('late', 1, { title: 'Late response' })))
        await pending
        await flush()
        expect(a.draft.snapshot().entryId).toBeNull()
        expect(a.form.state.values.title).toBe('A')
        expect(a.error.value).toBeUndefined()
        expect(b.form.state.values.title).toBe('B')
        expect(b.error.value).toBeUndefined()
        scope.stop()
    })

    it('does not report a disposed form’s late failure into a reopened instance', async () => {
        const save = Promise.withResolvers<Response>()
        let saveSignal: AbortSignal | null | undefined
        const { helpers } = await nativeEnvironment(async (input, init) => {
            if (new URL(String(input)).pathname === '/manage/models') return Response.json(modelDescriptor)
            saveSignal = init?.signal
            return save.promise
        })
        const firstScope = Vue.effectScope()
        const first = firstScope.run(() => helpers.useLitiForm('posts', { instance: 'a' }))!
        await first
        first.form.setFieldValue('title', 'Kept draft')
        const pending = first.form.handleSubmit()
        await vi.waitFor(() => expect(saveSignal).toBeDefined())
        firstScope.stop()
        expect(saveSignal?.aborted).toBe(true)
        const nextScope = Vue.effectScope()
        const next = nextScope.run(() => helpers.useLitiForm('posts', { instance: 'a' }))!
        await next
        save.resolve(Response.json(modelRecord('late', 1, { title: 'Kept draft' })))
        await pending
        expect(next.error.value).toBeUndefined()
        expect(next.status.value).toBe('success')
        expect(next.draft.snapshot().entryId).toBeNull()
        expect(next.form.state.values.title).toBe('Kept draft')
        nextScope.stop()
    })

    it('keeps locale buffers within each instance and creates only that instance’s translations', async () => {
        const descriptor = structuredClone(modelDescriptor)
        descriptor.models.posts!.fields.title!.i18n = true
        let saved: ReturnType<typeof modelRecord> | undefined
        let input: Record<string, unknown> | undefined
        const { helpers } = await nativeEnvironment(async (url, init) => {
            if (new URL(String(url)).pathname === '/manage/models') return Response.json(descriptor)
            if (init?.method === 'POST') {
                input = JSON.parse(String(init.body))
                saved = { ...modelRecord('created'), ...input, defaultLocale: 'ja' }
            }
            return Response.json(saved)
        })
        const locale = Vue.ref('ja')
        const scope = Vue.effectScope()
        const a = scope.run(() => helpers.useLitiForm('posts', { instance: 'a', locale, defaultLocale: 'ja' }))!
        const b = scope.run(() => helpers.useLitiForm('posts', { instance: 'b', locale, defaultLocale: 'ja' }))!
        await Promise.all([a, b])
        a.form.setFieldValue('title', '原本 A')
        b.form.setFieldValue('title', '原本 B')
        locale.value = 'en'
        await flush()
        expect(a.form.state.values.title).toBe('原本 A')
        expect(b.form.state.values.title).toBe('原本 B')
        a.form.setFieldValue('title', 'English A')
        b.form.setFieldValue('title', 'English B')
        locale.value = 'ja'
        await flush()
        await a.form.handleSubmit()
        expect(input).toMatchObject({
            data: { title: '原本 A' },
            translations: { en: { title: 'English A' } },
        })
        expect(b.form.state.values.title).toBe('原本 B')
        locale.value = 'en'
        await flush()
        expect(b.form.state.values.title).toBe('English B')
        scope.stop()
    })

    it('refreshes another instance of the saved entry without overwriting its dirty input', async () => {
        let record = modelRecord('one', 1, { title: 'Original' })
        const { helpers } = await nativeEnvironment(async (input, init) => {
            if (new URL(String(input)).pathname === '/manage/models') return Response.json(modelDescriptor)
            if (init?.method === 'PATCH') record = modelRecord('one', 2, JSON.parse(String(init.body)).data)
            return Response.json(record)
        })
        const scope = Vue.effectScope()
        const a = scope.run(() => helpers.useLitiForm('posts', { id: 'one', instance: 'a' }))!
        const b = scope.run(() => helpers.useLitiForm('posts', { id: 'one', instance: 'b' }))!
        await Promise.all([a, b])
        a.form.setFieldValue('title', 'Saved A')
        b.form.setFieldValue('title', 'Unsaved B')
        await a.form.handleSubmit()
        expect(a.draft.snapshot().version).toBe(2)
        expect(b.form.state.values.title).toBe('Unsaved B')
        expect(b.error.value).toMatchObject({ data: { code: 'LITI_CONFLICT' } })
        expect(a.error.value).toBeUndefined()
        scope.stop()
    })

    it('fills a form created before the awaited entry during SSR', async () => {
        const { helpers } = await nativeEnvironment(
            async (input) => {
                const path = new URL(String(input)).pathname
                return Response.json(
                    path === '/manage/models' ? modelDescriptor : modelRecord('one', 3, { title: 'Loaded during SSR' }),
                )
            },
            { serverRuntime: true },
        )
        const html = await renderToString(
            Vue.createSSRApp({
                async setup() {
                    const { form, draft } = await helpers.useLitiForm('posts', { id: 'one' })
                    expect(draft.snapshot().version).toBe(3)
                    return () => Vue.h('div', String(form.state.values.title))
                },
            }),
        )
        expect(html).toBe('<div>Loaded during SSR</div>')
    })
    it('initializes a new form after its descriptor and owns unload protection until disposal', async () => {
        const requests: string[] = []
        const { helpers } = await nativeEnvironment(async (input) => {
            const path = new URL(String(input)).pathname
            requests.push(path)
            return Response.json(modelDescriptor)
        })
        const window = new EventTarget()
        vi.stubGlobal('window', window)
        const busy = Vue.ref(false)
        const renderer = Vue.createRenderer<object, object>({
            createComment: () => ({}),
            createElement: () => ({}),
            createText: () => ({}),
            insert: () => {},
            remove: () => {},
            parentNode: () => null,
            nextSibling: () => null,
            patchProp: () => {},
            setElementText: () => {},
            setText: () => {},
        })
        let controller: Awaited<ReturnType<Helpers['useLitiForm']>> | undefined
        const app = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                controller = await helpers.useLitiForm('posts', {
                                    defaultValues: { title: 'Default' },
                                    beforeUnload: busy,
                                })
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        const unload = () => {
            const event = new Event('beforeunload', { cancelable: true })
            Object.defineProperty(event, 'returnValue', {
                set: () => {
                    throw new Error('Deprecated returnValue was used')
                },
            })
            window.dispatchEvent(event)
            return event.defaultPrevented
        }
        try {
            app.mount({})
            await flush()
            expect(controller?.form.state.values.title).toBe('Default')
            expect(controller?.draft.isDirty.value).toBe(false)
            expect(requests).toEqual(['/manage/models'])
            expect(unload()).toBe(false)
            controller!.form.setFieldValue('title', 'Edited')
            expect(unload()).toBe(true)
            controller!.form.reset({ ...controller!.form.state.values, title: 'Default' })
            expect(unload()).toBe(false)
            busy.value = true
            expect(unload()).toBe(true)
            app.unmount()
            expect(unload()).toBe(false)
        } finally {
            app.unmount()
            vi.unstubAllGlobals()
        }
    })
    it('defers management entry/list descriptors until execution and shares the started read', async () => {
        const requests: string[] = []
        const { helpers, app } = await nativeEnvironment(async (input) => {
            const path = new URL(String(input)).pathname
            requests.push(path)
            if (path === '/manage/models') return Response.json(modelDescriptor)
            const entry = {
                defaultLocale: '',
                translations: {},
                id: path.split('/').at(-1),
                model: 'posts',
                data: { title: 'Deferred', image: 'asset' },
            }
            return Response.json(path === '/manage/entries' ? { items: [entry], total: 1 } : entry)
        })
        const scope = Vue.effectScope()
        const id = Vue.ref('one')
        const actor = Vue.ref('alice')
        const states = scope.run(() => ({
            entry: helpers.modelEntry('posts', id, { immediate: false, authScope: actor }),
            list: helpers.modelList('posts', { immediate: false, authScope: actor }),
        }))!
        await flush()
        id.value = 'two'
        actor.value = 'bob'
        await flush()
        expect(requests).toEqual([])
        expect(states.entry.status.value).toBe('idle')
        expect(states.list.status.value).toBe('idle')
        expect(Object.values(app.payload.data)).toEqual([])

        await Promise.all([states.entry.execute(), states.list.execute()])
        expect(requests.filter((path) => path === '/manage/models')).toHaveLength(1)
        expect(requests.filter((path) => path !== '/manage/models').sort()).toEqual([
            '/manage/entries',
            '/manage/entries/two',
        ])
        expect(states.entry.status.value).toBe('success')
        expect(states.list.status.value).toBe('success')
        expect((states.entry.data.value as { data: { image: { url: string } } }).data.image.url).toBe(
            'http://site.test/manage/assets/asset/content',
        )
        scope.stop()
    })

    describe.each(['entry', 'list'] as const)('SSR management %s native scheduling', (kind) => {
        it.each([
            ['deferred', { immediate: false }],
            ['client-only', { server: false }],
        ] as const)('keeps %s reads idle without descriptor requests or payload', async (_mode, options) => {
            const requests: string[] = []
            const { helpers, app } = await nativeEnvironment(
                async (input) => {
                    const path = new URL(String(input)).pathname
                    requests.push(path)
                    return Response.json(modelDescriptor)
                },
                { serverFetch: true, serverRuntime: true },
            )
            let state: State | undefined
            const html = await renderToString(
                Vue.createSSRApp({
                    setup() {
                        state =
                            kind === 'entry'
                                ? helpers.modelEntry('posts', 'one', options)
                                : helpers.modelList('posts', options)
                        return () => Vue.h('div', state!.status.value)
                    },
                }),
            )
            expect(html).toBe('<div>idle</div>')
            expect(state?.data.value).toBeUndefined()
            expect(requests).toEqual([])
            expect(app.payload.data).toEqual({})
        })
    })

    it('shares the descriptor after normal SSR entry/list execution starts', async () => {
        const requests: string[] = []
        const environment = await nativeEnvironment(
            async (input) => {
                const path = new URL(String(input)).pathname
                requests.push(path)
                if (path === '/manage/models') return Response.json(modelDescriptor)
                const entry = {
                    defaultLocale: '',
                    translations: {},
                    id: 'one',
                    model: 'posts',
                    data: { title: 'SSR', image: 'asset' },
                }
                return Response.json(path === '/manage/entries' ? { items: [entry], total: 1 } : entry)
            },
            { serverFetch: true, serverRuntime: true },
        )
        const html = await renderToString(
            Vue.createSSRApp({
                setup() {
                    const entry = environment.helpers.modelEntry('posts', 'one')
                    const list = environment.helpers.modelList('posts')
                    return () => Vue.h('div', entry.status.value + ':' + list.status.value)
                },
            }),
        )
        expect(html).toBe('<div>success:success</div>')
        expect(requests.filter((path) => path === '/manage/models')).toHaveLength(1)
        expect(requests.filter((path) => path !== '/manage/models').sort()).toEqual([
            '/manage/entries',
            '/manage/entries/one',
        ])
        expect(environment.requestFetches()).toBe(1)
    })

    it('reuses clients within a request and auth scope, separating transport identity and credentials', async () => {
        const request = async () => Response.json({ items: [], total: 0, limit: 50, offset: 0 })
        const environment = await nativeEnvironment(request)
        const auth = Vue.ref('alice')
        const connection = {
            origin: 'http://site.test',
            basePath: '/manage',
            fetch: request,
            credentials: 'same-origin' as RequestCredentials,
        }
        const a = environment.helpers.createNuxtLitiManagementClient(connection, auth)
        const b = environment.helpers.createNuxtLitiManagementClient({ ...connection }, auth)
        await Promise.all([a.listEntries('posts'), b.listEntries('posts')])
        expect(environment.managementFactories()).toBe(1)
        auth.value = 'bob'
        await a.listEntries('posts')
        expect(environment.managementFactories()).toBe(2)
        connection.credentials = 'omit'
        await a.listEntries('posts')
        expect(environment.managementFactories()).toBe(3)
        connection.credentials = 'same-origin'
        await a.listEntries('posts')
        expect(environment.managementFactories()).toBe(3)
        environment.helpers.createNuxtLitiManagementClient({ ...connection, fetch: async () => request() }, auth)
        expect(environment.managementFactories()).toBe(4)
        const otherRequest = await nativeEnvironment(request)
        otherRequest.helpers.createNuxtLitiManagementClient(connection, auth)
        expect(otherRequest.managementFactories()).toBe(1)
    })

    it('shares one native request-fetch wrapper per SSR app without retaining it across requests', async () => {
        const request = async () => Response.json(modelDescriptor)
        const first = await nativeEnvironment(request, { serverFetch: true })
        const a = first.helpers.litiManagementClientOptions()
        const b = first.helpers.litiManagementClientOptions()
        expect(a.fetch).toBe(b.fetch)
        expect(first.requestFetches()).toBe(1)
        await first.helpers
            .createNuxtLitiManagementClient(
                a as typeof a & { origin: string; basePath: string; fetch: NonNullable<LitiClientOptions['fetch']> },
                'alice',
            )
            .models()
        const second = await nativeEnvironment(request, { serverFetch: true })
        const c = second.helpers.litiManagementClientOptions()
        expect(c.fetch).not.toBe(a.fetch)
        expect(second.requestFetches()).toBe(1)
    })

    it('shares descriptors across parallel lists/entries and ID switches without aborting another consumer', async () => {
        const descriptorReply = Promise.withResolvers<Response>()
        let models = 0
        let modelSignal: AbortSignal | undefined
        const { helpers } = await nativeEnvironment(async (input, init) => {
            const url = new URL(String(input))
            if (url.pathname.endsWith('/models')) {
                models += 1
                modelSignal = init?.signal ?? undefined
                return descriptorReply.promise
            }
            const id = url.pathname.split('/').at(-1)!
            const record = {
                defaultLocale: '',
                translations: {},
                id,
                model: 'posts',
                locale: '',
                version: 1,
                data: { slug: id, title: id, image: 'asset' },
            }
            return Response.json(
                url.pathname === '/manage/entries' ? { items: [record], total: 1, limit: 50, offset: 0 } : record,
            )
        })
        const scope = Vue.effectScope()
        const id = Vue.ref('one')
        const states = scope.run(() => ({
            list: helpers.modelList('posts', { authScope: 'alice' }),
            entry: helpers.modelEntry('posts', id, { authScope: 'alice' }),
        }))!
        await flush()
        expect(models).toBe(1)
        id.value = 'two'
        await flush()
        expect(modelSignal?.aborted).toBe(false)
        descriptorReply.resolve(Response.json(modelDescriptor))
        await flush()
        expect((states.entry.data.value as { id: string }).id).toBe('two')
        expect(
            (states.list.data.value as { items: Array<{ data: { image: { url: string } } }> }).items[0]?.data.image.url,
        ).toBe('http://site.test/manage/assets/asset/content')
        expect(models).toBe(1)
        scope.stop()
    })

    it('rejects an old auth descriptor reply and loads the new scope without sharing its transport', async () => {
        const oldReply = Promise.withResolvers<Response>()
        const actor = Vue.ref('alice')
        let modelCalls = 0
        let oldSignal: AbortSignal | undefined
        const environment = await nativeEnvironment(async (input, init) => {
            if (String(input).endsWith('/models')) {
                modelCalls += 1
                if (modelCalls === 1) {
                    oldSignal = init?.signal ?? undefined
                    return oldReply.promise
                }
                return Response.json(modelDescriptor)
            }
            return Response.json({
                items: [
                    {
                        defaultLocale: '',
                        translations: {},
                        id: 'one',
                        model: 'posts',
                        data: { title: actor.value },
                    },
                ],
                total: 1,
            })
        })
        const scope = Vue.effectScope()
        const state = scope.run(() => environment.helpers.modelList('posts', { authScope: actor }))!
        await flush()
        expect(modelCalls).toBe(1)
        actor.value = 'bob'
        await flush()
        expect(oldSignal?.aborted).toBe(true)
        expect(modelCalls).toBe(2)
        expect(environment.managementFactories()).toBe(2)
        oldReply.resolve(Response.json({ models: {} }))
        await flush()
        expect(state.error.value).toBeUndefined()
        expect((state.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe('bob')
        expect(Object.keys(environment.app.payload.data).every((key) => !key.includes('alice'))).toBe(true)
        scope.stop()
    })

    it.each([401, 403, 404])('preserves descriptor status %s in typed management reads', async (status) => {
        let models = 0
        const { helpers } = await nativeEnvironment(async (input) => {
            if (String(input).endsWith('/models')) {
                models += 1
                return Response.json({ error: { code: 'DESCRIPTOR_FAILED', message: 'Denied' } }, { status })
            }
            return Response.json({ items: [], total: 0, limit: 50, offset: 0 })
        })
        const scope = Vue.effectScope()
        const state = scope.run(() => helpers.modelList('posts'))!
        await flush()
        expect(state.error.value).toMatchObject({ statusCode: status })
        expect(state.data.value).toBeUndefined()
        expect(models).toBe(1)
        scope.stop()
    })
    it('uses reactive i18n defaults for management and public helpers with explicit overrides', async () => {
        const urls: URL[] = []
        const { app, helpers } = await nativeEnvironment(
            async (input) => {
                const url = new URL(String(input))
                urls.push(url)
                if (url.pathname === '/manage/models') return Response.json(modelDescriptor)
                const entry = {
                    defaultLocale: '',
                    translations: {},
                    id: 'one',
                    model: 'posts',
                    locale: url.searchParams.get('locale') ?? '',
                    version: 1,
                    data: { slug: 'one', title: 'Title' },
                }
                if (url.pathname === '/manage/entries')
                    return Response.json({ items: [entry], total: 1, limit: 50, offset: 0 })
                if (url.pathname === '/manage/entries/one') return Response.json(entry)
                return Response.json([{ data: { _liti: { id: 'one', model: 'posts', slug: 'one' }, title: 'Public' } }])
            },
            { i18n: true },
        )
        const scope = Vue.effectScope()
        const explicit = Vue.ref('ja')
        const states = scope.run(() => ({
            list: helpers.modelList('posts'),
            entry: helpers.modelEntry('posts', 'one'),
            localized: helpers.modelList('posts', { locale: explicit }),
            public: helpers.publicList('posts'),
        }))!
        await flush()
        expect((states.entry.data.value as { locale: string }).locale).toBe('')
        expect((states.list.data.value as { items: unknown[] }).items).toHaveLength(1)
        expect(
            urls.filter((url) => url.pathname === '/manage/entries').map((url) => url.searchParams.get('locale')),
        ).toEqual(['ja'])
        expect(urls.find((url) => url.pathname === '/manage/entries/one')?.searchParams.get('locale')).toBeNull()
        expect(urls.find((url) => url.pathname === '/content/posts')?.searchParams.get('locale')).toBe('ja')
        const managementCount = urls.filter((url) => url.pathname.startsWith('/manage/')).length
        app.$i18n.locale.value = 'en'
        await flush()
        expect(urls.filter((url) => url.pathname.startsWith('/manage/')).length).toBeGreaterThan(managementCount)
        expect(
            urls
                .filter((url) => url.pathname === '/content/posts')
                .at(-1)
                ?.searchParams.get('locale'),
        ).toBe('en')
        explicit.value = 'en'
        await flush()
        expect(
            urls
                .filter((url) => url.pathname === '/manage/entries')
                .at(-1)
                ?.searchParams.get('locale'),
        ).toBe('en')
        scope.stop()
    })
    it('hydrates an ID-only form from its raw native payload without another descriptor or entry request', async () => {
        let requests = 0
        const { app, helpers } = await nativeEnvironment(async () => {
            requests += 1
            throw new Error('Hydration must use payload')
        })
        app.isHydrating = true
        app.payload.serverRendered = true
        const prefix = ['http://site.test', '/manage', 'alice']
        app.payload.data['liti-management:' + JSON.stringify([...prefix, 'models', null, null, null])] = modelDescriptor
        app.payload.data['liti-management:' + JSON.stringify([...prefix, 'entry', 'posts', 'one', null])] = {
            defaultLocale: '',
            translations: {},
            id: 'one',
            model: 'posts',
            locale: '',
            version: 3,
            data: { slug: 'one', title: 'Hydrated', image: 'asset' },
        }
        const renderer = Vue.createRenderer<object, object>({
            createComment: () => ({}),
            createElement: () => ({}),
            createText: () => ({}),
            insert: () => {},
            remove: () => {},
            parentNode: () => null,
            nextSibling: () => null,
            patchProp: () => {},
            setElementText: () => {},
            setText: () => {},
        })
        let controller: ReturnType<typeof useEntryForm<Record<string, unknown>>> | undefined
        const component = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                const [pending, restore] = (
                                    Vue as typeof Vue & {
                                        withAsyncContext: (fn: () => unknown) => [Promise<unknown>, () => void]
                                    }
                                ).withAsyncContext(() =>
                                    helpers.useLitiForm('posts', { id: 'one', authScope: 'alice' }),
                                )
                                const resource = await pending
                                restore()
                                controller = resource as Awaited<ReturnType<Helpers['useLitiForm']>>
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        component.mount({})
        await flush()
        expect(controller?.form.state.values.title).toBe('Hydrated')
        expect(controller?.draft.snapshot().version).toBe(3)
        expect(controller?.draft.isDirty.value).toBe(false)
        expect(requests).toBe(0)
        component.unmount()
    })
    it('aborts native ID getter loads and restores drafts across navigation, separating a changed actor', async () => {
        const id = Vue.ref('one')
        const actor = Vue.ref('alice')
        const slow = Promise.withResolvers<Response>()
        const started = Promise.withResolvers<void>()
        let slowSignal: AbortSignal | undefined
        const record = (entryId: string) => ({
            defaultLocale: '',
            translations: {},
            id: entryId,
            model: 'posts',
            locale: '',
            version: 1,
            data: { slug: entryId, title: actor.value + ' ' + entryId },
        })
        const { helpers } = await nativeEnvironment(async (input, init) => {
            const path = new URL(String(input)).pathname
            if (path.endsWith('/models')) return Response.json(modelDescriptor)
            const requestedId = path.split('/').at(-1)!
            if (requestedId === 'slow') {
                slowSignal = init?.signal ?? undefined
                started.resolve()
                return slow.promise
            }
            return Response.json(record(requestedId))
        })
        const renderer = Vue.createRenderer<object, object>({
            createComment: () => ({}),
            createElement: () => ({}),
            createText: () => ({}),
            insert: () => {},
            remove: () => {},
            parentNode: () => null,
            nextSibling: () => null,
            patchProp: () => {},
            setElementText: () => {},
            setText: () => {},
        })
        let controller: ReturnType<typeof useEntryForm<Record<string, unknown>>> | undefined
        const component = renderer.createApp({
            render: () =>
                Vue.h(Vue.Suspense, null, {
                    default: () =>
                        Vue.h({
                            async setup() {
                                const [pending, restore] = (
                                    Vue as typeof Vue & {
                                        withAsyncContext: (fn: () => unknown) => [Promise<unknown>, () => void]
                                    }
                                ).withAsyncContext(() =>
                                    helpers.modelEntry('posts', () => id.value, { authScope: actor }),
                                )
                                const resource = await pending
                                restore()
                                controller = useEntryForm(resource as LitiModel<Record<string, unknown>>)
                                return () => Vue.h('div')
                            },
                        }),
                }),
        })
        component.mount({})
        await flush()
        expect(controller?.form.state.values.title).toBe('alice one')
        controller!.form.setFieldValue('title', 'Unsaved one')
        await Vue.nextTick()
        id.value = 'slow'
        await started.promise
        id.value = 'two'
        await flush()
        expect(slowSignal?.aborted).toBe(true)
        slow.resolve(Response.json(record('slow')))
        await flush()
        expect(controller?.draft.snapshot().entryId).toBe('two')
        expect(controller?.form.state.values.title).toBe('alice two')
        id.value = 'one'
        await flush()
        expect(controller?.form.state.values.title).toBe('Unsaved one')
        actor.value = 'bob'
        await flush()
        expect(controller?.form.state.values.title).toBe('bob one')
        expect(controller?.draft.isDirty.value).toBe(false)
        component.unmount()
    })

    it('refreshes the same actor/model list, affected entry and dependent batch, preserving unrelated caches', async () => {
        let version = 1
        const calls: Record<string, number> = {}
        const request: NonNullable<LitiClientOptions['fetch']> = async (input, init) => {
            const url = new URL(String(input))
            const method = init?.method ?? 'GET'
            const key = method + ' ' + url.pathname + url.search
            calls[key] = (calls[key] ?? 0) + 1
            const model = url.searchParams.get('model') ?? (url.pathname.includes('/authors') ? 'authors' : 'posts')
            const record = (id = 'one') => ({
                id,
                model,
                version,
                locale: '',
                data: { slug: id, title: 'v' + version, image: 'asset' },
            })
            if (method === 'PATCH') {
                version += 1
                return Response.json(record())
            }
            if (url.pathname === '/manage/models') return Response.json(modelDescriptor)
            if (url.pathname === '/manage/entries')
                return Response.json({ items: [record()], total: 1, limit: 20, offset: 0 })
            if (url.pathname.startsWith('/manage/entries/'))
                return Response.json(record(url.pathname.split('/').at(-1)))
            const publicRecord = (id = 'one') => ({
                data: { _liti: { id, model, slug: id }, title: 'v' + version },
            })
            return Response.json(
                url.pathname.split('/').length === 3 ? [publicRecord()] : publicRecord(url.pathname.split('/').at(-1)),
            )
        }
        const { app, helpers } = await nativeEnvironment(request)
        const scope = Vue.effectScope()
        const active = scope.run(() => ({
            posts: helpers.modelList('posts', { authScope: 'alice' }),
            authors: helpers.modelList('authors', { authScope: 'alice' }),
            bob: helpers.modelList('posts', { authScope: 'bob' }),
            entry: helpers.modelEntry('posts', 'one', { authScope: 'alice' }),
            other: helpers.modelEntry('posts', 'two', { authScope: 'alice' }),
            batch: helpers.publicBatch({ posts: { list: 'posts' }, authors: { list: 'authors' } }),
        }))!
        await flush()
        expect(
            (active.posts.data.value as { items: Array<{ data: { image: { url: string } } }> }).items[0]?.data.image
                .url,
        ).toBe('http://site.test/manage/assets/asset/content')
        const before = { ...calls }
        const client = helpers.createNuxtLitiManagementClient(
            { origin: 'http://site.test', basePath: '/manage', fetch: request },
            Vue.ref('alice'),
        )
        await client.updateEntry('one', {
            data: { slug: 'saved', title: 'Saved' },
            expectedVersion: 1,
        })
        expect(calls['GET /manage/entries?model=posts&limit=20&offset=0']).toBe(
            (before['GET /manage/entries?model=posts&limit=20&offset=0'] ?? 0) + 1,
        )
        expect(calls['GET /manage/entries?model=authors&limit=20&offset=0']).toBe(
            before['GET /manage/entries?model=authors&limit=20&offset=0'],
        )
        expect(calls['GET /manage/entries/two']).toBe(before['GET /manage/entries/two'])
        expect(calls['GET /content/posts']).toBe((before['GET /content/posts'] ?? 0) + 1)
        expect(calls['GET /content/authors']).toBe((before['GET /content/authors'] ?? 0) + 1)
        expect((active.bob.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe('v1')
        expect((active.posts.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe(
            'v2',
        )
        const leaving = Vue.effectScope()
        leaving.run(() => helpers.modelList('posts', { authScope: 'alice', q: 'inactive' }))
        await flush()
        leaving.stop()
        const inactiveKey = Object.keys(app.payload.data).find((key) => key.includes('inactive'))!
        await client.updateEntry('one', {
            data: { slug: 'again', title: 'Again' },
            expectedVersion: 2,
        })
        expect(inactiveKey in app.payload.data).toBe(false)
        const returning = Vue.effectScope()
        const returned = returning.run(() => helpers.modelList('posts', { authScope: 'alice', q: 'inactive' }))!
        await flush()
        expect((returned.data.value as { items: Array<{ data: { title: string } }> }).items[0]?.data.title).toBe('v3')
        returning.stop()
        scope.stop()
    })

    it('does not subscribe during invalidation and stops refreshing public entry/batch after unmount', async () => {
        let reads = 0
        const request: NonNullable<LitiClientOptions['fetch']> = async (input, init) => {
            if (init?.method === 'PATCH') return Response.json({ id: 'one', model: 'posts', slug: 'new', version: 2 })
            reads += 1
            return Response.json({
                data: { _liti: { id: 'one', model: 'posts', slug: 'old' }, title: 'Public' },
            })
        }
        const { app, helpers, refreshSubscribers } = await nativeEnvironment(request)
        const scope = Vue.effectScope()
        scope.run(() => ({
            entry: helpers.publicEntry('posts', 'old'),
            batch: helpers.publicBatch({
                entry: { entry: 'posts', id: 'old' },
                second: { entry: 'posts', id: 'second' },
            }),
        }))
        await flush()
        const dependencies = () =>
            Object.values(app['_asyncData'] as Record<string, { _deps: number }>).map((value) => value['_deps'])
        expect(dependencies()).toEqual([1, 1])
        expect(refreshSubscribers()).toBe(2)
        const client = helpers.createNuxtLitiManagementClient(
            { origin: 'http://site.test', basePath: '/manage', fetch: request },
            'alice',
        )
        await client.updateEntry('one', { data: {}, expectedVersion: 1 })
        await client.updateEntry('one', { data: {}, expectedVersion: 2 })
        expect(dependencies()).toEqual([1, 1])
        expect(refreshSubscribers()).toBe(2)
        scope.stop()
        await flush()
        expect(dependencies()).toEqual([0, 0])
        expect(refreshSubscribers()).toBe(0)
        const before = reads
        await client.updateEntry('one', { data: {}, expectedVersion: 3 })
        expect(reads).toBe(before)
    })

    it('invalidates renamed entries when native transform/pick removes identity, within the affected model', async () => {
        let version = 1
        const reads: Record<string, number> = {}
        const request: NonNullable<LitiClientOptions['fetch']> = async (input, init) => {
            if (init?.method === 'PATCH') {
                version += 1
                return Response.json({ id: 'one', model: 'posts', slug: 'new', version })
            }
            const path = new URL(String(input)).pathname
            reads[path] = (reads[path] ?? 0) + 1
            return Response.json({
                data: {
                    _liti: {
                        id: 'one',
                        model: path.includes('authors') ? 'authors' : 'posts',
                        slug: 'old',
                    },
                    title: 'v' + version,
                },
            })
        }
        const { helpers } = await nativeEnvironment(request)
        const scope = Vue.effectScope()
        const active = scope.run(() => ({
            transformed: helpers.publicEntry('posts', 'old', {
                transform: (entry: { data: unknown }) => entry.data,
            }),
            picked: helpers.publicEntry('posts', 'picked', { pick: ['data'] }),
            authors: helpers.publicEntry('authors', 'old', {
                transform: (entry: { data: unknown }) => entry.data,
            }),
            batch: helpers.publicBatch(
                { entry: { entry: 'posts', id: 'batch-old' } },
                {
                    transform: (batch: { entry: { data: { data: unknown } } }) => ({
                        entry: { data: batch.entry.data.data },
                    }),
                },
            ),
        }))!
        await flush()
        const client = helpers.createNuxtLitiManagementClient(
            { origin: 'http://site.test', basePath: '/manage', fetch: request },
            'alice',
        )
        await client.updateEntry('one', { data: {}, expectedVersion: 1 })
        expect(reads['/content/posts/old']).toBe(2)
        expect(reads['/content/posts/picked']).toBe(2)
        expect(reads['/content/posts/batch-old']).toBe(2)
        expect(reads['/content/authors/old']).toBe(1)
        expect((active.transformed.data.value as { title: string }).title).toBe('v2')
        scope.stop()
    })
})

it('reuses the same-origin route entry before public native transformations', async () => {
    let reads = 0
    const environment = await nativeEnvironment(async () => {
        reads++
        return Response.json({ ...modelRecord('two'), data: { title: 'Fetched' } })
    })
    const raw = { ...modelRecord('one'), data: { title: 'Resolved' } }
    environment.setRouteResult({ kind: 'page', path: '/', origin: 'http://site.test', entry: raw })
    const scope = Vue.effectScope()
    const entry = scope.run(() =>
        environment.helpers.publicEntry('posts', 'one', {
            transform: (value: { data: { title: string } }) => value.data.title,
        }),
    )!
    await entry.execute({ dedupe: 'defer' })
    expect(entry.data.value).toBe('Resolved')
    expect(raw.data.title).toBe('Resolved')
    expect(reads).toBe(0)
    const other = scope.run(() => environment.helpers.publicEntry('posts', 'two'))!
    await other.execute({ dedupe: 'defer' })
    expect(reads).toBe(1)
    scope.stop()
})

it('preserves a management snapshot on refresh failure and corrects a deleted last page', async () => {
    const page = Vue.ref(2)
    let total = 21
    let fail = false
    const environment = await nativeEnvironment(async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/models')) return Response.json(modelDescriptor)
        if (init?.method === 'DELETE') {
            total = 20
            return new Response(null, { status: 204, headers: { 'x-liti-model': 'posts' } })
        }
        if (fail)
            return Response.json({ error: { code: 'LITI_STORAGE_UNAVAILABLE', message: 'Try later' } }, { status: 503 })
        const offset = Number(url.searchParams.get('offset'))
        return Response.json({
            items: offset >= total ? [] : [modelRecord('one')],
            total,
            limit: 20,
            offset,
        })
    })
    const scope = Vue.effectScope()
    const source = scope.run(() => environment.helpers.modelList('posts', { page }))! as State & {
        remove: (entry: ReturnType<typeof modelRecord>) => Promise<unknown>
    }
    await source.execute({ dedupe: 'defer' })
    fail = true
    await source.refresh()
    expect(source.status.value).toBe('error')
    expect(source.error.value).toMatchObject({ data: { code: 'LITI_STORAGE_UNAVAILABLE' } })
    expect(source.data.value).toMatchObject({ total: 21, items: [{ id: 'one' }] })
    fail = false
    await source.remove(modelRecord('one'))
    expect(page.value).toBe(1)
    expect(source.data.value).toMatchObject({ total: 20, offset: 0 })
    expect(source.status.value).toBe('success')
    scope.stop()
})
