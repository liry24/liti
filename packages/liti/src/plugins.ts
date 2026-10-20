import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { LitiConfig, ModelDefinition } from './config'
import type { LitiActor } from './server/types'
import type { LitiDatabase } from './adapter'
import { LitiError } from './errors'

/** Host data is supplied at execution time, never captured while importing configuration. */
export interface OperationContext {
    actor?: LitiActor | null
    request?: Request
    signal?: AbortSignal
    platformContext?: object
}

export interface AdapterContext {
    projectRoot: string
    environment: readonly string[]
    platformContext?: object
    loadModule?: (specifier: string) => Promise<Record<string, unknown>>
}

export interface RuntimeAdapter {
    id: string
    role: 'runtime'
    context(input: OperationContext): OperationContext | Promise<OperationContext>
    run?<Value>(context: OperationContext, operation: () => Value): Value | Promise<Value>
    hosts?: { nuxt?: string }
}

export interface GenerationContext extends AdapterContext {
    schemaOnly: boolean
    output?: string
}

export interface GenerationPlan {
    files: Array<{ path: string; source: string; createOnly?: boolean }>
    command?: { package: string; bin: string; args: string[]; version: string; peers?: Record<string, string> }
}

export interface DatabaseTooling {
    generate(config: LitiConfig, context: GenerationContext): GenerationPlan | Promise<GenerationPlan>
}

export interface DatabaseAdapter {
    id: string
    role: 'database'
    connect(context: AdapterContext): LitiDatabase | Promise<LitiDatabase>
    connectionKey?: (context: AdapterContext) => object | string | Promise<object | string>
    tooling?: DatabaseTooling
    /** A host can bundle this module without importing database drivers during config evaluation. */
    schema?: { generated: string; entry: string }
    hosts?: { nuxt?: string }
}

export interface BlobObject {
    body: ReadableStream<Uint8Array>
    size: number
    contentType: string
}

export interface BlobStorage {
    /** Equal identities denote the same physical storage, even through different wrappers. */
    identity: object | string
    exists(key: string): Promise<boolean>
    read(key: string, signal?: AbortSignal): Promise<BlobObject | null>
    write(key: string, object: BlobObject, signal?: AbortSignal): Promise<void>
    copy(source: string, target: string, signal?: AbortSignal): Promise<void>
    delete(key: string, signal?: AbortSignal): Promise<void>
}

export type BlobStorageResolver = (storage: string) => Promise<BlobStorage>

export interface BlobStorageAdapter {
    id: string
    role: 'storage'
    defaultStorage?: string
    connect(context: AdapterContext): BlobStorageResolver | Promise<BlobStorageResolver>
    hosts?: { nuxt?: string }
}

export interface AuthAdapter {
    id: string
    role: 'auth'
    authenticate(context: OperationContext): LitiActor | null | Promise<LitiActor | null>
    hosts?: { nuxt?: string }
}

export interface LitiAdapter {
    runtime?: RuntimeAdapter
    database?: DatabaseAdapter
    storage?: BlobStorageAdapter
    auth?: AuthAdapter
}

/** A data-only manifest can be inspected without evaluating a plugin's implementation. */
export interface LitiPluginManifest {
    id: string
    apiVersion: 1
    liti: string
    factory: string
    config: string
}

export interface ActionDefinition<Input = unknown, Output = unknown> {
    input: StandardSchemaV1<unknown, Input>
    output: StandardSchemaV1<unknown, Output>
    execute(input: Input, context: OperationContext): Output | Promise<Output>
}

export interface LitiPlugin<
    Models extends Record<string, ModelDefinition> = Record<string, ModelDefinition>,
    Actions extends Record<string, ActionDefinition> = Record<string, ActionDefinition>,
> {
    id: string
    apiVersion: 1
    models?: Models
    actions?: Actions
    requires?: {
        actions?: readonly string[]
        plugins?: readonly string[]
    }
}

