import { createError, defineEventHandler, getRequestURL, readBody } from 'h3'

const failed = new Set<string>()
export default defineEventHandler(async (event) => {
    if (event.method !== 'POST' || getRequestURL(event).pathname !== '/api/_liti/manage') return
    const input = await readBody<{ action?: string; id?: string; data?: { title?: string } }>(event)
    if (input?.action === 'save' && input.id && input.data?.title === 'Recovered browser' && !failed.has(input.id)) {
        failed.add(input.id)
        throw createError({ statusCode: 503, message: 'Synthetic transient save failure' })
    }
})
