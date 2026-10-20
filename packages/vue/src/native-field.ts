import { getCurrentInstance, getCurrentScope, onMounted, onScopeDispose, shallowRef } from 'vue'
import type { DeepKeys, DeepValue } from '@tanstack/vue-form'

interface NativeField {
    atom: { subscribe(listener: () => void): { unsubscribe(): void } }
    value: unknown
    errors: readonly unknown[]
    handleChange(value: unknown): void
    handleBlur(): void
    _register(): () => void
}
interface NativeForm {
    _getOrCreateFieldApi(options: { name: string }, scope: 'field'): NativeField
    _atoms: { resetVersion: { subscribe(listener: () => void): { unsubscribe(): void } } }
}

export interface LitiField<Value> {
    value: Value
    readonly error: string | undefined
    readonly errors: readonly unknown[]
    blur(): void
}
export interface LitiFieldAccessor<Data> {
    <Name extends DeepKeys<Data>>(name: Name): LitiField<DeepValue<Data, Name>>
}

/** Uses the same pinned native registration/reset path as form.Field, including its reference counting. */
export const createFieldAccessor = <Data>(form: object): LitiFieldAccessor<Data> => {
    const native = form as NativeForm
    const handles = new Map<string, LitiField<unknown>>()
    return <Name extends DeepKeys<Data>>(name: Name): LitiField<DeepValue<Data, Name>> => {
        const key = String(name)
        const cached = handles.get(key)
        if (cached) return cached as LitiField<DeepValue<Data, Name>>
        if (!getCurrentScope()) throw new Error('[liti] Register fields synchronously in a Vue setup scope.')
        const changed = shallowRef(0)
        let field: NativeField
        let subscription: { unsubscribe(): void } | undefined
        let unregister: (() => void) | undefined
        let mounted = !getCurrentInstance()
        const bind = () => {
            unregister?.()
            subscription?.unsubscribe()
            field = native._getOrCreateFieldApi({ name: key }, 'field')
            subscription = field.atom.subscribe(() => {
                changed.value++
            })
            if (mounted) unregister = field._register()
            changed.value++
        }
        bind()
        const reset = native._atoms.resetVersion.subscribe(bind)
        if (!mounted)
            onMounted(() => {
                mounted = true
                unregister = field._register()
            })
        const handle: LitiField<DeepValue<Data, Name>> = {
            get value() {
                changed.value
                return field.value as DeepValue<Data, Name>
            },
            set value(value) {
                field.handleChange(value)
            },
            get errors() {
                changed.value
                return field.errors
            },
            get error() {
                changed.value
                const error = field.errors[0]
                return typeof error === 'string'
                    ? error
                    : error && typeof error === 'object' && 'message' in error
                      ? String(error.message)
                      : undefined
            },
            blur: () => field.handleBlur(),
        }
        handles.set(key, handle)
        onScopeDispose(() => {
            reset.unsubscribe()
            subscription?.unsubscribe()
            unregister?.()
            handles.delete(key)
        })
        return handle
    }
}
