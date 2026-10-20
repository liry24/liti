import { expect, it } from 'vitest'
import { createError, type RequestEvent } from 'nuxt/server'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineLitiConfig, text } from '../packages/liti/src'
import { configureLitiRuntime, normalizeLitiAuthorizationError } from '../packages/nuxt/src/nuxt/server'
import management from '../packages/nuxt/src/runtime/management-handler'
import publicHandler from '../packages/nuxt/src/runtime/public-handler'
import middleware from '../packages/nuxt/src/runtime/database-middleware'
import { createRuntime } from '../packages/liti/src/server'
import { migrateTestDatabase, testAdapter } from './migrate'

const event = (path: string, authorization?: string, method = 'GET'): RequestEvent => {
    const req = new Request('http://localhost' + path, {
        method,
        ...(authorization ? { headers: { authorization } } : {}),
    })
    return { req, url: new URL(req.url), context: {}, res: { headers: new Headers() } }
}

it('awaits request initialization and keeps context identity isolated', async () => {
    const initialized = new WeakSet<object>()
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
        release = resolve
    })
    configureLitiRuntime({
        publicBase: '/api/content',
        managementBase: '/api/liti',
        getLiti: () => {
            throw new Error('Not needed in middleware')
        },
        initializeRequest: async (request) => {
            await ready
            initialized.add(request.context)
        },
    })
    const first = event('/api/auth/get-session'),
        second = event('/api/auth/get-session')
    const pending = middleware(first)
    expect(initialized.has(first.context)).toBe(false)
    release()
    await pending
    expect(initialized.has(first.context)).toBe(true)
    expect(initialized.has(second.context)).toBe(false)
    await middleware(second)
    expect(initialized.has(second.context)).toBe(true)
})

it('native HTTP handlers preserve intentional auth statuses, redact errors and return Web responses', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    const config = defineLitiConfig({ models: { posts: { fields: { slug: text(), title: text() } } } })
    try {
        await migrateTestDatabase(database, config)
        const adapter = await testAdapter(database, config)
        const admin = createRuntime<RequestEvent>({
            config,
            database: adapter,
            authorize: (_request, context) => {
                try {
                    const mode = context?.req.headers.get('authorization')
                    if (mode === 'denied') throw createError({ status: 403, message: 'PRIVATE_DENIAL' })
                    if (mode === 'broken') throw new Error('PRIVATE_FAILURE')
                    return mode ? { id: mode, roles: ['admin'] } : null
                } catch (error) {
                    throw normalizeLitiAuthorizationError(error)
                }
            },
        })
        configureLitiRuntime({
            publicBase: '/api/content',
            managementBase: '/api/liti',
            getLiti: () => admin,
        })
        for (const [mode, status, code] of [
            [undefined, 401, 'LITI_AUTH_REQUIRED'],
            ['denied', 403, 'LITI_FORBIDDEN'],
            ['broken', 500, 'LITI_INTERNAL_ERROR'],
        ] as const) {
            const response = await management(event('/api/liti/models', mode))
            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(status)
            expect(response.headers.get('cache-control')).toBe('private, no-store')
            expect(response.headers.get('x-content-type-options')).toBe('nosniff')
            const body = await response.text()
            expect(JSON.parse(body).error.code).toBe(code)
            expect(body).not.toContain('PRIVATE_')
        }
        const successful = await management(event('/api/liti/models', 'admin'))
        expect(successful.status).toBe(200)
        const read = await publicHandler(event('/api/content/posts'))
        expect(read.status).toBe(200)
        expect(read.headers.get('access-control-allow-origin')).toBe('*')
        const head = event('/api/content/posts', undefined, 'HEAD')
        const response = await publicHandler(head)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('')
    } finally {
        await database.dispose()
    }
})