export const defineLitiPlugin = <const Plugin extends LitiPlugin>(plugin: Plugin): Plugin => plugin

type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (
    value: infer Intersection,
) => void
    ? Intersection
    : never

type Contributions<Config, Key extends 'models' | 'actions'> = Config extends {
    plugins: readonly (infer Plugin)[]
}
    ? Plugin extends { [Property in Key]: infer Value }
        ? Value
        : never
    : never

export type PluginModels<Config> = [Contributions<Config, 'models'>] extends [never]
    ? {}
    : UnionToIntersection<Contributions<Config, 'models'>>

export type PluginActions<Config> = [Contributions<Config, 'actions'>] extends [never]
    ? {}
    : UnionToIntersection<Contributions<Config, 'actions'>>

const invalid = (message: string): never => {
    throw new LitiError('LITI_INVALID_INPUT', message)
}

export const validateAdapter = (adapter: LitiAdapter | undefined): void => {
    if (adapter === undefined) return
    if (!adapter || Array.isArray(adapter) || typeof adapter !== 'object')
        invalid('adapter must be one object with runtime, database, storage and auth slots.')
    const methods = { runtime: 'context', database: 'connect', storage: 'connect', auth: 'authenticate' } as const
    for (const [role, provider] of Object.entries(adapter)) {
        if (!Object.hasOwn(methods, role)) invalid(`Unknown adapter slot "${role}".`)
        const method = methods[role as keyof typeof methods]
        if (
            !provider ||
            Array.isArray(provider) ||
            typeof provider !== 'object' ||
            provider.role !== role ||
            typeof provider.id !== 'string' ||
            !provider.id.trim() ||
            typeof provider[method] !== 'function'
        )
            invalid(`Invalid ${role} adapter; expected an identified provider with ${method}().`)
    }
}

/** Collect all declarations first, then validate references independently of registration order. */
export const resolvePlugins = (
    models: Record<string, ModelDefinition>,
    plugins: readonly LitiPlugin[],
): { models: Record<string, ModelDefinition>; actions: Record<string, ActionDefinition> } => {
    const allModels = { ...models }
    const actions: Record<string, ActionDefinition> = {}
    const ids = new Set<string>()
    for (const plugin of plugins) {
        if (!plugin || typeof plugin.id !== 'string' || !plugin.id.trim() || plugin.apiVersion !== 1)
            invalid('Plugins require a non-empty id and apiVersion: 1.')
        if (ids.has(plugin.id)) invalid(`Duplicate plugin "${plugin.id}".`)
        ids.add(plugin.id)
        for (const [name, model] of Object.entries(plugin.models ?? {})) {
            if (Object.hasOwn(allModels, name)) invalid(`Duplicate model "${name}" from plugin "${plugin.id}".`)
            Object.defineProperty(allModels, name, {
                value: model,
                enumerable: true,
                configurable: true,
                writable: true,
            })
        }
        for (const [name, action] of Object.entries(plugin.actions ?? {})) {
            if (Object.hasOwn(actions, name)) invalid(`Duplicate action "${name}" from plugin "${plugin.id}".`)
            if (
                typeof action?.input?.['~standard']?.validate !== 'function' ||
                typeof action?.output?.['~standard']?.validate !== 'function' ||
                typeof action?.execute !== 'function'
            )
                invalid(`Action "${name}" requires input/output schemas and execute().`)
            Object.defineProperty(actions, name, {
                value: action,
                enumerable: true,
                configurable: true,
                writable: true,
            })
        }
    }
    for (const plugin of plugins) {
        for (const id of plugin.requires?.plugins ?? [])
            if (!ids.has(id)) invalid(`Plugin "${plugin.id}" requires plugin "${id}".`)
        for (const action of plugin.requires?.actions ?? [])
            if (!Object.hasOwn(actions, action)) invalid(`Plugin "${plugin.id}" requires action "${action}".`)
    }
    return { models: allModels, actions }
}
