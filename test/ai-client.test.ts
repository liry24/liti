import { describe, expect, it, vi } from 'vitest'
import { createLitiManagementClient } from '../packages/liti/src/client'

describe('native named AI management client', () => {
    it('posts explicit input with native cancellation and same-origin credentials without invalidating saved data', async () => {
        const onMutation = vi.fn()
        const calls: Array<{ body: unknown; url: string }> = []
        const signal = new AbortController().signal
        const proposal = { data: { title: 'Proposed' }, issues: [] }
        const client = createLitiManagementClient({
            basePath: '/manage/',
            onMutation,
            fetch: async (input, init) => {
                expect(init?.credentials).toBe('same-origin')
                expect(init?.signal).toBe(signal)
                expect(init?.method).toBe('POST')
                calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
                return Response.json(proposal)
            },
        })
        expect(await client.executeAction('correct/title', { content: 'Manual' }, { signal })).toEqual(proposal)
        expect(calls).toEqual([{ url: '/manage/actions/correct%2Ftitle', body: { input: { content: 'Manual' } } }])
        expect(onMutation).not.toHaveBeenCalled()
        expect(client).not.toHaveProperty('generateMetadata')
        expect(client).not.toHaveProperty('proofreadDraft')
        expect(client).not.toHaveProperty('runAIAction')
    })
    it('preserves native action errors without a save or retry', async () => {
        const request = vi.fn(async () =>
            Response.json({ error: { code: 'LITI_AI_UNAVAILABLE', message: 'Unavailable' } }, { status: 503 }),
        )
        const client = createLitiManagementClient({ fetch: request })
        await expect(client.executeAction('metadata', {})).rejects.toMatchObject({
            code: 'LITI_AI_UNAVAILABLE',
            status: 503,
        })
        expect(request).toHaveBeenCalledOnce()
    })
})
