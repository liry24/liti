import type { Files } from 'files-sdk'
import type { BlobObject, BlobStorage, BlobStorageResolver } from 'liti/adapter'
import { writeKnownLength } from './stream'

const identity = (files: Files): object | string => {
    const raw = files.raw
    if (raw && typeof raw === 'object') {
        if (files.adapter.name === 'r2-binding') return raw
        if (files.adapter.name === 'fs' && 'root' in raw && typeof raw.root === 'string') return `fs:${raw.root}`
    }
    return files.adapter
}

/** Keep provider details and Workers' known-length streaming inside the storage adapter. */
export function createFilesStorage(resolve: (name: string) => Promise<Files>): BlobStorageResolver {
    const stores = new WeakMap<Files, BlobStorage>()
    return async (name) => {
        const files = await resolve(name)
        let store = stores.get(files)
        if (store) return store
        const write = async (key: string, object: BlobObject, signal?: AbortSignal): Promise<void> => {
            await writeKnownLength(object, signal, async (body) => {
                const result = await files.upload(key, body, { contentType: object.contentType })
                return Number(result.size)
            })
        }
        store = {
            identity: identity(files),
            exists: (key) => files.exists(key),
            async read(key, signal) {
                signal?.throwIfAborted()
                if (!(await files.exists(key))) return null
                const file = await files.download(key, { as: 'stream' })
                return { body: file.stream(), size: Number(file.size), contentType: file.type }
            },
            write,
            async copy(source, target, signal) {
                const file = await files.download(source, { as: 'stream' })
                await write(target, { body: file.stream(), size: Number(file.size), contentType: file.type }, signal)
            },
            async delete(key, signal) {
                signal?.throwIfAborted()
                await files.delete(key)
            },
        }
        stores.set(files, store)
        return store
    }
}
