import type { ModelDescriptor } from './descriptor'
import type { LitiEntry } from './client'
import { presentLitiData, serializeLitiData } from './management-assets'
import { resolveTranslation, type TranslationInput, type Translations } from './i18n'

export interface EntryFeatures {
    publishing: boolean
    scheduling: boolean
    revisions: boolean
    sortable: boolean
}

export interface EntryPrepareContext<Data extends Record<string, unknown> = Record<string, unknown>> {
    locale: string
    defaultLocale: string
    model: string
    resource: { display(value: Data): { title: string; description: string; image: string | undefined } }
    entry: LitiEntry<Data> | undefined
    features: EntryFeatures
    operation: 'save' | 'publish' | 'schedule'
    value: Data
    signal: AbortSignal
}

/** One candidate builder for forms and imperative clients; never mutates a live draft. */
export const prepareAdminEntry = async <Data extends Record<string, unknown>>(context: {
    model: string
    descriptor: ModelDescriptor
    entry?: LitiEntry<Data>
    input: { data?: Partial<Data>; translations?: TranslationInput<Data> }
    operation: EntryPrepareContext['operation']
    defaultLocale: string
    assetUrl: (id: string) => string
    signal: AbortSignal
    prepare?: (context: EntryPrepareContext<Data>) => void | Promise<void>
    resource: EntryPrepareContext<Data>['resource']
    guard?: () => void
}) => {
    const { entry, descriptor } = context
    const original = { ...entry?.data, ...context.input.data }
    const translations: Translations<Data> = structuredClone(entry?.translations ?? {}) as Translations<Data>
    for (const [locale, value] of Object.entries(context.input.translations ?? {})) {
        if (value === null) delete translations[locale]
        else translations[locale] = value as Partial<Data>
    }
    const prepareValue = async (value: Record<string, unknown>, locale: string) => {
        const data = presentLitiData(descriptor, structuredClone(value), context.assetUrl)
        await context.prepare?.({
            model: context.model,
            entry: entry
                ? {
                      ...entry,
                      locale,
                      data: presentLitiData<Data>(descriptor, resolveTranslation(entry, locale).data, context.assetUrl),
                  }
                : undefined,
            operation: context.operation,
            value: data as Data,
            locale,
            defaultLocale: context.defaultLocale,
            resource: context.resource,
            features: descriptor,
            signal: context.signal,
        })
        context.signal.throwIfAborted()
        context.guard?.()
        return serializeLitiData(descriptor, data)
    }
    const data =
        context.operation === 'save' && entry && !Object.keys(context.input.data ?? {}).length
            ? original
            : await prepareValue(original, context.defaultLocale)
    for (const [locale, override] of Object.entries(translations)) {
        if (context.operation === 'save' && !Object.hasOwn(context.input.translations ?? {}, locale)) continue
        const before = { ...original, ...override }
        const prepared = await prepareValue(before, locale)
        translations[locale] = Object.fromEntries(
            Object.keys(descriptor.fields)
                .filter(
                    (key) =>
                        descriptor.fields[key]!.i18n &&
                        (Object.hasOwn(override, key) || JSON.stringify(prepared[key]) !== JSON.stringify(before[key])),
                )
                .map((key) => [key, prepared[key]]),
        ) as Partial<Data>
    }
    const changes: TranslationInput<Data> = {
        ...Object.fromEntries(Object.keys(entry?.translations ?? {}).map((locale) => [locale, null])),
        ...translations,
    }
    return { data: data as Data, ...(Object.keys(changes).length ? { translations: changes } : {}) }
}

/** Transport-independent field encoding for partial writes. */
export const serializeAdminInput = <Input extends { data?: Record<string, unknown>; translations?: TranslationInput }>(
    descriptor: ModelDescriptor,
    input: Input,
): Input =>
    ({
        ...input,
        ...(input.data === undefined ? {} : { data: serializeLitiData(descriptor, input.data) }),
        ...(input.translations === undefined
            ? {}
            : {
                  translations: Object.fromEntries(
                      Object.entries(input.translations).map(([locale, data]) => [
                          locale,
                          data === null ? null : serializeLitiData(descriptor, data),
                      ]),
                  ),
              }),
    }) as Input
