import { resolveTranslation } from '../../liti/src/i18n'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { useForm, type DeepKeys } from '@tanstack/vue-form'
import {
    computed,
    getCurrentInstance,
    getCurrentScope,
    onMounted,
    onScopeDispose,
    readonly,
    shallowRef,
    toRaw,
    toValue,
    watch,
    type MaybeRefOrGetter,
    type Ref,
    type DeepReadonly,
} from 'vue'
import { LitiClientError, type LitiEntry, type LitiEntryMutation } from '../../liti/src/client'
import { presentLitiData, serializeLitiData, litiAsset } from '../../liti/src/management-assets'
import { projectStoredFields } from '../../liti/src/stored-data'
import type { FieldDescriptor, ModelDescriptor } from '../../liti/src/descriptor'
import type { LitiIssue } from '../../liti/src/errors'
import { isRecord, validateBuiltinValue } from '../../liti/src/validation-builtin'
import { litiModelContext, litiSnapshot, type LitiModel } from './model'
import { createFieldAccessor } from './native-field'
import type { LitiFormExtensionRegistry } from './extensions'

export type { LitiAsset } from '../../liti/src/management-assets'
export type { LitiSessionDraft } from './model'

export interface UseEntryFormOptions<Data extends Record<string, unknown>> {
    beforeUnload?: false | MaybeRefOrGetter<boolean>
    defaultValues?: Partial<Data>
    onBeforeSubmit?: (context: {
        operation: 'save' | 'publish' | 'schedule'
        locale?: string
        defaultLocale?: string
    }) => void | Promise<void>
    onUpload?: (context: {
        field: DeepKeys<Data>
        files: File[]
        assets: import('../../liti/src/management-assets').LitiAsset[]
    }) => void | Promise<void>
    onSuccess?: (
        entry: LitiEntryMutation<Data>,
        context: { operation: 'save' | 'publish' | 'schedule'; hasUnsavedChanges: boolean },
    ) => void | Promise<void>
}

const fieldDefault = (field: FieldDescriptor): unknown => {
    if (field.default !== undefined) return structuredClone(toRaw(field.default))
    if (!field.required) return undefined
    if (field.kind === 'object') return defaultsFromFields(field.fields ?? {})
    if (field.kind === 'array' || field.kind === 'images') return []
    if (field.kind === 'boolean') return false
    if (field.kind === 'number') return 0
    return ''
}

const defaultsFromFields = (fields: Record<string, FieldDescriptor>): Record<string, unknown> =>
    Object.fromEntries(
        Object.entries(fields).flatMap(([name, field]) => {
            const value = fieldDefault(field)
            return value === undefined ? [] : [[name, value]]
        }),
    )

export const litiFormDefaults = <Data extends Record<string, unknown>>(
    model: ModelDescriptor,
    values: Partial<Data> = {},
): Data => ({ ...defaultsFromFields(model.fields), ...values }) as Data

const descriptorIssues = (
    fields: Record<string, FieldDescriptor>,
    data: Record<string, unknown>,
    parent = '',
): LitiIssue[] => {
    const issues: LitiIssue[] = Object.keys(data)
        .filter((name) => !Object.hasOwn(fields, name))
        .map((name) => ({ path: [parent, name].filter(Boolean).join('.'), message: 'Unknown field.' }))
    for (const [name, field] of Object.entries(fields)) {
        const path = [parent, name].filter(Boolean).join('.')
        const value = data[name]
        issues.push(...validateBuiltinValue(field, value, path))
        if (field.kind === 'object' && isRecord(value))
            issues.push(...descriptorIssues(field.fields ?? {}, value, path))
        else if (field.kind === 'array' && field.item && Array.isArray(value))
            for (const [index, item] of value.entries())
                issues.push(...descriptorIssues({ [index]: field.item }, { [index]: item }, path))
    }
    return issues
}

