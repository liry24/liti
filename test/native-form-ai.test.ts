import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { defineLitiConfig, resolveLitiConfig, text } from '../packages/liti/src'
import { executeAction } from '../packages/liti/src/server/actions'
import { ai, createTextAction } from '../packages/ai/src'
import { aiSdk } from '../packages/ai/src/ai-sdk'
import { handleActionRequest } from '../packages/liti/src/server/actions-http'
import { useEntryForm } from '../packages/vue/src/form'
import { createRuntime, handleManagementRequest } from '../packages/liti/src/server'
import { createMemoryDatabase } from './memory-storage'
import { modelFixture } from './model-fixture'

const generated = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
})
const setup = (run: MockLanguageModelV4['doGenerate']) => {
    const platformContext = { binding: 'native-app' }
    const model = new MockLanguageModelV4({ doGenerate: run })
    const modelResolver = vi.fn(async () => model)
    const config = resolveLitiConfig(
        defineLitiConfig({
            models: { notes: { fields: { slug: text(), title: text({ required: true }), summary: text() } } },
            plugins: [
                ai({
                    provider: aiSdk({ text: modelResolver }),
                    actions: {
                        prepare: createTextAction({
                            input: z.object({ content: z.string() }).strict(),
                            prompt: ({ content }) => content,
                            output: z.object({
                                data: z.object({ title: z.string().optional(), summary: z.string().optional() }),
                            }),
                        }),
                    },
                }),
            ],
        }),
        [],
    )
    const actor = { id: 'admin', roles: ['admin'] }
    const database = createMemoryDatabase()
    const assertSchema = vi.spyOn(database.storage, 'assertSchema')
    const commit = vi.spyOn(database.storage, 'commit')
    const admin = createRuntime({ config, database, authorize: () => actor })
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        return String(input).includes('/actions/')
            ? handleActionRequest(request, '/api/liti', (name, payload) =>
                  executeAction(config, name as 'prepare', payload as { content: string }, {
                      actor,
                      request,
                      platformContext,
                  }),
              )
            : handleManagementRequest(admin, request)
    }
    return { admin, database, assertSchema, commit, fetch, modelResolver, platformContext }
}

describe('app-owned native AI with resource forms', () => {
    it('does not initialize CMS or save when generating an explicit proposal', async () => {
        const run = vi.fn(async () => generated({ data: { summary: 'Proposed' } }))
        const { admin, fetch, assertSchema, commit, modelResolver, platformContext } = setup(run)
        const fixture = modelFixture(fetch, null, {}, { model: 'notes', descriptor: admin.descriptor.models.notes! })
        const formState = useEntryForm(fixture.resource, { defaultValues: { title: 'Manual' } })
        const before = formState.draft.snapshot()
        const result = (await fixture.client.executeAction('prepare', { content: 'Manual' })).data as {
            data: { summary: string }
        }
        expect(formState.draft.isStale(before)).toBe(false)
        expect(assertSchema).not.toHaveBeenCalled()
        expect(commit).not.toHaveBeenCalled()
        expect(modelResolver).toHaveBeenCalledWith(
            expect.objectContaining({
                actor: { id: 'admin', roles: ['admin'] },
                request: expect.any(Request),
                platformContext,
            }),
        )
        formState.form.setFieldValue('summary', result.data.summary)
        await formState.form.handleSubmit()
        expect(fixture.resource.error.value).toBeUndefined()
        expect(commit).toHaveBeenCalledOnce()
        expect((await admin.getEntry(formState.draft.snapshot().entryId!)).data).toEqual({
            title: 'Manual',
            summary: 'Proposed',
        })
        expect(run).toHaveBeenCalledOnce()
    })
    it('preserves the input and optimistic version if another writer commits during AI generation', async () => {
        const pending = Promise.withResolvers<Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>>()
        const started = Promise.withResolvers<void>()
        const { admin, fetch } = setup(async () => {
            started.resolve()
            return pending.promise
        })
        const entry = await admin.createEntry('notes', { data: { slug: '', title: 'Stored' } })
        const fixture = modelFixture(fetch, entry, {}, { model: 'notes', descriptor: admin.descriptor.models.notes! })
        const formState = useEntryForm(fixture.resource)
        const proposal = fixture.client.executeAction('prepare', { content: 'Stored' })
        await started.promise
        await admin.updateEntry(entry.id, {
            expectedVersion: entry.version,
            data: { slug: entry.data.slug, title: 'Elsewhere' },
        })
        pending.resolve(generated({ data: { summary: 'Proposed' } }))
        const result = (await proposal).data as { data: { summary: string } }
        formState.form.setFieldValue('summary', result.data.summary)
        await formState.form.handleSubmit()
        expect(fixture.resource.error.value?.data?.code).toBe('LITI_CONFLICT')
        expect(formState.draft.snapshot().version).toBe(entry.version)
        expect(formState.form.state.values).toEqual({ title: 'Stored', summary: 'Proposed', slug: '' })
        expect((await admin.getEntry(entry.id)).data.title).toBe('Elsewhere')
    })
})
