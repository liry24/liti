import { ModelError, assertIdentity } from '../definition/errors'
import type { ContentModel } from '../definition/model'

export function modelLocale(model: ContentModel, locale?: string) {
    const selected = locale ?? model.locales?.default ?? 'und'
    if (!(model.locales?.supported ?? ['und']).includes(selected))
        throw new ModelError('LITI_INVALID_INPUT', 'Unsupported model locale.')
    return selected
}
export function documentId(model: ContentModel, id: string, locale?: string) {
    const selected = modelLocale(model, locale)
    return `${assertIdentity(id)}/${selected}`
}
export function splitDocumentId(id: string) {
    const [entry, locale, ...rest] = id.split('/')
    if (!entry || !locale || rest.length) throw new ModelError('LITI_INVALID_INPUT', 'Invalid model document ID.')
    assertIdentity(entry)
    return { id: entry, locale }
}

export function resolveTranslation(
    model: ContentModel,
    original: Record<string, unknown>,
    translated: Record<string, unknown>,
    fallback: boolean,
) {
    const result: Record<string, unknown> = {}
    for (const [key, definition] of Object.entries(model.fields)) {
        if (!definition.localized || (!Object.hasOwn(translated, key) && fallback)) {
            if (Object.hasOwn(original, key)) result[key] = original[key]
        } else if (Object.hasOwn(translated, key)) result[key] = translated[key]
    }
    return result
}
