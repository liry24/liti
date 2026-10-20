import type { BlobStorage } from '../plugins'
import { LitiError } from '../errors'
import type { LitiStorage } from '../adapter'
import type { StorageAssetCopy as AssetCopy, StorageAssetCopyGuard } from '../storage'
import type { LitiOptions, AssetRecord, AssetSyncResult, DownloadedAsset, UploadAssetInput } from './types'
import { prepareUpload, safeFilename, detectedMime } from './upload'

export const durationMilliseconds = (value: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isFinite(value * 1000))
        throw new LitiError('LITI_INVALID_INPUT', 'Asset durations must be finite non-negative seconds.')
    return value * 1000
}

/** Original files, public-copy leases, deletion and garbage collection share one ledger. */
export class AssetManager<Context> {
    constructor(
        private readonly options: LitiOptions<Context>,
        private readonly storage: LitiStorage,
        private readonly initializeRuntime: () => Promise<void>,
        private readonly desired: (entryIds?: string[]) => Promise<Set<string>>,
    ) {}
    get config() {
        return this.options.config
    }
    #id() {
        return this.options.id?.() ?? crypto.randomUUID()
    }
    #date() {
        return this.options.now?.() ?? new Date()
    }
    #now() {
        return this.#date().toISOString()
    }
    #leaseExpiresAt() {
        return new Date(
            this.#date().getTime() + durationMilliseconds(this.config.assets?.operationLeaseSeconds ?? 60 * 15),
        ).toISOString()
    }
    async uploadAsset(input: UploadAssetInput): Promise<AssetRecord> {
        await this.initializeRuntime()
        const assets = this.config.assets
        if (!assets || !this.options.getStorage) {
            throw new LitiError('LITI_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        }
        const storage = assets.separateDrafts === true ? 'draft' : assets.storage!
        const files = await this.options.getStorage(storage)
        const upload = await prepareUpload(input, assets.maxUploadSize)
        const id = this.#id()
        const key = `liti/${id}/${safeFilename(input.filename)}`
        const contentType = detectedMime(upload.prefix)
        const time = this.#now()
        const token = this.#id()
        const lease = this.#leaseExpiresAt()
        try {
            await this.storage.insertAsset({
                id,
                storage,
                key,
                contentType,
                size: upload.size,
                checksum: null,
                metadata: input.metadata ?? {},
                state: 'uploading',
                operationToken: token,
                leaseExpiresAt: lease,
                createdAt: time,
                updatedAt: time,
            })

            await files.write(key, { body: upload.stream, contentType, size: upload.size })
            const hash = upload.checksum()
            this.#assertStorageChange(
                await this.storage.finishAssetUpload(
                    id,
                    token,
                    { contentType, size: upload.size, checksum: hash },
                    this.#now(),
                ),
            )
        } catch (error) {
            await upload.cancel(error).catch(() => {})
            try {
                if (await files.exists(key)) await files.delete(key)
            } catch {}
            await this.storage.finishAssetUpload(id, token, undefined, this.#now())

            throw error
        }
        return this.getAsset(id)
    }

    async getAsset(id: string): Promise<AssetRecord> {
        await this.initializeRuntime()
        const row = await this.storage.readAsset(id)
        if (!row) throw new LitiError('LITI_ENTRY_NOT_FOUND', `Asset "${id}" does not exist.`)
        return row
    }

    async downloadAsset(id: string, publicOnly = true): Promise<DownloadedAsset> {
        await this.initializeRuntime()
        const asset = await this.getAsset(id)
        if (asset.state !== 'ready') {
            throw new LitiError('LITI_ASSET_NOT_READY', `Asset "${id}" is not ready.`)
        }
        if (publicOnly) {
            if (!(await this.desired(await this.storage.publishedAssetSources(id))).has(id)) {
                throw new LitiError('LITI_NOT_PUBLIC', `Asset "${id}" is not public.`)
            }
        }
        if (!this.options.getStorage) {
            throw new LitiError('LITI_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        }
        if (publicOnly && this.config.assets?.separateDrafts === true) {
            const copy = (await this.#assetCopies()).find(
                ({ copy: record }) => record.assetId === id && record.state === 'ready',
            )?.copy
            if (!copy) throw new LitiError('LITI_ASSET_NOT_READY', 'The public Asset copy needs retry.')
            const files = await this.options.getStorage(copy.storage)
            const file = await files.read(copy.key)
            if (!file) throw new LitiError('LITI_ASSET_NOT_READY', 'The public Asset copy is missing.')
            return { asset, file }
        }
        const files = await this.options.getStorage(asset.storage)
        const file = await files.read(asset.key)
        if (!file) throw new LitiError('LITI_ASSET_NOT_READY', 'The Asset bytes are missing.')
        return { asset, file }
    }

    async deleteAsset(id: string): Promise<void> {
        await this.initializeRuntime()
        const asset = await this.getAsset(id)
        if (await this.storage.hasAssetReferences(id))
            throw new LitiError('LITI_ASSET_IN_USE', 'A retained revision still uses this Asset.')

        const sync = await this.sync()
        if (sync.failed.length)
            throw new LitiError('LITI_STORAGE_UNAVAILABLE', 'Retry Asset copy cleanup before deleting its original.')
        const token = await this.#claimAsset(id)
        await this.#deleteClaimedAsset(asset, token)
    }

    async #claimAsset(id: string): Promise<string> {
        const token = this.#id()
        const now = this.#now()
        this.#assertStorageChange(await this.storage.claimAssetDeletion(id, token, this.#leaseExpiresAt(), now))

        return token
    }

    async #deleteClaimedAsset(asset: AssetRecord, token: string): Promise<void> {
        try {
            if (!this.options.getStorage) {
                throw new LitiError('LITI_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
            }
            const files = await this.options.getStorage(asset.storage)
            if (await files.exists(asset.key)) await files.delete(asset.key)
            this.#assertStorageChange(await this.storage.finishAssetDeletion(asset.id, token, true, this.#now()))
        } catch (error) {
            await this.storage.finishAssetDeletion(asset.id, token, false, this.#now())

            throw error
        }
    }

    async runAssetGC(): Promise<{ deleted: string[]; failed: Array<{ id: string; message: string }> }> {
        await this.initializeRuntime()
        if (!this.config.assets) return { deleted: [], failed: [] }
        const sync = await this.sync()
        if (sync.failed.length) return { deleted: [], failed: sync.failed }
        const grace = durationMilliseconds(this.config.assets.cleanup?.minimumAge ?? 60 * 60 * 24)
        const cutoff = new Date(this.#date().getTime() - grace).toISOString()
        const candidates = await this.storage.assetGCCandidates(cutoff, this.#now())

        const result: { deleted: string[]; failed: Array<{ id: string; message: string }> } = {
            deleted: [],
            failed: [],
        }
        for (const row of candidates) {
            const asset = row
            try {
                const token = await this.#claimAsset(asset.id)
                await this.#deleteClaimedAsset(asset, token)
                result.deleted.push(asset.id)
            } catch (error) {
                result.failed.push({
                    id: asset.id,
                    message: error instanceof Error ? error.message : 'Asset deletion failed.',
                })
            }
        }
        return result
    }

    async assertStores(): Promise<{ draft: BlobStorage; public: BlobStorage }> {
        const assets = this.config.assets
        if (!assets || !assets.storage || assets.storage === 'draft' || !this.options.getStorage)
            throw new LitiError(
                'LITI_STORAGE_UNAVAILABLE',
                'separateDrafts requires private draft and distinct public storage.',
            )
        try {
            const draft = await this.options.getStorage('draft')
            const publicFiles = await this.options.getStorage(assets.storage)
            if (!draft || !publicFiles || draft === publicFiles) throw new Error('Storage must be distinct.')
            if (draft.identity === publicFiles.identity) throw new Error('Storage backends must be distinct.')
            return { draft, public: publicFiles }
        } catch {
            throw new LitiError(
                'LITI_STORAGE_UNAVAILABLE',
                'Configure private draft storage and distinct public storage.',
            )
        }
    }

    async #assetCopies(): Promise<Array<{ ledger: string; copy: AssetCopy }>> {
        return this.storage.assetCopies()
    }

    #assertStorageChange(changed: boolean): void {
        if (!changed) throw new LitiError('LITI_CONFLICT', 'The record changed before this mutation committed.')
    }

    async #retireAssetCopy(ledger: string, copy: AssetCopy, guard?: StorageAssetCopyGuard): Promise<void> {
        // Keep tombstones for late storage writes; GC retries deletion.
        this.#assertStorageChange(await this.storage.updateAssetCopy(ledger, { ...copy, state: 'retired' }, guard))
        if (!this.options.getStorage)
            throw new LitiError('LITI_STORAGE_UNAVAILABLE', 'Asset storage is not configured.')
        const files = await this.options.getStorage(copy.storage)
        if (await files.exists(copy.key)) await files.delete(copy.key)
    }

    async syncAssetCopies(): Promise<AssetSyncResult> {
        await this.initializeRuntime()
        return this.sync()
    }

    async sync(): Promise<AssetSyncResult> {
        const result: AssetSyncResult = { copied: [], deleted: [], failed: [] }
        if (this.config.assets?.separateDrafts !== true) return result
        // ponytail: one DB lease serializes copy I/O; use per-Asset leases if publication throughput requires it.
        const lease = { expiresAt: this.#leaseExpiresAt(), id: this.#id() }
        const owner = (): StorageAssetCopyGuard => ({ lease, now: this.#now() })
        const generation = () => this.storage.publicGeneration()
        try {
            this.#assertStorageChange(await this.storage.claimAssetSync(lease, this.#now()))
        } catch {
            result.failed.push({
                id: '*',
                message: 'Asset synchronization is busy; retry through publishDue or Asset GC.',
            })
            return result
        }
        try {
            const stores = await this.assertStores()
            const startGeneration = await generation()
            const desired = await this.desired()
            const copies = await this.#assetCopies()
            for (const { ledger, copy } of copies) {
                if (copy.state === 'ready' && desired.has(copy.assetId)) continue
                try {
                    await this.#retireAssetCopy(ledger, copy, owner())
                    result.deleted.push(copy.assetId)
                } catch (error) {
                    result.failed.push({
                        id: copy.assetId,
                        message: error instanceof Error ? error.message : 'Public copy deletion failed.',
                    })
                }
            }
            for (const id of desired) {
                if (copies.some(({ copy }) => copy.assetId === id && copy.state === 'ready')) continue
                const token = this.#id()
                const ledger = `${id}:${token}`
                const copy: AssetCopy = {
                    assetId: id,
                    key: `liti/public/${id}/${token}`,
                    state: 'copying',
                    storage: this.config.assets.storage!,
                }
                const guard = owner()
                let recorded = false
                try {
                    this.#assertStorageChange(await this.storage.createAssetCopy(ledger, copy, guard))
                    recorded = true
                    const asset = (await this.storage.assets({ ids: [id], storage: 'draft', state: 'ready' }))[0]

                    if (!asset) throw new LitiError('LITI_ASSET_NOT_READY', 'The original Asset is not ready.')
                    const file = await stores.draft.read(asset.key)
                    if (!file) throw new LitiError('LITI_ASSET_NOT_READY', 'The original Asset bytes are missing.')
                    const upload = await prepareUpload({
                        body: file.body,
                        filename: asset.key,
                        size: Number(asset.size),
                    })
                    try {
                        await stores.public.write(copy.key, {
                            body: upload.stream,
                            contentType: asset.contentType,
                            size: upload.size,
                        })
                        const checksum = upload.checksum()
                        if (asset.checksum && checksum !== asset.checksum)
                            throw new Error('Public copy does not match its original.')
                    } catch (error) {
                        await upload.cancel(error).catch(() => {})
                        throw error
                    }
                    const currentGeneration = await generation()
                    if (!(await this.desired()).has(id)) {
                        await this.#retireAssetCopy(ledger, copy)
                        result.deleted.push(id)
                        continue
                    }
                    this.#assertStorageChange(
                        await this.storage.updateAssetCopy(
                            ledger,
                            { ...copy, state: 'ready' },
                            { ...owner(), generation: currentGeneration },
                        ),
                    )

                    result.copied.push(id)
                } catch (error) {
                    if (recorded) {
                        try {
                            await this.#retireAssetCopy(ledger, copy)
                        } catch {
                            /* The durable tombstone is retried by GC. */
                        }
                    }
                    result.failed.push({ id, message: error instanceof Error ? error.message : 'Public copy failed.' })
                }
            }
            if ((await generation()) !== startGeneration)
                result.failed.push({
                    id: '*',
                    message: 'Publication changed during synchronization; retry through publishDue or Asset GC.',
                })
        } catch (error) {
            result.failed.push({
                id: '*',
                message: error instanceof Error ? error.message : 'Asset synchronization failed.',
            })
        } finally {
            await this.storage.releaseAssetSync(lease)
        }
        return result
    }
}
