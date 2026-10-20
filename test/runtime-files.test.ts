import { expect, it, vi } from 'vitest'
import { withRuntimeEnv } from 'void/_env'
import { voidFilesStorage } from '../packages/void/src/files'
import { connectStorage } from '../packages/void/src/runtime-storage'

it('buffers local R2 uploads while retaining native Worker streams and request bindings', async () => {
    const binding = voidFilesStorage.config().binding as unknown as {
        put(key: string, body: ReadableStream): Promise<unknown>
    }
    const first = { put: vi.fn(async (_key: string, _body: unknown) => null) }
    const second = { put: vi.fn(async (_key: string, _body: unknown) => null) }
    const body = () => new Blob(['image']).stream()
    await withRuntimeEnv({ STORAGE: first }, () => binding.put('first', body()))
    expect(new TextDecoder().decode(first.put.mock.calls[0]![1] as ArrayBuffer)).toBe('image')
    vi.stubGlobal('FixedLengthStream', vi.fn())
    try {
        const stream = body()
        await withRuntimeEnv({ STORAGE: second }, () => binding.put('second', stream))
        expect(second.put).toHaveBeenCalledWith('second', stream)
        expect(first.put).toHaveBeenCalledTimes(1)
    } finally {
        vi.unstubAllGlobals()
    }
})

it('uses the selected Void R2 binding for bytes, copies and deletes without an HTTP SDK', async () => {
    const bytes = new Map<string, ArrayBuffer>()
    const bucket = {
        head: async (key: string) => (bytes.has(key) ? { size: bytes.get(key)!.byteLength } : null),
        get: async (key: string) =>
            bytes.has(key)
                ? {
                      body: new Blob([bytes.get(key)!]).stream(),
                      size: bytes.get(key)!.byteLength,
                      httpMetadata: { contentType: 'text/plain' },
                  }
                : null,
        put: vi.fn(async (key: string, body: ArrayBuffer) => {
            bytes.set(key, body)
            return { size: body.byteLength }
        }),
        delete: async (key: string) => {
            bytes.delete(key)
        },
    }
    await withRuntimeEnv({ STORAGE: bucket }, async () => {
        const resolve = await connectStorage({ projectRoot: process.cwd(), environment: [] })
        const store = await resolve('content')
        await expect(resolve('private')).rejects.toThrow('Configure named Files storage')
        expect(await store.read('absent')).toBeNull()
        await store.write('source', { body: new Blob(['hello']).stream(), size: 5, contentType: 'text/plain' })
        await store.copy('source', 'copy')
        expect(await new Response((await store.read('copy'))!.body).text()).toBe('hello')
        await store.delete('source')
        expect(await store.exists('source')).toBe(false)
        const signal = AbortSignal.abort()
        await expect(
            store.write('canceled', { body: new Blob(['bad']).stream(), size: 3, contentType: 'text/plain' }, signal),
        ).rejects.toThrow()
        expect(bucket.put).toHaveBeenCalledTimes(2)
        await expect(
            store.write('wrong-size', { body: new Blob(['bad']).stream(), size: 4, contentType: 'text/plain' }),
        ).rejects.toThrow('size does not match')
    })
})
