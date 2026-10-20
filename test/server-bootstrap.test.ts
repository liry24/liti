import { expect, it, vi } from 'vitest'
import { createLiti } from '../packages/liti/src/server'
import { defineLitiConfig, text } from '../packages/liti/src'
import { createMemoryDatabase } from './memory-storage'
import type { DatabaseAdapter, OperationContext } from '../packages/liti/src/plugins'
import { z } from 'zod'

const bootstrap = { projectRoot: process.cwd() }
const database = (): DatabaseAdapter => ({
    id: 'test-memory',
    role: 'database',
    connect: () => createMemoryDatabase(),
})
const actor = { id: 'writer', roles: ['writer'] }
const config = () =>
    defineLitiConfig({
        adapter: { database: database() },
        authorization: { roles: { writer: { models: { posts: ['create', 'update', 'publish'] } } } },
        models: { posts: { fields: { title: text({ required: true }) } } },
    })

it('uses the same action ACL and validation for trusted service and HTTP calls', async () => {
    const execute = vi.fn((input: { text: string }, context: OperationContext) => ({
        data: input.text.toUpperCase(),
        metadata: { actor: context.actor!.id, platform: context.platformContext },
    }))
    const api = await createLiti(
        defineLitiConfig({
            adapter: { database: database() },
            authorization: { roles: { writer: { actions: ['upper'] } } },
            plugins: [
                {
                    id: 'actions',
                    apiVersion: 1,
                    actions: { upper: { input: z.object({ text: z.string() }), output: z.string(), execute } },
                },
            ],
        }),
        { ...bootstrap, authenticate: () => actor },
    )
    try {
        const platform = { binding: 'synthetic' }
        const service = await api.service({ actor, platformContext: platform })
        expect(await service.executeAction('upper', { text: 'trusted' })).toEqual({
            data: 'TRUSTED',
            metadata: { actor: 'writer', platform },
        })
        const response = await api.fetch(
            new Request('https://example.test/api/liti/actions/upper', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ input: { text: 'http' } }),
            }),
            platform,
        )
        expect(await response.json()).toEqual({ data: 'HTTP', metadata: { actor: 'writer', platform } })
        const denied = await api.service({ actor: { id: 'other', roles: [] } })
        await expect(denied.executeAction('upper', { text: 'forbidden' })).rejects.toMatchObject({
            code: 'LITI_FORBIDDEN',
        })
        expect(execute).toHaveBeenCalledTimes(2)
    } finally {
        await api.close()
    }
})

it('shares ACL, actor identity and write-only receipts between service and HTTP', async () => {
    const events: string[] = []
    const authenticate = vi.fn(async () => actor)
    const api = await createLiti(config(), {
        ...bootstrap,
        authenticate,
        afterCommit: (event) => {
            events.push(event.actorId ?? '')
        },
    })
    const service = await api.service({ actor })
    const first = await service.createEntry('posts', { data: { title: 'Private draft' } })
    expect(first).not.toHaveProperty('data')
    expect(authenticate).not.toHaveBeenCalled()
    await expect(service.getEntry(first.id)).rejects.toMatchObject({ code: 'LITI_FORBIDDEN' })
    const response = await api.fetch(
        new Request('https://example.test/api/liti/entries/posts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actorId: 'spoofed-admin', data: { title: 'HTTP draft' } }),
        }),
    )
    expect(response.status).toBe(201)
    expect(await response.json()).not.toHaveProperty('data')
    expect(events).toEqual(['writer', 'writer'])
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect((await api.fetch(new Request('https://example.test/unrelated'))).status).toBe(404)
    await api.close()
})

it('starts the public API without authentication and rejects unauthenticated management', async () => {
    const api = await createLiti(config(), bootstrap)
    const service = await api.service({})
    await expect(service.createEntry('posts', { data: { title: 'Denied' } })).rejects.toMatchObject({
        code: 'LITI_AUTH_REQUIRED',
    })
    const response = await api.fetch(new Request('https://example.test/api/liti/content/posts'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
    expect((await api.fetch(new Request('https://example.test/api/liti/models'))).status).toBe(401)
})

it('rejects competing authentication owners before connecting', async () => {
    const connect = vi.fn(() => createMemoryDatabase())
    const input = defineLitiConfig({
        adapter: {
            database: { ...database(), connect },
            auth: { id: 'auth', role: 'auth', authenticate: () => actor },
        },
    })
    await expect(createLiti(input, { ...bootstrap, authenticate: () => actor })).rejects.toMatchObject({
        code: 'LITI_INVALID_INPUT',
    })
    expect(connect).not.toHaveBeenCalled()
})

it('closes an owned connection when schema verification fails and never applies a migration', async () => {
    const native = createMemoryDatabase()
    const close = vi.fn()
    const input = defineLitiConfig({
        adapter: {
            database: {
                ...database(),
                connect: () => ({
                    close,
                    bind: (definition) => ({
                        ...native.bind(definition),
                        assertSchema: async () => {
                            throw new Error('Apply generated migration first')
                        },
                    }),
                }),
            },
        },
    })
    await expect(createLiti(input, bootstrap)).rejects.toThrow('Apply generated migration first')
    expect(close).toHaveBeenCalledTimes(1)
})

it('uses trusted context for enabled tasks and stops an aborted service operation', async () => {
    const api = await createLiti(
        defineLitiConfig({
            ...config(),
            tasks: { publishDue: true },
        }),
        bootstrap,
    )
    await expect(api.tasks.publishDue({})).rejects.toMatchObject({ code: 'LITI_AUTH_REQUIRED' })
    await expect(api.tasks.publishDue({ actor })).rejects.toMatchObject({ code: 'LITI_FORBIDDEN' })
    const context: OperationContext = { actor: { id: 'scheduler', roles: ['admin'] } }
    expect(await api.tasks.publishDue(context)).toMatchObject({ published: [] })
    await expect(api.tasks.rebuildSearch(context)).rejects.toMatchObject({ code: 'LITI_FORBIDDEN' })
    const abort = new AbortController()
    const service = await api.service({ ...context, signal: abort.signal })
    abort.abort(new Error('Cancelled task'))
    await expect(service.createEntry('posts', { data: { title: 'Cancelled' } })).rejects.toThrow('Cancelled task')
})
