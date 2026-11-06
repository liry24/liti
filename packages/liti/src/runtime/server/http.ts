import { ModelError, assertJson } from '@litijs/model'
import { createError, setResponseHeader, type H3Event } from 'h3'

export const object = (value: unknown): Record<string, unknown> => {
    assertJson(value)
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ModelError('LITI_INVALID_INPUT', 'Expected a JSON object.')
    return value as Record<string, unknown>
}
export const text = (value: unknown, required = true): string => {
    if (typeof value !== 'string' || (required && !value))
        throw new ModelError('LITI_INVALID_INPUT', 'Expected a string.')
    return value
}
export async function respond<T>(event: H3Event, task: () => Promise<T>) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8')
    try {
        return JSON.stringify((await task()) ?? null)
    } catch (error) {
        if (error instanceof ModelError)
            throw createError({
                statusCode: error.statusCode,
                message: error.message,
                data: { code: error.code, issues: error.issues },
            })
        if (error instanceof Error && 'code' in error && (error.code === 'AUTH_R0006' || error.code === 'AUTH_R0007'))
            throw createError({
                statusCode: 403,
                message: 'The request origin is not trusted.',
                data: { code: error.code },
            })
        throw error
    }
}
