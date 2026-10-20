import { computed, shallowRef, toRaw, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import type { LitiQueryOptions, LitiQuerySelection } from '../../liti/src/query'

type ReactiveOptions<Options> = Options extends unknown
    ? {
          [Key in keyof Options]: Options[Key] extends undefined
              ? never
              : Key extends 'page'
                ? MaybeRefOrGetter<NonNullable<Options[Key]>>
                : Key extends 'id' | 'path' | 'locale' | 'q'
                  ? MaybeRefOrGetter<Options[Key]>
                  : Options[Key]
      }
    : never

export type ReactiveLitiQueryOptions = ReactiveOptions<LitiQueryOptions>
export type ReactiveQuerySelection<
    Mode extends 'many' | 'one',
    View extends 'published' | 'current',
    Markdown extends 'full' | 'summary',
> = ReactiveOptions<LitiQuerySelection<Mode, View, Markdown>>

export interface QuerySource<Execution = void> {
    data: Ref<unknown>
    error: Ref<unknown>
    status: Ref<'idle' | 'pending' | 'success' | 'error'>
    refresh: (options?: Execution) => Promise<unknown>
    execute: (options?: Execution) => Promise<unknown>
    clear: () => void
}

/** A caller's projection never changes the shared raw resource or another caller's DTO shape. */
export const projectQuery = <Execution>(
    source: QuerySource<Execution>,
    initial: unknown,
    options: {
        transform?: (data: unknown) => unknown
        pick?: readonly string[]
        default?: () => unknown
    } = {},
    select: (value: unknown) => unknown = (value) => value,
    identity?: MaybeRefOrGetter<string>,
) => {
    const fallback = () => options.default?.() ?? (options.transform ? undefined : structuredClone(initial))
    const data = shallowRef(fallback())
    const projectionError = shallowRef<unknown>()
    const projecting = shallowRef(false)
    let pending: Promise<void> = Promise.resolve()
    let generation = 0
    if (identity)
        watch(
            () => toValue(identity),
            () => {
                generation++
                data.value = fallback()
                projectionError.value = undefined
                projecting.value = false
                pending = Promise.resolve()
            },
            { flush: 'sync' },
        )
    watch(
        source.data,
        (raw) => {
            const revision = ++generation
            projectionError.value = undefined
            projecting.value = false
            if (raw === undefined) {
                data.value = fallback()
                pending = Promise.resolve()
                return
            }
            const accept = (value: unknown) => {
                if (revision !== generation) return
                data.value =
                    options.pick && value && typeof value === 'object' && !Array.isArray(value)
                        ? Object.fromEntries(
                              options.pick
                                  .filter((key) => Object.hasOwn(value, key))
                                  .map((key) => [key, (value as Record<string, unknown>)[key]]),
                          )
                        : value
                projecting.value = false
            }
            try {
                const value = select(raw)
                const transformed = options.transform ? options.transform(structuredClone(toRaw(value))) : value
                if (transformed && typeof (transformed as PromiseLike<unknown>).then === 'function') {
                    projecting.value = true
                    data.value = fallback()
                    pending = Promise.resolve(transformed).then(accept, (error) => {
                        if (revision !== generation) return
                        projectionError.value = error
                        projecting.value = false
                    })
                } else {
                    accept(transformed)
                    pending = Promise.resolve()
                }
            } catch (error) {
                projectionError.value = error
                data.value = fallback()
                pending = Promise.resolve()
            }
        },
        { immediate: true, flush: 'sync' },
    )
    const status = computed(() =>
        projectionError.value ? 'error' : projecting.value ? 'pending' : source.status.value,
    )
    const error = computed(() => projectionError.value ?? source.error.value)
    const refresh = async (options?: Execution) => {
        await source.refresh(options)
        await pending
    }
    const execute = async (options?: Execution) => {
        await source.execute(options)
        await pending
    }
    return {
        handle: {
            data,
            status,
            error,
            refresh,
            execute,
            clear: source.clear,
            pending: computed(() => status.value === 'pending'),
        },
        ready: async () => {
            await pending
        },
    }
}
