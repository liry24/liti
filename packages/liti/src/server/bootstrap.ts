import type { InferLitiModels, LitiConfigInput, ResolvedLitiConfig } from '../config'
import { resolveLitiConfig } from '../config-resolution'
import type { OperationContext } from '../plugins'
import type { LitiTaskName } from '../tasks'
import { LitiError } from '../errors'
import type { LitiActor, LitiOptions } from './types'
import { createRuntime } from './liti'
import { createManagementOperations } from './operations'
import { handleManagementRequest, handlePublicRequest } from './http'

export interface LitiBootstrap extends Omit<
    LitiOptions<OperationContext>,
    'config' | 'database' | 'authorize' | 'getStorage'
> {
    projectRoot: string
    environment?: readonly string[]
    platformContext?: object
    loadModule?: (specifier: string) => Promise<Record<string, unknown>>
    authenticate?: (context: OperationContext) => LitiActor | null | Promise<LitiActor | null>
}

/** The host selects the project and supplies resources; core never discovers configuration. */
export async function createLiti<const Config extends LitiConfigInput>(input: Config, bootstrap: LitiBootstrap) {
    if (!bootstrap.projectRoot) throw new LitiError('LITI_INVALID_INPUT', 'A projectRoot is required.')
    const environment = bootstrap.environment ?? []
    const config = resolveLitiConfig(input, environment)
    const adapter = config.adapter
    if (!adapter?.database) throw new LitiError('LITI_DATABASE_UNSUPPORTED', 'Select an adapter.database provider.')
    if (adapter.auth && bootstrap.authenticate)
        throw new LitiError('LITI_INVALID_INPUT', 'Use either adapter.auth or bootstrap.authenticate.')
    const connectionContext = {
        projectRoot: bootstrap.projectRoot,
        environment,
        ...(bootstrap.platformContext ? { platformContext: bootstrap.platformContext } : {}),
        ...(bootstrap.loadModule ? { loadModule: bootstrap.loadModule } : {}),
    }
    const getStorage = config.assets && adapter.storage ? await adapter.storage.connect(connectionContext) : undefined
    const database = await adapter.database.connect(connectionContext)
    const run = <Value>(context: OperationContext, operation: () => Value) =>
        adapter.runtime?.run ? adapter.runtime.run(context, operation) : operation()
    const authenticate = adapter.auth?.authenticate.bind(adapter.auth) ?? bootstrap.authenticate
    const contextFor = async (context: OperationContext): Promise<OperationContext> => {
        context.signal?.throwIfAborted()
        return adapter.runtime ? adapter.runtime.context(context) : context
    }
    const actorContext = async (context: OperationContext): Promise<OperationContext> => {
        const resolved = await contextFor(context)
        return { ...resolved, actor: resolved.actor ?? (await authenticate?.(resolved)) ?? null }
    }
    const managementBase = (bootstrap.managementBase ?? '/api/liti').replace(/\/$/u, '')
    const publicBase = (bootstrap.publicBase ?? `${managementBase}/content`).replace(/\/$/u, '')
    const runtime = createRuntime<OperationContext>({
        ...bootstrap,
        config,
        database,
        ...(getStorage ? { getStorage } : {}),
        managementBase,
        publicBase,
        authorize: async (request, context) => {
            const resolved = await contextFor({ ...context, request, signal: request.signal })
            return (await authenticate?.(resolved)) ?? null
        },
    })
    try {
        await run({ ...(bootstrap.platformContext ? { platformContext: bootstrap.platformContext } : {}) }, () =>
            runtime.initialize(),
        )
    } catch (error) {
        await database.close?.()
        throw error
    }
    type Models = InferLitiModels<ResolvedLitiConfig<Config, readonly string[]>>
    const service = async (context: OperationContext) => {
        const operations = createManagementOperations<OperationContext, Models>(
            () => runtime,
            await run(context, () => actorContext(context)),
            undefined,
            managementBase,
        )
        return new Proxy(operations, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver)
                return typeof value === 'function'
                    ? (...args: unknown[]) => run(context, () => Reflect.apply(value, target, args))
                    : value
            },
        })
    }
    const task = async <Result>(
        name: LitiTaskName,
        context: OperationContext,
        run: (actor: LitiActor) => Promise<Result>,
    ): Promise<Result> => {
        const enabled = config.tasks?.[name]
        if (enabled !== true && !(typeof enabled === 'string' && enabled.trim()))
            throw new LitiError('LITI_FORBIDDEN', `liti task "${String(name)}" is disabled.`)
        const execute = async () => {
            const { actor } = await actorContext(context)
            if (!actor?.id) throw new LitiError('LITI_AUTH_REQUIRED', 'Tasks require an authenticated actor.')
            return run(actor)
        }
        return adapter.runtime?.run ? adapter.runtime.run(context, execute) : execute()
    }
    return {
        service,
        async fetch(request: Request, platformContext?: object): Promise<Response> {
            const path = new URL(request.url).pathname
            if (path === publicBase || path.startsWith(`${publicBase}/`))
                return run({ request, ...(platformContext ? { platformContext } : {}) }, () =>
                    handlePublicRequest(runtime, request, publicBase),
                )
            if (path === managementBase || path.startsWith(`${managementBase}/`))
                return run({ request, ...(platformContext ? { platformContext } : {}) }, () =>
                    handleManagementRequest(
                        runtime,
                        request,
                        managementBase,
                        platformContext ? { platformContext } : {},
                    ),
                )
            return new Response(null, { status: 404 })
        },
        tasks: {
            publishDue: (context: OperationContext) =>
                task('publishDue', context, async (actor) => {
                    return createManagementOperations(() => runtime, { actor }).publishDue()
                }),
            assetGC: (context: OperationContext) =>
                task('assetGC', context, async (actor) => {
                    runtime.assertPermission(actor, 'asset', 'gc')
                    return runtime.runAssetGC()
                }),
            syncAssets: (context: OperationContext) =>
                task('syncAssets', context, async (actor) => {
                    runtime.assertPermission(actor, 'asset', 'gc')
                    return runtime.syncAssetCopies()
                }),
            rebuildSearch: (context: OperationContext) =>
                task('rebuildSearch', context, async (actor) => {
                    runtime.assertPermission(actor, 'system', 'rebuildSearch')
                    return runtime.rebuildSearch()
                }),
        },
        close: async () => database.close?.(),
    }
}