const descriptorSchema = <Data extends Record<string, unknown>>(
    model: ModelDescriptor,
): StandardSchemaV1<Data, Data> => ({
    '~standard': {
        validate: (value) => {
            const data = value as Data
            const issues = descriptorIssues(model.fields, data).map((issue) => ({
                message: issue.message,
                path: issue.path.split('.'),
            }))
            return issues.length > 0 ? { issues } : { value: data }
        },
        vendor: 'liti',
        version: 1,
    },
})

/** Native TanStack form, with only model-aware fields, uploads and draft operations added. */
export const useEntryForm = <Data extends Record<string, unknown>, Extensions extends LitiFormExtensionRegistry = {}>(
    resource: Pick<LitiModel<Data>, 'data' | 'status' | 'error' | 'refresh' | typeof litiModelContext>,
    options: UseEntryFormOptions<Data> = {},
    factories: Extensions = {} as Extensions,
) => {
    if (resource.data.value && 'items' in resource.data.value)
        throw new TypeError('[liti] Forms require an entry resource. Use useLitiForm(model) for a new entry.')
    const lifetime = new AbortController()
    if (getCurrentScope()) onScopeDispose(() => lifetime.abort())
    const context = resource[litiModelContext]
    let cachedDescriptor = context.descriptor.value
    const descriptor = () => {
        cachedDescriptor = context.descriptor.value ?? cachedDescriptor
        return (
            cachedDescriptor ?? {
                fields: {},
                public: true,
                publishing: true,
                scheduling: true,
                revisions: true,
                route: false,
                serverValidation: false,
                sortable: false,
            }
        )
    }
    const present = (data: Record<string, unknown>) =>
        presentLitiData<Data>(descriptor(), data, (id) => context.client.assetUrl(id))
    const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value
    const serialize = (value: Data) => serializeLitiData(descriptor(), value)
    const currentEntry = () =>
        resource.data.value && 'id' in resource.data.value && resource.data.value.id === context.id.value
            ? resource.data.value
            : null
    const initial = currentEntry()
    const draftKey = () => toValue(context.identity)
    let storedKey = draftKey()
    let storedScope = toValue(context.scope)
    let storedGroup = toValue(context.group)
    let storedLocale = toValue(context.locale) ?? context.defaultLocale
    const stored = context.drafts[storedKey]
    const restoredDraft = shallowRef(Boolean(stored))
    let pendingPublication = stored?.pendingPublication ?? false
    const version = shallowRef(stored ? stored.version : (initial?.version ?? null))
    const entryId = shallowRef(initial?.id ?? stored?.entryId ?? null)
    // A new route can resume the draft created while running an app-owned AI action.
    if (entryId.value) context.id.value = entryId.value
    const defaultValue = (): Data => present(litiFormDefaults(descriptor(), options.defaultValues))
    const draftGroup = (key: string) => (key === draftKey() ? toValue(context.group) : context.drafts[key]?.group)
    const originalDraft = () =>
        Object.entries(context.drafts).find(
            ([key, draft]) => draftGroup(key) === draftGroup(draftKey()) && draft.locale === context.defaultLocale,
        )?.[1]
    const newDefaultValue = () => present(originalDraft()?.value ?? serialize(defaultValue()))
    const newSnapshot = (value: Data) => {
        if (currentEntry() || !context.defaultLocale) return undefined
        const locale = toValue(context.locale) ?? context.defaultLocale
        const data = {
            ...(locale === context.defaultLocale
                ? serialize(value)
                : (originalDraft()?.value ?? serialize(defaultValue()))),
        }
        const translations: import('../../liti/src/i18n').TranslationInput<Data> = {}
        const drafts = Object.entries(context.drafts).filter(([key]) => draftGroup(key) === draftGroup(draftKey()))
        for (const [, draft] of drafts) {
            if (!draft.locale || draft.locale === context.defaultLocale) continue
            const override = Object.fromEntries(
                Object.entries(descriptor().fields)
                    .filter(
                        ([key, field]) =>
                            field.i18n && litiSnapshot(draft.value[key]) !== litiSnapshot(draft.baseline[key]),
                    )
                    .map(([key]) => [key, draft.value[key]]),
            ) as Partial<Data>
            if (Object.keys(override).length) translations[draft.locale] = override
        }
        // Shared fields keep their single value even when edited in a translated view.
        for (const [key, field] of Object.entries(descriptor().fields))
            if (!field.i18n) data[key] = serialize(value)[key]
        return { data: data as Partial<Data>, translations }
    }

    const entryValue = (entry: LitiEntry<Data>): Data =>
        present(
            litiFormDefaults(
                descriptor(),
                projectStoredFields(
                    descriptor().fields,
                    resolveTranslation(entry, toValue(context.locale)).data,
                ) as Partial<Data>,
            ),
        )
    const storedValue = (value: Record<string, unknown>) => {
        const fields = (context.descriptor.value ?? cachedDescriptor)?.fields
        // An unloaded descriptor cannot decide which trusted draft fields to discard.
        return present(fields ? projectStoredFields(fields, value) : value)
    }
    const baseline = shallowRef(
        stored ? serialize(storedValue(stored.baseline)) : serialize(initial ? entryValue(initial) : defaultValue()),
    )
    let switching = false
    let intent: { kind: 'save' | 'publish' | 'schedule'; at?: string } = { kind: 'save' }
    let published: LitiEntryMutation<Data> | undefined
    let publishing: Promise<LitiEntryMutation<Data> | undefined> | undefined
    let ensuring = false
    let ensurePending: Promise<{ id: string; version: number } | undefined> | undefined
    const submitting = shallowRef(false)
    const completed = shallowRef(false)
    const uploading = shallowRef(false)
    const operation = computed(() =>
        uploading.value ? 'upload' : submitting.value && !completed.value ? intent.kind : null,
    )
    const form = useForm({
        defaultValues: stored ? storedValue(stored.value) : initial ? entryValue(initial) : defaultValue(),
        validators: [
            {
                run: {
                    '~standard': {
                        version: 1,
                        vendor: 'liti',
                        validate: (value: unknown) => descriptorSchema<Data>(descriptor())['~standard'].validate(value),
                    },
                },
                triggers: [],
            },
        ],
        onSubmit: async ({ value, createValidationError }) => {
            if (lifetime.signal.aborted) return
            const identity = draftKey()
            const submitted = clone(serialize(value))
            const selectedIntent = { ...intent }
            let creationDrafts: Array<[string, import('./model').LitiSessionDraft]> = []
            const clearCreatedDrafts = () => {
                for (const [key, draft] of creationDrafts)
                    if (litiSnapshot(context.drafts[key]) === litiSnapshot(draft)) delete context.drafts[key]
            }
            if (selectedIntent.kind !== 'save' && !entryId.value) pendingPublication = true
            try {
                if (!context.descriptor.value || (context.id.value && !currentEntry() && !entryId.value))
                    throw (
                        resource.error.value ??
                        new LitiClientError('LITI_INVALID_INPUT', 'Load the entry before submitting.', 400)
                    )
                for (const extension of Object.values(extensions)) await extension.beforeSubmit?.(selectedIntent.kind)
                await options.onBeforeSubmit?.({
                    operation: selectedIntent.kind,
                    ...(toValue(context.locale) ? { locale: toValue(context.locale)! } : {}),
                    ...((currentEntry()?.defaultLocale ?? context.defaultLocale)
                        ? { defaultLocale: currentEntry()?.defaultLocale ?? context.defaultLocale! }
                        : {}),
                })
                lifetime.signal.throwIfAborted()
                if (resource.error.value?.data?.committed && resource.error.value.data.code === 'LITI_INVALID_RESPONSE')
                    throw resource.error.value
                if (
                    resource.error.value?.data?.code === 'LITI_CONFLICT' ||
                    (currentEntry() && version.value !== currentEntry()!.version)
                )
                    throw new LitiClientError('LITI_CONFLICT', 'Reload the current entry before saving.', 409)
                remember()
                if (!currentEntry())
                    creationDrafts = clone(
                        Object.entries(context.drafts).filter(([key]) => draftGroup(key) === draftGroup(identity)),
                    )
                const result = await context.submit(
                    selectedIntent.kind,
                    value,
                    selectedIntent.at,
                    () => {
                        if (
                            identity !== draftKey() ||
                            litiSnapshot(submitted) !== litiSnapshot(serialize(form.state.values))
                        )
                            throw new LitiClientError(
                                'LITI_CONFLICT',
                                'Input changed during preparation. Your edits are kept.',
                                409,
                            )
                    },
                    newSnapshot(value),
                )
                if (!result || lifetime.signal.aborted || identity !== draftKey()) return
                const edited = clone(serialize(form.state.values))
                clearCreatedDrafts()
                pendingPublication = false
                entryId.value = result.id
                version.value = result.version
                const saved = 'data' in result ? (result as LitiEntry<Data>) : undefined
                baseline.value = saved ? serialize(entryValue(saved)) : submitted
                switching = true
                form.reset(present(baseline.value))
                // Preserve edits made while the request was in flight, including nested field changes.
                for (const name of new Set([...Object.keys(submitted), ...Object.keys(edited)]))
                    if (litiSnapshot(submitted[name]) !== litiSnapshot(edited[name]))
                        setFieldValue(name, present(edited)[name])
                switching = false
                remember()
                published = result
                completed.value = true
                try {
                    if (!ensuring)
                        await options.onSuccess?.(result, {
                            operation: selectedIntent.kind,
                            hasUnsavedChanges: hasUnsavedChanges.value,
                        })
                } catch (error) {
                    if (!lifetime.signal.aborted && identity === draftKey()) throw context.report(error, true)
                }
                return result
            } catch (cause) {
                if (lifetime.signal.aborted || identity !== draftKey()) return
                if (context.receipt) {
                    entryId.value = context.receipt.id
                    version.value = context.receipt.version
                    if (resource.error.value?.data?.committed && currentEntry()) {
                        clearCreatedDrafts()
                        baseline.value = serialize(entryValue(currentEntry()!))
                        pendingPublication = false
                    }
                    remember()
                }
                const error = context.report(
                    cause,
                    Boolean((cause as { data?: { committed?: boolean } })?.data?.committed),
                )
                const issues = error.data?.issues ?? []
                const fields = Object.fromEntries(
                    issues.map(({ message, path }) => [path.replace(/^data\./u, ''), message]),
                )
                return createValidationError({ fields: fields as never, form: error.message })
            }
        },
    })
    const setFieldValue = (form as unknown as { setFieldValue: (name: string, value: unknown) => void }).setFieldValue
    const values = shallowRef(form.state.values)
    const subscription = form.atom.subscribe((state) => {
        if (state.isSubmitting && !submitting.value) completed.value = false
        submitting.value = state.isSubmitting
        values.value = state.values
    })
    const isDirty = computed(() => litiSnapshot(serialize(values.value)) !== litiSnapshot(baseline.value))
    const hasUnsavedChanges = computed(
        () =>
            isDirty.value ||
            Object.entries(context.drafts).some(
                ([key, draft]) =>
                    draftGroup(key) === draftGroup(draftKey()) &&
                    litiSnapshot(draft.value) !== litiSnapshot(draft.baseline),
            ),
    )
    function remember() {
        if (switching) return
        if (!isDirty.value && !pendingPublication && !(toValue(context.instance) !== undefined && entryId.value)) {
            delete context.drafts[storedKey]
            return
        }
        context.drafts[storedKey] = clone({
            group: storedGroup,
            value: serialize(form.state.values),
            baseline: baseline.value,
            ...(storedLocale ? { locale: storedLocale } : {}),
            entryId: entryId.value,
            version: version.value,
            ...(pendingPublication ? { pendingPublication: true } : {}),
        })
    }
    watch(values, remember, { deep: true, flush: 'sync' })
    watch(
        () => toValue(context.identity),
        () => {
            const authChanged = storedScope !== toValue(context.scope)
            if (!authChanged) remember()
            storedScope = toValue(context.scope)
            // An identity switch must never display the previous actor's input.
            switching = true
            storedKey = draftKey()
            storedGroup = toValue(context.group)
            storedLocale = toValue(context.locale) ?? context.defaultLocale
            const restored = context.drafts[storedKey]
            restoredDraft.value = Boolean(restored)
            pendingPublication = restored?.pendingPublication ?? false
            entryId.value = restored?.entryId ?? null
            version.value = restored?.version ?? null
            if (entryId.value) context.id.value = entryId.value
            const fallback = currentEntry() ? entryValue(currentEntry()!) : newDefaultValue()
            baseline.value = restored?.baseline ?? serialize(fallback)
            form.reset(restored ? present(restored.value) : fallback)
            switching = false
        },
        { flush: 'sync' },
    )
    watch(
        [resource.data, resource.status],
        () => {
            const current = currentEntry()
            if (!current || form.state.isSubmitting) return
            if (isDirty.value) {
                if (resource.status.value === 'success' && version.value !== null && version.value !== current.version)
                    context.report(
                        new LitiClientError('LITI_CONFLICT', 'The saved entry changed. Your input is kept.', 409),
                    )
                return
            }
            entryId.value = current.id
            version.value = current.version
            baseline.value = serialize(entryValue(current))
            form.reset(entryValue(current))
            remember()
        },
        { immediate: true, flush: 'sync' },
    )
    watch(
        context.descriptor,
        (value, previous) => {
            if (!value || previous) return
            if (!currentEntry() && !context.id.value && !isDirty.value) {
                baseline.value = serialize(defaultValue())
                form.reset(defaultValue())
            } else {
                baseline.value = serialize(storedValue(baseline.value))
                form.reset(storedValue(form.state.values))
            }
        },
        { flush: 'sync' },
    )
    if (getCurrentScope())
        onScopeDispose(() => {
            remember()
            subscription.unsubscribe()
        })
    const publish = (at?: string): Promise<LitiEntryMutation<Data> | undefined> => {
        if (publishing) return intent.at === at ? publishing : publishing.then(() => publish(at))
        if (form.state.isSubmitting) {
            context.report(new LitiClientError('LITI_CONFLICT', 'Wait for the current save before publishing.', 409))
            return Promise.resolve(undefined)
        }
        intent = at === undefined ? { kind: 'publish' } : { kind: 'schedule', at }
        published = undefined
        publishing = (async () => {
            try {
                await form.handleSubmit()
                return published
            } finally {
                intent = { kind: 'save' }
                publishing = undefined
            }
        })()
        return publishing
    }
    let uploadSequence = 0
    const uploadIds = new WeakMap<File, number>()
    const uploadTarget = (path: string) => {
        const invalid = () => new LitiClientError('LITI_INVALID_INPUT', 'Select an existing asset field.', 400)
        if (!/^[^.[\]]+(?:\.[^.[\]]+|\[(?:0|[1-9]\d*)\])*$/u.test(path)) throw invalid()
        let definition: FieldDescriptor | undefined
        let fields = descriptor().fields
        let value: unknown = form.state.values
        const rows: unknown[] = []
        for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/gu)) {
            if (match[2] !== undefined) {
                const index = Number(match[2])
                if (definition?.kind !== 'array' || !Array.isArray(value) || !Object.hasOwn(value, index))
                    throw invalid()
                definition = definition.item
                value = value[index]
                rows.push(toRaw(value))
            } else {
                const key = match[1]!
                if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid()
                if (definition) {
                    if (definition.kind !== 'object') throw invalid()
                    fields = definition.fields ?? {}
                }
                if (!Object.hasOwn(fields, key)) throw invalid()
                definition = fields[key]
                value = isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined
            }
            if (!definition) throw invalid()
        }
        if (!definition || !['image', 'images', 'file'].includes(definition.kind)) throw invalid()
        return { definition, rows, value }
    }
    const extensions = Object.fromEntries(
        Object.entries(factories).map(([name, factory]) => [
            name,
            factory({
                model: context.model,
                descriptor: context.descriptor,
                identity: computed(draftKey),
                values,
                entry: computed(currentEntry),
                busy: computed(() => operation.value !== null),
                signal: lifetime.signal,
                setField: setFieldValue,
                executeAction: context.client.executeAction,
                report: context.report,
            }),
        ]),
    )
    const result = {
        ...Object.fromEntries(Object.entries(extensions).map(([name, extension]) => [name, extension.namespace])),
        form,
        values: readonly(values) as Readonly<Ref<DeepReadonly<Data>>>,
        field: createFieldAccessor<Data>(form),
        save: async () => {
            published = undefined
            await form.handleSubmit()
            return published
        },
        state: computed(() => {
            const ready = Boolean(context.descriptor.value && (!context.id.value || currentEntry() || entryId.value))
            const busy =
                operation.value !== null || Object.values(extensions).some((extension) => extension.state.value.busy)
            const conflict = resource.error.value?.data?.code === 'LITI_CONFLICT'
            const available = ready && !busy && !conflict
            const can: Record<string, boolean> = {
                save: available,
                publish: available && descriptor().publishing,
                schedule: available && descriptor().scheduling,
                remove: !busy && Boolean(currentEntry()),
            }
            const reasons: Record<string, string> = {}
            for (const extension of Object.values(extensions)) {
                for (const [action, enabled] of Object.entries(extension.state.value.can ?? {}))
                    can[action] = (can[action] ?? (ready && !conflict)) && enabled
                Object.assign(reasons, extension.state.value.blocked)
            }
            return {
                ready,
                dirty: isDirty.value,
                restored: restoredDraft.value,
                identity: draftKey(),
                busy,
                canLeave: !busy,
                error: resource.error.value,
                conflict,
                can,
                blocked: Object.fromEntries(
                    Object.entries(can)
                        .filter(([, value]) => !value)
                        .map(([key]) => [
                            key,
                            reasons[key] ??
                                (!ready ? 'not-ready' : busy ? 'busy' : conflict ? 'conflict' : 'unavailable'),
                        ]),
                ),
            }
        }),
        operation: readonly(operation),
        fields: computed(() =>
            Object.entries(context.descriptor.value?.fields ?? {}).map(([key, field]) => ({
                ...field,
                key,
                name: key as Extract<keyof Data, string>,
                label:
                    field.label ??
                    key.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/^./u, (letter) => letter.toUpperCase()),
            })),
        ),
        publish: () => publish(),
        schedule: (value: Date | string) => {
            const at = new Date(value)
            if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
                context.report(new LitiClientError('LITI_INVALID_INPUT', 'Choose a future publication time.', 400))
                return Promise.resolve(undefined)
            }
            return publish(at.toISOString())
        },
        upload: (field: DeepKeys<Data>, files: File | File[] | null | undefined) => {
            if (lifetime.signal.aborted) return Promise.resolve(undefined)
            const selected = files ? (Array.isArray(files) ? files : [files]) : []
            if (!selected.length) return Promise.resolve([])
            let target: ReturnType<typeof uploadTarget>
            try {
                target = uploadTarget(field)
            } catch (cause) {
                context.report(cause)
                return Promise.resolve(undefined)
            }
            const currentTarget = () => {
                const current = uploadTarget(field)
                if (current.rows.some((row, index) => row !== target.rows[index]))
                    throw new LitiClientError(
                        'LITI_CONFLICT',
                        'The upload target changed. Select the image again.',
                        409,
                    )
                return current
            }
            const token = selected
                .map((file) => {
                    if (!uploadIds.has(file)) uploadIds.set(file, ++uploadSequence)
                    return uploadIds.get(file)
                })
                .join(',')
            return context
                .run(
                    'upload:' + field + ':' + token,
                    async (signal) => {
                        uploading.value = true
                        try {
                            const { definition } = currentTarget()
                            const identity = toValue(context.identity)
                            const records = []
                            for (const file of definition.kind === 'images' ? selected : selected.slice(0, 1)) {
                                const asset = litiAsset(
                                    await context.client.uploadAsset(file, { filename: file.name, signal }),
                                    (id) => context.client.assetUrl(id),
                                )
                                signal.throwIfAborted()
                                lifetime.signal.throwIfAborted()
                                if (identity !== toValue(context.identity))
                                    throw new DOMException('Resource identity changed during upload.', 'AbortError')
                                records.push(asset)
                                const current = currentTarget().value
                                setFieldValue(
                                    field,
                                    definition.kind === 'images'
                                        ? [...(Array.isArray(current) ? current : []), asset]
                                        : asset,
                                )
                                target = uploadTarget(field)
                            }
                            signal.throwIfAborted()
                            lifetime.signal.throwIfAborted()
                            try {
                                await options.onUpload?.({
                                    field,
                                    files: definition.kind === 'images' ? selected : selected.slice(0, 1),
                                    assets: records,
                                })
                            } catch (cause) {
                                if (!lifetime.signal.aborted && identity === toValue(context.identity))
                                    context.report(cause, true)
                            }
                            return records
                        } finally {
                            uploading.value = false
                        }
                    },
                    false,
                )
                .catch(() => undefined)
        },
        draft: {
            ensure: () => {
                if (ensurePending) return ensurePending
                if (entryId.value && version.value !== null)
                    return Promise.resolve({ id: entryId.value, version: version.value })
                ensuring = true
                ensurePending = (async () => {
                    try {
                        await form.handleSubmit()
                        return !resource.error.value && entryId.value && version.value !== null
                            ? { id: entryId.value, version: version.value }
                            : undefined
                    } finally {
                        ensuring = false
                        ensurePending = undefined
                    }
                })()
                return ensurePending
            },
            isDirty: hasUnsavedChanges,
            snapshot: () =>
                clone({
                    entryId: entryId.value,
                    version: version.value,
                    locale: toValue(context.locale),
                    draft: serialize(values.value),
                }),
            isStale: (snapshot: unknown) =>
                litiSnapshot(snapshot) !==
                litiSnapshot({
                    entryId: entryId.value,
                    version: version.value,
                    locale: toValue(context.locale),
                    draft: serialize(values.value),
                }),
            discard: async () => {
                delete context.drafts[storedKey]
                form.reset(present(baseline.value))
                await resource.refresh()
            },
        },
    }
    const setupUnload = () => {
        if (typeof window === 'undefined') return () => {}
        const handler = (event: BeforeUnloadEvent) => event.preventDefault()
        const stop = watch(
            () =>
                options.beforeUnload !== false &&
                (result.draft.isDirty.value || result.state.value.busy || toValue(options.beforeUnload) === true),
            (active) => window[active ? 'addEventListener' : 'removeEventListener']('beforeunload', handler),
            { immediate: true, flush: 'sync' },
        )
        return () => {
            stop()
            window.removeEventListener('beforeunload', handler)
        }
    }
    if (getCurrentInstance()) {
        let cleanup: (() => void) | undefined
        onMounted(() => {
            cleanup = setupUnload()
        })
        onScopeDispose(() => cleanup?.())
    }
    return result as typeof result & { [Name in keyof Extensions]: ReturnType<Extensions[Name]>['namespace'] }
}
