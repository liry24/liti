import { ModelError, type ModelIssue } from './errors'
import type { Fields, InferData } from './model'

export async function queryFilter(fields: Fields, input: Record<string, unknown> = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new ModelError('LITI_INVALID_INPUT', 'Filters must be a JSON object.')
    assertJson(input)
    const result: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(input)) {
        const field = fields[key]
        if (!field || field.public === false)
            throw new ModelError('LITI_INVALID_INPUT', 'Filters require a public model field.')
        const checked = await field.schema['~standard'].validate(value)
        if (
            checked.issues ||
            (checked.value !== null && !['string', 'number', 'boolean'].includes(typeof checked.value))
        )
            throw new ModelError('LITI_INVALID_INPUT', 'Filters require a valid scalar field value.')
        result[key] = checked.value as string | number | boolean | null
    }
    assertJson(result)
    return result
}

export function assertJson(value: unknown, path: (string | number)[] = []): void {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
    )
        return
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJson(item, [...path, index]))
        return
    }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key))
                throw new ModelError('LITI_INVALID_INPUT', 'Unsafe object key.')
            assertJson(item, [...path, key])
        }
        return
    }
    throw new ModelError('LITI_INVALID_INPUT', 'Model data must be finite JSON values.', [
        { path, message: 'Not a JSON value.' },
    ])
}

export async function validateData<F extends Fields>(
    fields: F,
    input: unknown,
    options: { sparse?: boolean; localizedOnly?: boolean } = {},
): Promise<InferData<F>> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new ModelError('LITI_INVALID_INPUT', 'Expected model fields.')
    const data = input as Record<string, unknown>
    const output: Record<string, unknown> = {}
    const issues: ModelIssue[] = []
    for (const key of Object.keys(data))
        if (!fields[key] || (options.localizedOnly && !fields[key].localized))
            issues.push({ path: [key], message: 'Unknown or non-translated field.' })
    for (const [key, definition] of Object.entries(fields)) {
        if (options.localizedOnly && !definition.localized) continue
        if (options.sparse && !Object.hasOwn(data, key)) continue
        const result = await definition.schema['~standard'].validate(data[key])
        if (result.issues) {
            for (const issue of result.issues)
                issues.push({
                    path: [
                        key,
                        ...(issue.path ?? []).map((part) =>
                            typeof part === 'object'
                                ? String(part.key)
                                : typeof part === 'number'
                                  ? part
                                  : String(part),
                        ),
                    ],
                    message: issue.message,
                })
        } else if (result.value !== undefined) {
            assertJson(result.value, [key])
            const stable = await definition.schema['~standard'].validate(result.value)
            if (stable.issues || JSON.stringify(stable.value) !== JSON.stringify(result.value))
                throw new ModelError(
                    'LITI_INVALID_MODEL',
                    `Field ${key} must validate its canonical stored value without changing it again.`,
                )
            output[key] = result.value
        }
    }
    if (issues.length) throw new ModelError('LITI_INVALID_INPUT', 'Model validation failed.', issues)
    assertJson(output)
    return output as InferData<F>
}

export function referenceValues(value: unknown, path: string): string[] {
    const visit = (current: unknown, parts: string[]): string[] => {
        if (!parts.length) {
            if (current === undefined || current === null) return []
            if (Array.isArray(current)) return current.flatMap((item) => visit(item, []))
            if (typeof current !== 'string')
                throw new ModelError('LITI_REFERENCE', 'References must contain stable IDs.')
            return [current]
        }
        const [key, ...rest] = parts
        if (key === '*') return Array.isArray(current) ? current.flatMap((item) => visit(item, rest)) : []
        return current && typeof current === 'object' && Object.hasOwn(current, key!)
            ? visit((current as Record<string, unknown>)[key!], rest)
            : []
    }
    return visit(value, path.split('.'))
}
