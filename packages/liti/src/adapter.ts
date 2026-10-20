import type { LitiConfig } from './config'
import type { StorageAssets, StorageContent } from './storage'
export type * from './storage'
export type { LitiConfig } from './config'
export type { AnyField } from './fields'
export type {
    DatabaseAdapter,
    AdapterContext,
    BlobObject,
    BlobStorage,
    BlobStorageResolver,
    BlobStorageAdapter,
    DatabaseTooling,
    GenerationContext,
    GenerationPlan,
    LitiAdapter,
    RuntimeAdapter,
    AuthAdapter,
    OperationContext,
    ActionDefinition,
    ActionResult,
} from './plugins'
export type { AssetRecord, EntryRecord, RevisionRecord, LitiActor } from './server/types'
export type { Translations } from './i18n'
export { LitiError } from './errors'
export { searchQuery } from './storage'
export { projectStoredFields } from './stored-data'
export { createLitiDescriptor } from './descriptor'
export { translatedRouteFields } from './i18n'

/** Configuration-bound domain storage; schema validation never runs DDL. */
export interface LitiStorage extends StorageContent, StorageAssets {
    assertSchema(): Promise<void>
}

/** Storage boundary for the domain; the selected adapter owns connections and migrations. */
export interface LitiDatabase {
    bind(config: LitiConfig): LitiStorage
    close?(): void | Promise<void>
}
