import type { Actor, ModelSaveInput } from './model'

export interface ModelOperation {
    actor: Actor
    signal?: AbortSignal
}
export type SaveInput = ModelSaveInput
export interface PublicationInfo {
    firstPublishedAt: string | null
    updatedAt: string | null
}
export interface ContentEntry {
    id: string
    model: string
    locale: string
    translated: boolean
    data: Record<string, unknown>
    body: string
    order: number
    url: string | null
    publication: PublicationInfo | null
}
export interface DraftEntry {
    id: string
    model: string
    locale: string
    data: Record<string, unknown>
    body?: string
    order: number
    digest: string
    revision: string
    updatedAt: string | null
}
export interface PublishSelection {
    model: string
    id: string
    locales?: readonly string[]
    digests: Record<string, string | null>
}
export interface RecordEntry {
    id: string
    version: number
    createdAt: string
    updatedAt: string
    data: Record<string, unknown>
}
export interface RecordOperation {
    actor: Actor
    signal?: AbortSignal
}
