import { computed, toValue, useId, type MaybeRefOrGetter, type Ref } from 'vue'
import { useAsyncData, useNuxtApp, useRequestFetch } from '#app'
import type { Entry, ModelName, Page, QueryOptions } from '../../nuxt/types'
import { litiBaseURL } from './context'

type QuerySelection<Mode extends 'one' | 'many', Fallback extends boolean> = Omit<
    QueryOptions,
    'locale' | 'fallback'
> & {
    mode?: Mode
    id?: MaybeRefOrGetter<string | null | undefined>
    path?: MaybeRefOrGetter<string | undefined>
    locale?: MaybeRefOrGetter<string | undefined>
    signal?: AbortSignal
    timeout?: number
    immediate?: boolean
    key?: string
    fallback?: Fallback
}
type QueryValue<Name extends ModelName, Mode, Fallback extends boolean> = Mode extends 'one'
    ? Entry<Name, Fallback> | null
    : Entry<Name, Fallback>[]

export function useLitiQuery<
    Name extends ModelName,
    Mode extends 'one' | 'many' = 'many',
    Fallback extends boolean = true,
    Data = QueryValue<Name, Mode, Fallback>,
>(
    model: Name,
    options: QuerySelection<Mode, Fallback> & {
        transform?: (value: QueryValue<Name, Mode, Fallback>) => Data | Promise<Data>
        default?: () => NoInfer<Data>
    } = {},
) {
    const nuxt = useNuxtApp(),
        request = useRequestFetch(),
        base = litiBaseURL()
    const instance = useId()
    const locale = computed(
        () => toValue(options.locale) ?? toValue((nuxt.$i18n as { locale?: Ref<string> } | undefined)?.locale),
    )
    const input = computed(() => ({
        model,
        mode: options.mode ?? 'many',
        ...(locale.value ? { locale: locale.value } : {}),
        ...(toValue(options.id) ? { id: toValue(options.id)! } : {}),
        ...(toValue(options.path) ? { path: toValue(options.path)! } : {}),
        ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        ...(options.filter === undefined ? {} : { filter: JSON.stringify(options.filter) }),
    }))
    const scope =
        options.key ?? (options.transform || options.signal || options.timeout !== undefined ? instance : 'shared')
    const key = computed(() => `liti:public:${JSON.stringify(input.value)}:${scope}`)
    const resource = useAsyncData(
        key,
        async (_app, { signal }) => {
            const requestKey = key.value
            if (options.mode === 'one' && !input.value.id && !input.value.path) {
                const empty = null as QueryValue<Name, Mode, Fallback>
                return {
                    key: requestKey,
                    value: options.transform ? await options.transform(empty) : (empty as Data),
                    total: 0,
                }
            }
            const signals = [signal, ...(options.signal ? [options.signal] : [])]
            if (options.timeout !== undefined) signals.push(AbortSignal.timeout(options.timeout))
            const response = await request<Page<Entry<Name, Fallback>> | Entry<Name, Fallback> | null>(base, {
                query: input.value,
                signal: signals.length === 1 ? signal : AbortSignal.any(signals),
            })
            const page = options.mode !== 'one' ? (response as Page<Entry<Name, Fallback>>) : null
            const selected = (page ? page.items : response) as QueryValue<Name, Mode, Fallback>
            return {
                key: requestKey,
                value: options.transform ? await options.transform(selected) : (selected as Data),
                total: page?.total ?? (response ? 1 : 0),
            }
        },
        { immediate: options.immediate ?? true },
    )
    const fallback = () => (options.default ? options.default() : ((options.mode === 'one' ? null : []) as Data))
    const current = computed(() => (resource.data.value?.key === key.value ? resource.data.value : undefined))
    const handle = {
        data: computed(() => (current.value ? current.value.value : fallback())),
        total: computed(() => current.value?.total ?? 0),
        status: resource.status,
        pending: resource.pending,
        error: resource.error,
        refresh: resource.refresh,
        execute: resource.execute,
        clear: resource.clear,
    }
    return Object.assign(
        resource.then(() => handle),
        handle,
    )
}
