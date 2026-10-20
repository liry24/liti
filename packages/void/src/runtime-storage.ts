import type { AdapterContext, BlobStorage, BlobStorageResolver } from 'liti/adapter'
import { LitiError } from 'liti/adapter'
import { createFilesStorage } from './storage'
import type { Files } from 'files-sdk'
import { voidFilesStorage } from './files'
import { writeKnownLength } from './stream'

export const connectStorage = async (context: AdapterContext): Promise<BlobStorageResolver> => {
    const host = context.platformContext as { files?: (name: string) => Files | Promise<Files> } | undefined
    if (host?.files) return createFilesStorage(async (name) => host.files!(name))
    const bucket = voidFilesStorage.config().binding
    const store: BlobStorage = {
        identity: bucket,
        exists: async (key) => Boolean(await bucket.head(key)),
        async read(key, signal) {
            signal?.throwIfAborted()
            const object = await bucket.get(key)
            if (!object) return null
            // Workers and DOM declare different BYOB reader types for the same Web stream.
            return {
                body: object.body as unknown as ReadableStream<Uint8Array>,
                size: object.size,
                contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
            }
        },
        async write(key, object, signal) {
            await writeKnownLength(object, signal, async (body) => {
                const stored = await bucket.put(key, body as unknown as Parameters<typeof bucket.put>[1], {
                    httpMetadata: { contentType: object.contentType },
                })
                if (!stored) throw new Error('R2 did not store the upload.')
                return stored.size
            })
        },
        async copy(source, target, signal) {
            const object = await store.read(source, signal)
            if (!object) throw new Error('The R2 source object does not exist.')
            await store.write(target, object, signal)
        },
        async delete(key, signal) {
            signal?.throwIfAborted()
            await bucket.delete(key)
        },
    }
    return async (name) => {
        if (name !== 'content')
            throw new LitiError('LITI_INVALID_INPUT', `Configure named Files storage "${name}" in the host.`)
        return store
    }
}
