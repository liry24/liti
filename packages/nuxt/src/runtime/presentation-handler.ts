import { defineEventHandler } from 'nuxt/server'
import { useLitiRuntime } from '../nuxt/server'
import { withLitiContext } from './context'
import { LitiError } from '../../../liti/src/errors'

export default defineEventHandler((event) =>
    withLitiContext(event.context, async () => {
        if (event.req.method !== 'GET' && event.req.method !== 'HEAD') return new Response(null, { status: 405 })
        const path = new URL(event.req.url).searchParams.get('path') ?? '/'
        if (!path.startsWith('/') || path.startsWith('//')) return new Response(null, { status: 400 })
        try {
            const value = await useLitiRuntime().presentation?.(event, new URL(path, 'http://liti.local').pathname)
            return Response.json(value ?? {}, { headers: { 'cache-control': 'private, no-store' } })
        } catch (error) {
            if (error instanceof LitiError && error.code === 'LITI_INVALID_INPUT')
                return Response.json(
                    { error: { code: error.code, message: error.message } },
                    { status: error.status, headers: { 'cache-control': 'private, no-store' } },
                )
            throw error
        }
    }),
)
