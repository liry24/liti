import type { ModelDefinition } from '../config'
import type { TranslationInput, Translations } from '../i18n'
import { LitiError } from '../errors'
import { validateModelData } from '../validation'

/** A locale update replaces that sparse override; absent locales are preserved. */
export const prepareTranslations = async (
    definition: ModelDefinition,
    data: Record<string, unknown>,
    defaultLocale: string,
    supported: readonly string[],
    input: TranslationInput = {},
    previous: Translations = {},
    prepare?: (data: Record<string, unknown>, locale: string) => Promise<Record<string, unknown>>,
): Promise<Translations> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new LitiError('LITI_INVALID_INPUT', 'Translations must be an object.')
    const output: Translations = structuredClone(previous)
    for (const [locale, value] of Object.entries(input)) {
        if (!supported.includes(locale) || locale === defaultLocale)
            throw new LitiError('LITI_INVALID_INPUT', `Invalid translation locale "${locale}".`)
        if (value === null) delete output[locale]
        else {
            if (typeof value !== 'object' || Array.isArray(value))
                throw new LitiError('LITI_INVALID_INPUT', 'Translation data must be an object.')
            output[locale] = structuredClone(value)
        }
    }
    for (const [locale, value] of Object.entries(output)) {
        for (const key of Object.keys(value))
            if (!definition.fields[key]?.i18n)
                throw new LitiError('LITI_INVALID_INPUT', `Field "${key}" is not translatable.`)
        const candidate = { ...data, ...value }
        const validated = prepare
            ? { data: await prepare(candidate, locale), issues: [] }
            : await validateModelData(definition, candidate)
        if (!validated.data)
            throw new LitiError('LITI_INVALID_INPUT', `Invalid ${locale} translation.`, validated.issues)
        output[locale] = Object.fromEntries(
            Object.entries(validated.data).filter(
                ([key, result]) =>
                    definition.fields[key]?.i18n &&
                    (Object.hasOwn(value, key) || JSON.stringify(result) !== JSON.stringify(candidate[key])),
            ),
        )
    }
    return output
}
