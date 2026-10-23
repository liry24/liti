import type { AsyncData } from '#app'
import { getCurrentInstance, toValue, useId, type Ref } from 'vue'
import type { LitiEntry } from '../../../liti/src/client'
import { useEntryForm } from '../../../vue/src/form'
import type { LitiModelActions, LitiModelError } from '../../../vue/src/model'
import type { LitiFormExtensionRegistry, LitiFormExtensions } from '../../../vue/src/extensions'
import type { createLitiComposables, FormData, LitiFormOptions, ManagementModelName } from './composables'

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

export const createLitiFormComposables = (
    base: Pick<ReturnType<typeof createLitiComposables>, 'useManagedSource'>,
    editors: Record<string, string[]>,
    extensions: LitiFormExtensionRegistry = {},
) => {
    const useLitiForm = <Name extends string>(
        model: ValidModel<Name>,
        options: LitiFormOptions<FormData<Name>> = {},
    ): FormResource<Name> & Promise<FormResource<Name>> => {
        const generatedInstance = getCurrentInstance() ? useId() : crypto.randomUUID()
        const resource = base.useManagedSource(
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
            Object.fromEntries(Object.entries(extensions).filter(([name]) => editors[model]?.includes(name))),
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
        ) as unknown as FormResource<Name> & Promise<FormResource<Name>>
    }

    return { useLitiForm }
}
