import { expect, test as base, vi } from 'vitest'
import { createTestLiti } from '@litijs/test-utils'
import { litiFixture } from '@litijs/test-utils/vitest'
import { defineLitiConfig, text } from 'liti'
import { z } from 'zod'
import type { TestContext } from 'vitest'

const actor = { id: 'writer', roles: ['writer'] }
const authenticate = vi.fn(() => actor)
const connect = vi.fn(() => {
    throw new Error('Production adapter must not connect')
})
const config = defineLitiConfig({
    adapter: { database: { id: 'production', role: 'database', connect } },
    models: { notes: { fields: { title: text({ required: true }) } } },
    authorization: { roles: { writer: { models: { notes: ['create', 'readDraft', 'publish'] }, actions: ['upper'] } } },
    plugins: [
        {
            id: 'example',
            apiVersion: 1,
            actions: {
                upper: {
                    input: z.object({ value: z.string() }),
                    output: z.string(),
                    execute: ({ value }: { value: string }) => ({ data: value.toUpperCase() }),
                },
            },
        },
    ],
})
const test = base.extend({
    liti: litiFixture(config, {
        authenticate,
        now: () => new Date('2026-10-26T00:00:00Z'),
    }),
})

test('uses real service and HTTP contracts with isolated storage and inferred action types', async ({ liti }) => {
    const service = await liti.service({ actor })
    // @ts-expect-error Invalid inputs still pass through runtime validation.
    await expect(service.createEntry('notes', { data: {} })).rejects.toMatchObject({ code: 'LITI_INVALID_INPUT' })
    const saved = await service.createEntry('notes', { data: { title: 'Private' } })
    const entry = await liti.client.getEntry(saved.id)
    expect(entry.data.title).toBe('Private')
    expect(entry.createdAt).toBe('2026-10-26T00:00:00.000Z')
    expect(await liti.client.query('notes')).toEqual([])
    await service.publishEntry(saved.id, { expectedVersion: saved.version })
    expect(await liti.client.query('notes')).toMatchObject([{ data: { title: 'Private' } }])
    const result: string = (await liti.client.executeAction('upper', { value: 'test' })).data
    expect(result).toBe('TEST')
    const platformContext = { binding: 'synthetic' }
    expect((await liti.fetch(new Request('http://liti.test/api/liti/models'), platformContext)).status).toBe(200)
    expect(authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ platformContext }))
    expect(connect).not.toHaveBeenCalled()
})

base('closes its instance when a fixture consumer throws', async () => {
    let instance: Awaited<ReturnType<typeof createTestLiti<typeof config>>> | undefined
    const failure = new Error('test failure')
    await expect(
        litiFixture(config)({} as TestContext, async (liti) => {
            instance = liti
            throw failure
        }),
    ).rejects.toBe(failure)
    await expect(instance!.service({ actor })).rejects.toThrow('closed')
})

test('a subsequent fixture starts empty', async ({ liti }) => {
    expect(await liti.client.listEntries('notes')).toMatchObject({ items: [], total: 0 })
})

base('defaults to anonymous and keeps simultaneous instances independent', async () => {
    const first = await createTestLiti(config)
    const second = await createTestLiti(config)
    try {
        const service = await first.service({ actor })
        await service.createEntry('notes', { data: { title: 'Only first' } })
        await expect(first.client.listEntries('notes')).rejects.toMatchObject({ code: 'LITI_AUTH_REQUIRED' })
        expect(await (await second.service({ actor })).listEntries('notes')).toMatchObject({ total: 0 })
        expect((await first.fetch(new Request('http://liti.test/api/liti/models'))).status).toBe(401)
    } finally {
        await first.close()
        await second.close()
    }
    await first.close()
    await expect(first.service({ actor })).rejects.toThrow('closed')
})
