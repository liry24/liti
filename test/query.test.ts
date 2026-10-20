import { expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { createLitiClient } from '../packages/liti/src/public-client'
import { normalizeLitiQuery } from '../packages/liti/src/query'
import { projectQuery } from '../packages/vue/src/query'

it('normalizes many, keeps one nullable, and does not fetch an unresolved selector', async () => {
    const requests: string[] = []
    const client = createLitiClient({
        fetch: async (input) => {
            requests.push(String(input))
            return Response.json([{ data: { _liti: { id: 'one', model: 'posts' }, title: 'One' } }])
        },
    })
    expect(normalizeLitiQuery({})).toEqual(normalizeLitiQuery({ mode: 'many' }))
    expect(await client.query('posts')).toHaveLength(1)
    expect(await client.query('posts', { mode: 'many' })).toHaveLength(1)
    expect(await client.query('posts', { mode: 'one', id: undefined })).toBeNull()
    expect(requests).toEqual(['/api/liti/content/posts', '/api/liti/content/posts'])
    expect(() => normalizeLitiQuery({ mode: 'one' } as never)).toThrow('requires exactly one')
    expect(() => normalizeLitiQuery({ id: 'one' } as never)).toThrow('many query')
    expect(() => normalizeLitiQuery({ mode: 'one', id: 'one', path: '/one' } as never)).toThrow('exactly one')
})

it('keeps caller projections separate and discards a late asynchronous transform', async () => {
    const scope = effectScope()
    const raw = shallowRef<unknown>()
    let complete!: (value: unknown) => void
    const source = {
        data: raw,
        error: shallowRef<unknown>(),
        status: shallowRef<'idle' | 'pending' | 'success' | 'error'>('idle'),
        refresh: async () => {},
        execute: async () => {},
        clear: () => {
            raw.value = undefined
        },
    }
    try {
        const [plain, projected] = scope.run(() => [
            projectQuery(source, []),
            projectQuery(source, [], {
                transform: () =>
                    new Promise((resolve) => {
                        complete = resolve
                    }),
            }),
        ])!
        expect(plain!.handle.data.value).toEqual([])
        raw.value = [{ title: 'Original' }]
        const reference = plain!.handle.data
        expect(reference.value).toEqual([{ title: 'Original' }])
        raw.value = undefined
        complete(['late'])
        await nextTick()
        await projected!.ready()
        expect(plain!.handle.data).toBe(reference)
        expect(plain!.handle.data.value).toEqual([])
        expect(projected!.handle.data.value).toBeUndefined()
        expect(raw.value).toBeUndefined()
    } finally {
        scope.stop()
    }
})
