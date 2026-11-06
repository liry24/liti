import type { Model, ModelInput, ModelPublicData, ContentEntry, DraftEntry, RecordEntry } from '@litijs/model'

/** Nuxt augments this interface from server/models without a client-side server import. */
export interface LitiModels {}
export type ModelName = keyof LitiModels extends never ? string : Extract<keyof LitiModels, string>
type Registered<Name extends ModelName> = Name extends keyof LitiModels ? Extract<LitiModels[Name], Model> : Model
type LocalizedKeys<M extends Model> = Extract<
    { [K in keyof M['fields']]: M['fields'][K] extends { localized: true } ? K : never }[keyof M['fields']],
    keyof ModelPublicData<M>
>
type PublicData<M extends Model, Fallback extends boolean> = Fallback extends false
    ? Omit<ModelPublicData<M>, LocalizedKeys<M>> & Partial<Pick<ModelPublicData<M>, LocalizedKeys<M>>>
    : ModelPublicData<M>
type EntryFor<M extends Model, Fallback extends boolean> = M extends { storage: 'records' }
    ? Omit<RecordEntry, 'data'> & { model: M['name']; data: ModelPublicData<M> }
    : Omit<ContentEntry, 'data'> & { data: PublicData<M, Fallback> }
export type Entry<Name extends ModelName, Fallback extends boolean = true> = EntryFor<Registered<Name>, Fallback>
type DraftFor<M extends Model> = M extends { storage: 'records' }
    ? Omit<RecordEntry, 'data'> & { model: M['name']; data: ModelInput<M> }
    : Omit<DraftEntry, 'data'> & { data: Partial<ModelInput<M>> }
export type Draft<Name extends ModelName> = DraftFor<Registered<Name>>
export type FormData<Name extends ModelName> = Partial<ModelInput<Registered<Name>>>
export interface Page<Value> {
    items: Value[]
    total: number
    revision?: string | null
}
export interface QueryOptions {
    locale?: string
    fallback?: boolean
    limit?: number
    offset?: number
    filter?: Record<string, unknown>
}
export interface WriteReceipt {
    id: string
    locale?: string
    digest?: string
    revision?: string
    version?: number
    updatedAt?: string
    postCommitErrors?: { code: string; message: string }[]
}
export interface PublicQuery extends QueryOptions {
    model: string
    mode?: 'many' | 'one'
    id?: string
    path?: string
}
