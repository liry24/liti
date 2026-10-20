import type { Ref } from 'vue'
import type { LitiEntry } from '../../liti/src/client'
import type { LitiClientRegistry } from '../../liti/src/public-client'
import type { ModelDescriptor } from '../../liti/src/descriptor'
import type { ActionResult } from '../../liti/src/plugins'
import type { LitiFormExtensionTypes } from './index'

/* oxlint-disable typescript/no-generated-empty-object-type -- consumers augment the extension registry */
export type LitiFormExtensions<Name extends string> = LitiClientRegistry extends { modelExtensions: infer Models }
    ? Name extends keyof Models
        ? Pick<LitiFormExtensionTypes, Extract<keyof Models[Name], keyof LitiFormExtensionTypes>>
        : {}
    : {}
/* oxlint-enable typescript/no-generated-empty-object-type */

export interface LitiFormExtensionContext {
    model: string
    descriptor: Readonly<Ref<ModelDescriptor | undefined>>
    identity: Readonly<Ref<string>>
    values: Readonly<Ref<Readonly<Record<string, unknown>>>>
    entry: Readonly<Ref<LitiEntry | null>>
    busy: Readonly<Ref<boolean>>
    signal: AbortSignal
    setField(name: string, value: unknown): void
    executeAction(name: string, input: unknown, options?: { signal?: AbortSignal }): Promise<ActionResult>
    report(error: unknown): unknown
}
export interface LitiFormExtension {
    namespace: object
    state: Readonly<
        Ref<{
            busy?: boolean
            can?: Record<string, boolean>
            blocked?: Record<string, string>
        }>
    >
    beforeSubmit?(operation: 'save' | 'publish' | 'schedule'): void | Promise<void>
}
export type LitiFormExtensionFactory = (context: LitiFormExtensionContext) => LitiFormExtension
export type LitiFormExtensionRegistry = Record<string, LitiFormExtensionFactory>
