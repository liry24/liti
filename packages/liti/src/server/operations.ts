import type { Liti } from './liti'
import type {
    EntryRecord,
    EntryMutationResult,
    EntryInput,
    UpdateEntryInput,
    LitiActor,
    PublishEntryInput,
    UploadAssetInput,
    AssetRecord,
} from './types'
import type { LitiModelAction } from '../config'
import type { LitiManagementClient, LitiManagementModels, ManagementListOptions } from '../client'
import { LitiError } from '../errors'
import { projectStoredFields } from '../stored-data'
import type { OperationContext } from '../plugins'

/** Shared authorization, validation and redaction for HTTP and direct server calls. */
export const createManagementOperations = <
    Context,
    Models extends { [Name in keyof Models]: Record<string, unknown> } = LitiManagementModels,
>(
    resolve: () => Liti<Context> | Promise<Liti<Context>>,
    operation?: Request | OperationContext,
    context?: Context,
    managementBase = '/api/liti',
    expectedModel?: string,
): LitiManagementClient<Models> & {
    authorize(): Promise<void>
    upload(input: Omit<UploadAssetInput, 'actorId'>): Promise<AssetRecord>
} => {
    let authorization: Promise<{ admin: Liti<Context>; actor: LitiActor }> | undefined
    const authorize = () => {
        const request = operation instanceof Request ? operation : undefined
        const trusted = operation instanceof Request ? undefined : operation
        ;(request?.signal ?? trusted?.signal)?.throwIfAborted()
        return (authorization ??= (async () => {
            const admin = await resolve()
            const actor = request ? await admin.authorizeRequest(request, context) : trusted?.actor
            if (!actor?.id)
                throw new LitiError('LITI_AUTH_REQUIRED', 'Management operations require an authenticated actor.')
            return { admin, actor }
        })())
    }
    const projectResult = (admin: Liti<Context>, actor: LitiActor, entry: EntryRecord): EntryMutationResult =>
        admin.can(actor, 'model', 'readDraft', entry.model)
            ? {
                  ...entry,
                  data: projectStoredFields(admin.config.models[entry.model]!.fields, entry.data),
                  translations: Object.fromEntries(
                      Object.entries(entry.translations).map(([locale, data]) => [
                          locale,
                          projectStoredFields(admin.config.models[entry.model]!.fields, data),
                      ]),
                  ),
              }
            : { id: entry.id, model: entry.model, version: entry.version, sortOrder: entry.sortOrder }
    const version = (input: { expectedVersion: number }) => {
        if (!Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 0)
            throw new LitiError('LITI_INVALID_INPUT', 'expectedVersion must be a non-negative integer.')
    }
    const entryOperation = async <Value>(
        id: string,
        action: LitiModelAction,
        operation: (admin: Liti<Context>, actor: LitiActor, entry: EntryRecord) => Promise<Value>,
        input?: { expectedVersion: number },
    ) => {
        const { admin, actor: current } = await authorize()
        const entry = await admin.getEntry(id)
        if (expectedModel && entry.model !== expectedModel)
            throw new LitiError('LITI_ENTRY_NOT_FOUND', 'Entry not found.')
        admin.assertPermission(current, 'model', action, entry.model)
        if (input) version(input)
        try {
            return await operation(admin, current, entry)
        } catch (cause) {
            if (!(cause instanceof LitiError) || admin.can(current, 'model', 'readDraft', entry.model)) throw cause
            const error = new LitiError(
                cause.code,
                cause.committed ? 'The entry was saved; retry its pending effects.' : 'The requested operation failed.',
            )
            if (cause.committed && cause.receipt) {
                error.committed = true
                error.receipt = cause.receipt
                if (cause.effects) error.effects = cause.effects
            }
            throw error
        }
    }
    const write = (
        id: string,
        action: LitiModelAction,
        input: { expectedVersion: number },
        operation: (admin: Liti<Context>, actor: LitiActor, entry: EntryRecord) => Promise<EntryRecord>,
    ) =>
        entryOperation(
            id,
            action,
            async (admin, actor, entry) => projectResult(admin, actor, await operation(admin, actor, entry)),
            input,
        )
    const api = {
        authorize: async () => {
            await authorize()
        },
        upload: async (input: Omit<UploadAssetInput, 'actorId'>) => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'asset', 'upload')
            return admin.uploadAsset({ ...input, actorId: current.id })
        },
        assetUrl: (id: string) => managementBase.replace(/\/$/u, '') + '/assets/' + encodeURIComponent(id) + '/content',
        models: async () => {
            const { admin, actor: current } = await authorize()
            return admin.descriptorFor(current, await admin.presentationContext())
        },
        getEntry: (id: string) =>
            entryOperation(
                id,
                'readDraft',
                async (admin, actor, entry) => projectResult(admin, actor, entry) as EntryRecord,
            ),
        listEntries: async (model?: string, options: ManagementListOptions = {}) => {
            const { admin, actor: current } = await authorize()
            if (model) admin.assertPermission(current, 'model', 'readDraft', model)
            const limit = options.limit ?? 50,
                offset = options.offset ?? 0
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
                throw new LitiError('LITI_INVALID_INPUT', 'limit must be 1–100 and offset non-negative.')
            const models = model
                ? [model]
                : Object.keys(admin.config.models).filter((name) => admin.can(current, 'model', 'readDraft', name))
            const page = await admin.pageEntries({ models, ...options }, { limit, offset })
            return {
                ...page,
                items: page.items.map((entry) => projectResult(admin, current, entry) as EntryRecord),
                limit,
                offset,
            }
        },
        createEntry: async (model: string, input: Omit<EntryInput, 'actorId'>) => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'model', 'create', model)
            try {
                return projectResult(admin, current, await admin.createEntry(model, { ...input, actorId: current.id }))
            } catch (cause) {
                if (cause instanceof LitiError && !admin.can(current, 'model', 'readDraft', model)) {
                    const error = new LitiError(
                        cause.code,
                        cause.committed
                            ? 'The entry was saved; retry its pending effects.'
                            : 'The requested operation failed.',
                    )
                    if (cause.committed && cause.receipt) {
                        error.committed = true
                        error.receipt = cause.receipt
                        if (cause.effects) error.effects = cause.effects
                    }
                    throw error
                }
                throw cause
            }
        },
        updateEntry: (id: string, input: Omit<UpdateEntryInput, 'actorId'>) =>
            write(id, 'update', input, (admin, current, entry) =>
                admin.updateEntry(id, { ...input, actorId: current.id }, entry),
            ),
        deleteEntry: (id: string, input: { expectedVersion: number }) =>
            entryOperation(
                id,
                'delete',
                (admin, current, entry) => admin.deleteEntry(id, { ...input, actorId: current.id }, entry),
                input,
            ),
        publishEntry: (id: string, input: Omit<PublishEntryInput, 'actorId'>) =>
            write(id, 'publish', input, (admin, current, entry) => {
                if (input.draft) admin.assertPermission(current, 'model', 'update', entry.model)
                return admin.publishEntry(id, { ...input, actorId: current.id } as PublishEntryInput, entry)
            }),
        unpublishEntry: (id: string, input: { expectedVersion: number }) =>
            write(id, 'publish', input, (admin, current, entry) =>
                admin.unpublishEntry(id, { ...input, actorId: current.id }, entry),
            ),
        schedulePublish: (id: string, input: PublishEntryInput & { at: string }) =>
            write(id, 'schedule', input, (admin, current, entry) => {
                if (input.draft) admin.assertPermission(current, 'model', 'update', entry.model)
                return admin.schedulePublish(id, { ...input, actorId: current.id }, entry)
            }),
        cancelScheduledPublish: (id: string, input: { expectedVersion: number }) =>
            write(id, 'schedule', input, (admin, actor, entry) =>
                admin.cancelScheduledPublish(id, { ...input, actorId: actor.id }, entry),
            ),
        setSortOrder: (id: string, sortOrder: number | null, expectedVersion: number) =>
            write(id, 'sort', { expectedVersion }, (admin, actor) =>
                admin.setSortOrder(id, sortOrder, expectedVersion, actor.id),
            ),
        setSortOrders: async (
            model: string,
            items: Array<{ id: string; expectedVersion: number; sortOrder: number | null }>,
        ) => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'model', 'sort', model)
            return (await admin.setSortOrders(model, items, current.id)).map((entry) =>
                projectResult(admin, current, entry),
            )
        },
        listRevisions: (id: string) =>
            entryOperation(id, 'readDraft', async (admin, _actor, entry) =>
                (await admin.listRevisions(id, entry)).map((revision) => ({
                    ...revision,
                    data: projectStoredFields(admin.config.models[entry.model]!.fields, revision.data),
                    translations: Object.fromEntries(
                        Object.entries(revision.translations).map(([locale, data]) => [
                            locale,
                            projectStoredFields(admin.config.models[entry.model]!.fields, data),
                        ]),
                    ),
                })),
            ),
        restoreRevision: (id: string, revision: string, input: { expectedVersion: number }) =>
            write(id, 'restore', input, (admin, current, entry) =>
                admin.restoreRevision(id, revision, { ...input, actorId: current.id }, entry),
            ),
        pruneRevisions: (id: string, retain: number) =>
            entryOperation(id, 'prune', (admin, _actor, entry) => admin.pruneRevisions(id, retain, entry)),
        referencesTo: (id: string, options: Parameters<Liti['referencesTo']>[1]) =>
            entryOperation(id, 'readDraft', async (admin, current, entry) =>
                (await admin.referencesTo(id, options, entry)).filter((ref) =>
                    admin.can(current, 'model', 'readDraft', ref.model),
                ),
            ),
        getAsset: async (id: string) => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'asset', 'read')
            return admin.getAsset(id)
        },
        deleteAsset: async (id: string) => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'asset', 'delete')
            return admin.deleteAsset(id)
        },
        uploadAsset: async (body: Blob, options?: { filename: string; contentType?: string }) => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'asset', 'upload')
            return admin.uploadAsset({
                actorId: current.id,
                body,
                filename: options?.filename ?? (body instanceof File ? body.name : 'upload'),
                contentType: options?.contentType ?? body.type,
            })
        },
        downloadAsset: async (id: string) => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'asset', 'read')
            const { asset, file } = await admin.downloadAsset(id, false)
            return new Response(file.body, {
                headers: { 'content-type': asset.contentType, 'cache-control': 'private, no-store' },
            })
        },
        inspect: async () => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'system', 'diagnostics')
            return admin.inspect()
        },
        routeSnapshot: async () => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'system', 'diagnostics')
            return admin.routeSnapshot()
        },
        publishDue: async () => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'system', 'publishDue')
            const result = await admin.publishDue()
            return {
                ...result,
                failed: await Promise.all(
                    result.failed.map(async (failure) => {
                        const entry = await admin.getEntry(failure.entryId)
                        return admin.can(current, 'model', 'readDraft', entry.model)
                            ? failure
                            : { entryId: failure.entryId, message: 'Scheduled publication failed.' }
                    }),
                ),
            }
        },
        runAssetGC: async () => {
            const { admin, actor: current } = await authorize()
            admin.assertPermission(current, 'asset', 'gc')
            return admin.runAssetGC()
        },
        runAiAction: async () => {
            throw new LitiError('LITI_AI_UNAVAILABLE', 'Use the event-bound AI action runtime.')
        },
        listAllEntries: async (model?: string, options: ManagementListOptions = {}) => {
            const items: EntryRecord[] = []
            while (true) {
                const page = await api.listEntries(model, { ...options, limit: 100, offset: items.length })
                items.push(...page.items)
                if (items.length >= page.total) return items
                if (!page.items.length) throw new LitiError('LITI_CONFLICT', 'The entry list changed; retry.')
            }
        },
    }
    return api as unknown as LitiManagementClient<Models> & {
        authorize(): Promise<void>
        upload(input: Omit<UploadAssetInput, 'actorId'>): Promise<AssetRecord>
    }
}
