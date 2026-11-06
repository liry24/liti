import { defineEventHandler, getQuery } from 'h3'
import { ModelError } from '@litijs/model'
import runtime from '#liti/runtime'
import { object, text, respond } from './http'

export default defineEventHandler((event) =>
    respond(event, async () => {
        const input = getQuery(event)
        if (input.action === 'models') return await runtime.descriptors()
        const mode = input.mode ?? 'many'
        if (mode !== 'many' && mode !== 'one') throw new ModelError('LITI_INVALID_INPUT', 'Invalid query mode.')
        if (input.fallback !== undefined && input.fallback !== 'true' && input.fallback !== 'false')
            throw new ModelError('LITI_INVALID_INPUT', 'Invalid fallback value.')
        let filter: Record<string, unknown> | undefined
        if (input.filter !== undefined) {
            try {
                filter = object(JSON.parse(text(input.filter)))
            } catch {
                throw new ModelError('LITI_INVALID_INPUT', 'Invalid query filter.')
            }
        }
        if (mode === 'many' && (input.id !== undefined || input.path !== undefined))
            throw new ModelError('LITI_INVALID_INPUT', 'IDs and paths require a single query.')
        if (mode === 'one' && input.id !== undefined && input.path !== undefined)
            throw new ModelError('LITI_INVALID_INPUT', 'Choose an ID or a public path.')
        return await runtime.query({
            model: text(input.model),
            mode,
            ...(input.id !== undefined ? { id: text(input.id) } : {}),
            ...(input.path !== undefined ? { path: text(input.path) } : {}),
            ...(input.locale !== undefined ? { locale: text(input.locale) } : {}),
            ...(input.fallback !== undefined ? { fallback: input.fallback !== 'false' } : {}),
            ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
            ...(input.offset !== undefined ? { offset: Number(input.offset) } : {}),
            ...(filter ? { filter } : {}),
        })
    }),
)
