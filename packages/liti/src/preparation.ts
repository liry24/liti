import type { LitiManagementClient } from './client'
import type { LitiIssue } from './errors'
import type { OperationContext, ActionResult } from './plugins'
import type { EntryRecord, PublicEntry } from './server/types'

/** Read-only services retain the operation actor's authorization and the requested content view. */
export interface PreparationRead {
    current: Pick<
        LitiManagementClient<Record<string, Record<string, unknown>>>,
        'getEntry' | 'listEntries' | 'listAllEntries' | 'referencesTo'
    >
    published: {
        get(model: string, id: string, locale?: string): Promise<PublicEntry | null>
        list(model: string, locale?: string): Promise<PublicEntry[]>
        /** Checks this entry's localized route against published and historical URLs. */
        routeAvailable(data: Record<string, unknown>): Promise<boolean>
    }
}

export interface ModelPreparationContext<
    Data extends Record<string, unknown> = Record<string, unknown>,
> extends OperationContext {
    model: string
    entryId: string
    previous?: EntryRecord
    locale: string
    defaultLocale: string
    operation: 'create' | 'update' | 'restore' | 'publish' | 'schedule'
    data: Data
    issues: LitiIssue[]
    read: PreparationRead
    executeAction(name: string, input: unknown): Promise<ActionResult>
}

export type ModelPreparation<Data extends Record<string, unknown> = Record<string, unknown>> = {
    run(context: ModelPreparationContext<Data>): void | Promise<void>
}['run']
