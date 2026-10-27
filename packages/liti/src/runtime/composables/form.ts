import {
    computed,
    getCurrentScope,
    onScopeDispose,
    shallowRef,
    toRaw,
    toValue,
    watch,
    useId,
    type MaybeRefOrGetter,
} from 'vue'
import { useAsyncData, useRequestFetch, useRequestURL, refreshNuxtData, useState, useNuxtApp } from '#app'
import { useForm } from '@tanstack/vue-form'
import type { Draft, FormData, ModelName, WriteReceipt } from '../../nuxt/types'
import { litiBaseURL } from './context'
import { useLitiModels } from './models'
import { useLitiSession } from './session'
import { reconcile, snapshot } from './reconcile'

export interface FormOptions<Name extends ModelName> {
    id?: MaybeRefOrGetter<string | null | undefined>
    locale?: MaybeRefOrGetter<string | undefined>
    defaultValues?: FormData<Name>
    body?: string
    onSuccess?(receipt: WriteReceipt, context: { hasUnsavedChanges: boolean }): void | Promise<void>
}
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(toRaw(value))) as Value

export function useLitiForm<Name extends ModelName>(model: Name, options: FormOptions<Name> = {}) {
    const session = useLitiSession(),
        descriptors = useLitiModels(),
        request = useRequestFetch(),
        origin = useRequestURL().origin,
        base = litiBaseURL()
    const nuxt = useNuxtApp()
    const refreshQueries = async () => {
        const keys = Object.keys(nuxt.payload.data).filter((key) => key.startsWith('liti:public:'))
        if (keys.length) await refreshNuxtData(keys)
    }
    const createdId = useState(`liti:form-id:${useId()}`, () => crypto.randomUUID()),
        id = computed(() => toValue(options.id) ?? createdId.value)
    const descriptor = computed(() => descriptors.data.value?.find((value) => value.name === model))
    const selectedLocale = computed(() => toValue(options.locale))
    const locale = computed(() => selectedLocale.value ?? descriptor.value?.locales?.default ?? 'und')
    const group = computed(() => `${session.scope.value}:${model}:${id.value}:`)
    const identity = computed(() => `${group.value}${selectedLocale.value ?? ''}`)
    const requestBody = async <Value>(body: Record<string, unknown>, signal?: AbortSignal) => {
        const requestedScope = session.scope.value
        const response = await request<Record<string, unknown> | unknown[] | null>(`${base}/manage`, {
            method: 'POST',
            body: { model, id: id.value, ...(selectedLocale.value ? { locale: selectedLocale.value } : {}), ...body },
            headers: { origin },
            ...(signal ? { signal } : {}),
            onResponse: ({ response: result }) =>
                session.rememberActor(result.headers.get('x-liti-actor') ?? '', requestedScope),
        })
        return response as Value
    }
    const resource = useAsyncData(
        computed(() => `liti:private:${identity.value}:entry`),
        async (_app, { signal }) => ({
            entry: toValue(options.id) ? await requestBody<Draft<Name> | null>({ action: 'read' }, signal) : null,
        }),
    )
    type Values = { data: FormData<Name>; body?: string | null }
    const defaults = (): Values => ({
        data: clone(options.defaultValues ?? {}),
        ...(options.body === undefined ? {} : { body: options.body }),
    })
    const baseline = shallowRef(defaults()),
        receipt = shallowRef<WriteReceipt | null>(null),
        error = shallowRef<unknown>(null)
    const warnings = shallowRef<{ code: string; message: string }[]>([])
    const drafts = new Map<string, { values: Values; baseline: Values; receipt: WriteReceipt | null }>()
    let activeIdentity = identity.value,
        activeScope = session.scope.value,
        saving: Promise<WriteReceipt | undefined> | undefined,
        lastReceipt: WriteReceipt | undefined
    let submissionFailure: { cause: unknown } | undefined
    const form = useForm({
        defaultValues: defaults(),
        onSubmit: async ({ value, createValidationError }) => {
            const submittedIdentity = identity.value
            try {
                const submitted = clone(value)
                const previous = receipt.value,
                    storage = descriptor.value?.storage
                if (!storage || (toValue(options.id) && !previous && resource.status.value !== 'success'))
                    throw new Error('Load the model and reviewed entry before saving.')
                error.value = null
                warnings.value = []
                const committed = await requestBody<WriteReceipt>({
                    action: 'save',
                    data: submitted.data,
                    ...(storage === 'content'
                        ? {
                              ...(submitted.body === undefined ? {} : { body: submitted.body }),
                              ifDigest: previous?.digest ?? null,
                          }
                        : { ifVersion: previous?.version ?? null }),
                })
                if (identity.value !== submittedIdentity) return
                receipt.value = committed
                lastReceipt = committed
                warnings.value = committed.postCommitErrors ?? []
                let canonical = submitted
                try {
                    const saved = await requestBody<Draft<Name>>({
                        action: 'read',
                        ...(committed.revision ? { revision: committed.revision } : {}),
                        ...(committed.version === undefined ? {} : { ifVersion: committed.version }),
                    })
                    if (identity.value !== submittedIdentity) return
                    canonical = {
                        data: saved.data,
                        ...('body' in saved && saved.body !== undefined ? { body: saved.body } : {}),
                    }
                } catch (cause) {
                    if (identity.value !== submittedIdentity) return
                    error.value = cause
                    warnings.value = [
                        ...warnings.value,
                        {
                            code: 'LITI_POST_COMMIT',
                            message: 'The save committed; reloading its canonical values failed.',
                        },
                    ]
                }
                const edited = clone(form.state.values)
                baseline.value = clone(canonical)
                const body = submitted.body === edited.body ? canonical.body : edited.body
                form.reset({
                    data: reconcile(submitted.data, edited.data, canonical.data),
                    ...(body === undefined ? {} : { body }),
                })
                try {
                    await options.onSuccess?.(committed, { hasUnsavedChanges: hasUnsavedChanges.value })
                } catch (cause) {
                    if (identity.value === submittedIdentity) {
                        error.value = cause
                        warnings.value = [
                            ...warnings.value,
                            { code: 'LITI_POST_COMMIT', message: 'The save committed; the success callback failed.' },
                        ]
                    }
                }
                try {
                    await refreshQueries()
                } catch (cause) {
                    if (identity.value === submittedIdentity) {
                        error.value = cause
                        warnings.value = [
                            ...warnings.value,
                            { code: 'LITI_POST_COMMIT', message: 'The save committed; refreshing public data failed.' },
                        ]
                    }
                }
            } catch (cause) {
                submissionFailure = { cause }
                if (identity.value === submittedIdentity) {
                    error.value = cause
                    if (lastReceipt)
                        warnings.value = [
                            ...warnings.value,
                            {
                                code: 'LITI_POST_COMMIT',
                                message: 'The save committed; updating the form failed.',
                            },
                        ]
                }
                if (!lastReceipt) return createValidationError('The entry was not saved.')
            }
        },
    })
    const values = shallowRef(form.state.values)
    const subscription = form.atom.subscribe((state) => {
        values.value = state.values
    })
    const isDirty = computed(() => snapshot(values.value) !== snapshot(baseline.value))
    const hasUnsavedChanges = computed(
        () =>
            isDirty.value ||
            [...drafts.entries()].some(
                ([key, draft]) =>
                    key.startsWith(group.value) &&
                    key !== identity.value &&
                    snapshot(draft.values) !== snapshot(draft.baseline),
            ),
    )
    watch(
        identity,
        () => {
            if (activeScope === session.scope.value)
                drafts.set(activeIdentity, {
                    values: clone(form.state.values),
                    baseline: baseline.value,
                    receipt: receipt.value,
                })
            else drafts.clear()
            activeIdentity = identity.value
            activeScope = session.scope.value
            const restored = drafts.get(activeIdentity)
            baseline.value = clone(restored?.baseline ?? defaults())
            receipt.value = restored?.receipt ?? null
            form.reset(clone(restored?.values ?? defaults()))
            error.value = null
            warnings.value = []
        },
        { flush: 'sync' },
    )
    watch(
        resource.data,
        (result) => {
            const entry = result?.entry
            if (!entry || isDirty.value || saving) return
            receipt.value = {
                id: entry.id,
                ...('digest' in entry
                    ? { digest: entry.digest, revision: entry.revision, locale: entry.locale }
                    : { version: entry.version }),
            }
            baseline.value = {
                data: clone(entry.data),
                ...('body' in entry && entry.body !== undefined ? { body: entry.body } : {}),
            }
            form.reset(clone(baseline.value))
        },
        { immediate: true, flush: 'sync' },
    )
    if (getCurrentScope()) onScopeDispose(() => subscription.unsubscribe())
    const save = () => {
        if (saving) return saving
        const savedIdentity = identity.value
        lastReceipt = undefined
        submissionFailure = undefined
        saving = form
            .handleSubmit()
            .then(() => {
                if (submissionFailure && !lastReceipt) throw submissionFailure.cause
                return lastReceipt
            })
            .catch((cause: unknown) => {
                if (identity.value === savedIdentity) error.value = cause
                throw cause
            })
            .finally(() => {
                saving = undefined
            })
        return saving
    }
    const publish = async (digests?: Record<string, string | null>, at?: Date) => {
        if (!receipt.value || isDirty.value || saving)
            throw new Error('Save and review the current fields before publication.')
        if (descriptor.value?.storage !== 'content')
            throw new Error('Records are immediately visible and do not publish.')
        const reviewed = digests ?? { [locale.value]: receipt.value.digest ?? null }
        const result = await requestBody<{ revision: string; postCommitErrors?: WriteReceipt['postCommitErrors'] }>({
            action: at ? 'schedule' : 'publish',
            digests: reviewed,
            ...(at ? { at: at.toISOString() } : {}),
        })
        try {
            await refreshQueries()
        } catch (cause) {
            error.value = cause
            warnings.value = [
                ...warnings.value,
                { code: 'LITI_POST_COMMIT', message: 'The operation committed; refreshing public data failed.' },
            ]
        }
        return result
    }
    const displayedError = computed(() => error.value ?? resource.error.value ?? descriptors.error.value)
    const handle = {
        form,
        id,
        locale,
        descriptor,
        receipt,
        error: displayedError,
        warnings,
        isDirty,
        hasUnsavedChanges,
        values,
        status: resource.status,
        pending: resource.pending,
        refresh: resource.refresh,
        save,
        publish: (digests?: Record<string, string | null>) => publish(digests),
        schedule: (at: Date, digests?: Record<string, string | null>) => publish(digests, at),
    }
    return Object.assign(
        Promise.all([resource, descriptors]).then(() => handle),
        handle,
    )
}
