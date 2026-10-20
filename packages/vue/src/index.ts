import type { Ref, MaybeRefOrGetter } from 'vue'
import type { LitiEntry, LitiFormModels } from '../../liti/src/client'
import type { LitiQueryModel, LitiQueryResult, RegisteredLitiSchema, ActionMetadata } from '../../liti/src/query'
import type { ReactiveQuerySelection } from './query'
import type { LitiModelError } from './model'
import type { UseEntryFormOptions, useEntryForm } from './form'
import { useLitiRuntime } from './provider'
import type { LitiFormExtensions } from './extensions'
export interface LitiFormExtensionTypes {}
export type {
    LitiFormExtensions,
    LitiFormExtensionContext,
    LitiFormExtension,
    LitiFormExtensionFactory,
    LitiFormExtensionRegistry,
} from './extensions'

export { createLitiVue } from './provider'
export type { LitiVueOptions } from './provider'
export type { LitiBrowserBridge, LitiDescriptor, ModelDescriptor, FieldDescriptor } from '../../liti/src/descriptor'
export type { LitiField } from './native-field'
export type { ReactiveLitiQueryOptions } from './query'
export {
    Subscribe,
    createFormHook,
    getFormHookHelpers,
    useForm,
    useSelector,
    createValidator,
    createValidators,
    formOptions,
} from '@tanstack/vue-form'
export type { DeepKeys, DeepValue, FieldApi, FormApi, VueFormApi, VueFormType } from '@tanstack/vue-form'

export interface LitiQueryHandle<Data> {
    data: Readonly<Ref<Data>>
    status: Readonly<Ref<'idle' | 'pending' | 'success' | 'error'>>
    error: Readonly<Ref<LitiModelError | undefined>>
    pending: Readonly<Ref<boolean>>
    refresh(): Promise<void>
    execute(): Promise<void>
    clear(): void
}
type PickResult<Value, Key extends PropertyKey> = Value extends readonly unknown[]
    ? Value
    : Value extends object
      ? Pick<Value, Extract<keyof Value, Key>>
      : Value
type Awaitable<Handle> = Handle & Promise<Handle>
type FormData<Name extends keyof LitiFormModels> = Extract<LitiFormModels[Name], Record<string, unknown>>

export interface UseLitiQuery {
    <
        Mode extends 'many' | 'one' = 'many',
        View extends 'published' | 'current' = 'published',
        Markdown extends 'full' | 'summary' = 'full',
        Name extends LitiQueryModel<RegisteredLitiSchema, { view: View }> = LitiQueryModel<
            RegisteredLitiSchema,
            { view: View }
        >,
        Data = unknown,
        Key extends Extract<keyof NonNullable<Data>, string> = Extract<keyof NonNullable<Data>, string>,
    >(
        model: Name,
        options: { mode?: Mode; view?: View; markdown?: Markdown } & ReactiveQuerySelection<Mode, View, Markdown> & {
                immediate?: boolean
                transform: (
                    data: LitiQueryResult<RegisteredLitiSchema, Name, { mode: Mode; view: View; markdown: Markdown }>,
                ) => Data | Promise<Data>
                default?: () => NoInfer<Data>
                pick?: readonly Key[]
            },
    ): Awaitable<
        LitiQueryHandle<PickResult<Data, Key>> &
            (Mode extends 'many' ? { total: Readonly<Ref<number>> } : {}) &
            (View extends 'current'
                ? {
                      remove(
                          entry?: LitiEntry<
                              Name extends keyof LitiFormModels ? FormData<Name> : Record<string, unknown>
                          >,
                      ): Promise<unknown>
                  }
                : {})
    >
    <
        Mode extends 'many' | 'one' = 'many',
        View extends 'published' | 'current' = 'published',
        Markdown extends 'full' | 'summary' = 'full',
        Name extends LitiQueryModel<RegisteredLitiSchema, { view: View }> = LitiQueryModel<
            RegisteredLitiSchema,
            { view: View }
        >,
        Data = LitiQueryResult<RegisteredLitiSchema, Name, { mode: Mode; view: View; markdown: Markdown }>,
        Key extends Extract<keyof NonNullable<Data>, string> = Extract<keyof NonNullable<Data>, string>,
    >(
        model: Name,
        options?: { mode?: Mode; view?: View; markdown?: Markdown } & ReactiveQuerySelection<Mode, View, Markdown> & {
                immediate?: boolean
                transform?: never
                default?: () => NoInfer<Data>
                pick?: readonly Key[]
            },
    ): Awaitable<
        LitiQueryHandle<PickResult<Data, Key>> &
            (Mode extends 'many' ? { total: Readonly<Ref<number>> } : {}) &
            (View extends 'current'
                ? {
                      remove(
                          entry?: LitiEntry<
                              Name extends keyof LitiFormModels ? FormData<Name> : Record<string, unknown>
                          >,
                      ): Promise<unknown>
                  }
                : {})
    >
}

export const useLitiQuery: UseLitiQuery = ((
    model: string,
    options?: Parameters<ReturnType<typeof useLitiRuntime>['query']>[1],
) => useLitiRuntime().query(model, options)) as UseLitiQuery

export const useLitiModels = () =>
    useLitiRuntime().models() as Awaitable<
        LitiQueryHandle<ReturnType<typeof import('../../liti/src/admin-client').litiModelCatalog>>
    >

type Actions = RegisteredLitiSchema['actions']
export type UseAiOptions<Name extends Extract<keyof Actions, string>> = {
    input: MaybeRefOrGetter<Actions[Name]['input']>
    immediate?: boolean
    timeout?: number
}
export const useAi = <Name extends Extract<keyof Actions, string>>(name: Name, options: UseAiOptions<Name>) =>
    useLitiRuntime().action(name, options.input, options) as Awaitable<
        Omit<LitiQueryHandle<Actions[Name]['output'] | undefined>, 'execute' | 'refresh'> & {
            metadata: Readonly<Ref<ActionMetadata<Actions[Name]> | undefined>>
            execute(options?: { signal?: AbortSignal; dedupe?: 'cancel' | 'defer' }): Promise<void>
            refresh(options?: { signal?: AbortSignal; dedupe?: 'cancel' | 'defer' }): Promise<void>
        }
    >

export type LitiFormOptions<Data extends Record<string, unknown>> = UseEntryFormOptions<Data> & {
    id?: MaybeRefOrGetter<string | null | undefined>
    instance?: MaybeRefOrGetter<string | undefined>
    locale?: MaybeRefOrGetter<string | undefined>
}

export const useLitiForm = <Name extends Extract<keyof LitiFormModels, string>>(
    model: Name,
    options: LitiFormOptions<FormData<Name>> = {},
) =>
    useLitiRuntime().form(model, options as LitiFormOptions<Record<string, unknown>>) as unknown as Awaitable<
        ReturnType<typeof useEntryForm<FormData<Name>>> &
            LitiFormExtensions<Name> &
            LitiQueryHandle<LitiEntry<FormData<Name>> | null> & {
                remove(): Promise<unknown>
            }
    >
