import { expect, it, vi } from 'vitest'
import type { RequestEvent } from 'nuxt/server'
import { useAdmin } from '../packages/nuxt/src/server-api'
import { configureLitiRuntime } from '../packages/nuxt/src/nuxt/server'
import { defineLitiConfig, text } from '../packages/liti/src'
import { createRuntime } from '../packages/liti/src/server'
import { createMemoryDatabase } from './memory-storage'
import { createManagementOperations } from '../packages/liti/src/server/operations'
import { createAdminClient } from '../packages/liti/src/admin-client'

it('runs event-bound AI without resolving content storage or an entry', async () => {
    const getLiti = vi.fn(() => {
        throw new Error('Content database must stay unopened')
    })
    const executeAction = vi.fn(async () => ({ text: 'Prepared' }))
    configureLitiRuntime({ managementBase: '/manage', publicBase: '/content', getLiti, executeAction })
    const event = { req: new Request('https://site.test/action') } as RequestEvent
    expect(await useAdmin(event).actions.run('prepare', { text: 'Input' })).toEqual({ text: 'Prepared' })
    expect(executeAction).toHaveBeenCalledWith(event, 'prepare', { text: 'Input' })
    expect(getLiti).not.toHaveBeenCalled()
    await expect(useAdmin().actions.run('prepare', {})).rejects.toMatchObject({ code: 'LITI_AUTH_REQUIRED' })
})

it('uses direct model-bound operations with one target read and redacts write-only results', async () => {
    let roles = ['operator']
    const admin = createRuntime({
        config: defineLitiConfig({
            authorization: { roles: { operator: { models: { posts: ['create', 'update', 'publish'] } } } },
            models: { posts: { fields: { title: text({ i18n: true }) } }, private: { fields: { title: text() } } },
        }),
        database: createMemoryDatabase(),
        locales: { defaultLocale: 'ja', supported: ['ja', 'en'] },
        authorize: () => ({ id: 'operator', roles }),
    })
    configureLitiRuntime({ managementBase: '/manage', publicBase: '/content', getLiti: () => admin })
    const event = { req: new Request('https://site.test/action') } as RequestEvent
    const client = useAdmin(event)
    let receipt = await client.entries.create('posts', {
        data: { title: 'secret' },
        translations: { en: { title: 'Secret' } },
    })
    expect(receipt).not.toHaveProperty('data')
    const read = vi.spyOn(admin, 'getEntry')
    receipt = await client.entries.update('posts', receipt, { translations: { en: { title: 'Changed' } } })
    // One target read, then the committed result is loaded once.
    expect(read).toHaveBeenCalledTimes(2)
    expect(receipt).not.toHaveProperty('translations')
    await expect(client.entries.update('private', receipt, { data: { secret: 'wrong model' } })).rejects.toMatchObject({
        code: 'LITI_ENTRY_NOT_FOUND',
    })
    await expect(useAdmin().entries.get('posts', receipt.id)).rejects.toMatchObject({
        code: 'LITI_AUTH_REQUIRED',
    })
    roles = ['admin']
    expect(await useAdmin(event).entries.get('posts', receipt.id)).toMatchObject({
        data: { title: 'secret' },
        translations: { en: { title: 'Changed' } },
    })
    vi.restoreAllMocks()
})

it('loads definitions once for a list and fetches an imperative update target only once', async () => {
    const admin = createRuntime({
        config: defineLitiConfig({ models: { posts: { fields: { title: text() } } } }),
        database: createMemoryDatabase(),
        authorize: () => ({ id: 'admin', roles: ['admin'] }),
    })
    const raw = createManagementOperations(() => admin, new Request('https://site.test/action'))
    const models = vi.spyOn(raw, 'models')
    const get = vi.spyOn(raw, 'getEntry')
    const client = createAdminClient(raw)
    const created = await client.entries.create('posts', { data: { title: 'First' } })
    await client.entries.create('posts', { data: { title: 'Second' } })
    expect((await client.entries.list('posts')).items).toHaveLength(2)
    expect(models).toHaveBeenCalledTimes(1)
    await client.entries.update('posts', created, { data: { title: 'Updated' } })
    expect(get).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
})

it('exposes the same authorized field and display descriptors from server and browser clients', async () => {
    const admin = createRuntime({
        config: defineLitiConfig({
            authorization: { roles: { editor: { models: { posts: ['readDraft'] } } } },
            models: {
                posts: {
                    meta: { label: 'Articles' },
                    displayFields: { title: 'heading' },
                    fields: { heading: text({ required: true }) },
                },
                private: { fields: { secret: text() } },
            },
        }),
        database: createMemoryDatabase(),
        authorize: () => ({ id: 'editor', roles: ['editor'] }),
    })
    const request = new Request('https://site.test/models')
    configureLitiRuntime({ managementBase: '/manage', publicBase: '/content', getLiti: () => admin })
    const browser = createAdminClient(createManagementOperations(() => admin, request))
    const models = await browser.models()
    expect(models.map((model) => model.name)).toEqual(['posts'])
    expect(models[0]).toMatchObject({
        meta: { label: 'Articles' },
        displayFields: { title: 'heading' },
        fields: { heading: { kind: 'text', required: true } },
        features: { publishing: true },
    })
    expect(await useAdmin({ req: request } as RequestEvent).models()).toEqual(models)
})
