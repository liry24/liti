import type { BlobObject } from 'liti/adapter'

/** Preserve Workers' known-length streams and stop both ends when a write fails. */
export async function writeKnownLength(
    object: BlobObject,
    signal: AbortSignal | undefined,
    write: (body: ReadableStream<Uint8Array>) => Promise<number>,
): Promise<void> {
    signal?.throwIfAborted()
    const abort = new AbortController()
    const cancel = () => abort.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    const FixedLength = (
        globalThis as typeof globalThis & {
            FixedLengthStream?: new (size: number) => TransformStream<Uint8Array, Uint8Array>
        }
    ).FixedLengthStream
    let pumping: Promise<void> | undefined
    let body = object.body
    try {
        if (FixedLength) {
            const fixed = new FixedLength(object.size)
            pumping = body.pipeTo(fixed.writable, { signal: abort.signal })
            void pumping.catch(() => {})
            body = fixed.readable
        }
        const size = await write(body)
        await pumping
        signal?.throwIfAborted()
        if (size !== object.size) throw new Error('Stored upload size does not match the request body.')
    } catch (error) {
        abort.abort(error)
        await body.cancel(error).catch(() => {})
        await pumping?.catch(() => {})
        throw error
    } finally {
        signal?.removeEventListener('abort', cancel)
    }
}
