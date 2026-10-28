import { createContentConsoleActions as nativeActions } from '@vite-hub/content/runtime/console'
import { consoleActionError } from 'vite-hub/console/documents'
import { authorize, documentId, splitDocumentId, ModelError, type Actor, type ContentModel } from '@litijs/model'
import type { PublishSelection } from '@litijs/model/content'
import runtime from '#liti/runtime'

type Actions = ReturnType<typeof nativeActions>
type Context = Parameters<Actions['get']>[1]
const actor = (context: Context): Actor => {
    if (!context.user || typeof context.user.id !== 'string')
        throw new ModelError('LITI_FORBIDDEN', 'Sign in to manage models.')
    return { ...context.user, id: context.user.id }
}
const clean = <Document extends { data: Record<string, unknown> }>(document: Document): Document => ({
    ...document,
    data: Object.fromEntries(Object.entries(document.data).filter(([key]) => !key.startsWith('_liti'))),
})
async function rpc<Value>(task: () => Promise<Value>) {
    try {
        return await task()
    } catch (error) {
        if (error instanceof ModelError)
            throw consoleActionError({
                code: error.code,
                message: error.message,
                status: error.statusCode,
                details: { issues: error.issues },
            })
        throw error
    }
}

/** Reuse the native editor and owner policy; every managed write goes through Model. */
export const createContentConsoleActions: typeof nativeActions = (module) => {
    const base = nativeActions(module)
    const managed = (name: string) => {
        const model = runtime.definitions.get(name)
        return model?.storage === 'content' ? model : null
    }
    const selected = (model: ContentModel, value: string) =>
        value.includes('/') ? splitDocumentId(value) : { id: value, locale: model.locales?.default ?? 'und' }
    const checkRead = async (name: string, context: Context, value?: string) => {
        const model = managed(name)
        if (!model) return
        const entry = value ? selected(model, value) : undefined
        await authorize(model, { actor: actor(context), action: 'readDraft', ...entry })
    }
    const nativeAccess = async (name: string, action: 'read' | 'write' | 'publish', context: Context, id?: string) => {
        if (!(await runtime.nativeContent.can({ collection: name, action, user: context.user, ...(id ? { id } : {}) })))
            throw new ModelError('LITI_FORBIDDEN', 'The Content policy denied this Console operation.')
    }
    const allRead = async (context: Context) => {
        for (const model of runtime.definitions.values())
            if (model.storage === 'content') {
                await checkRead(model.name, context)
                await nativeAccess(model.name, 'read', context)
                const collection = runtime.nativeContent.collection(model.name)
                if (collection.kind !== 'documents') continue
                for (const ref of ['draft', 'published'] as const) {
                    let cursor: string | undefined
                    do {
                        const page = await collection.list({ ref, limit: 1000, ...(cursor ? { cursor } : {}) })
                        for (const document of page.items) await checkRead(model.name, context, document.id)
                        cursor = page.nextCursor ?? undefined
                    } while (cursor)
                }
            }
    }
    const expectations = async (
        name: string,
        expected: readonly { id: string; digest: string | null }[],
        context: Context,
    ): Promise<PublishSelection[]> => {
        const model = managed(name)!
        const groups = new Map<string, PublishSelection>()
        for (const item of expected) {
            const { id, locale } = selected(model, item.id)
            const group = groups.get(id) ?? { model: name, id, digests: {} }
            if (Object.hasOwn(group.digests, locale))
                throw new ModelError('LITI_INVALID_INPUT', 'Review each translation once.')
            group.digests[locale] = item.digest
            groups.set(id, group)
        }
        for (const group of groups.values())
            for (const locale of model.locales?.supported ?? ['und']) {
                if (Object.hasOwn(group.digests, locale)) continue
                if (await runtime.content.readDraft(name, group.id, { actor: actor(context) }, locale))
                    throw new ModelError(
                        'LITI_INVALID_INPUT',
                        'Review all existing translations together before publication.',
                    )
                group.digests[locale] = null
            }
        return [...groups.values()]
    }
    const warnings = (receipt: { postCommitErrors?: { code: string; message: string }[] }) => {
        if (receipt.postCommitErrors?.length)
            console.warn('[liti] Committed Console operation:', receipt.postCommitErrors)
    }
    const actions: Actions = {
        ...base,
        collections: (context) =>
            rpc(async () => {
                const collections = await base.collections(context),
                    result = []
                for (const collection of collections) {
                    try {
                        await checkRead(collection.name, context)
                    } catch (error) {
                        if (error instanceof ModelError && error.code === 'LITI_FORBIDDEN') continue
                        throw error
                    }
                    const properties = collection.schema.properties
                    result.push(
                        managed(collection.name) && properties && typeof properties === 'object'
                            ? {
                                  ...collection,
                                  schema: {
                                      ...collection.schema,
                                      properties: Object.fromEntries(
                                          Object.entries(properties).filter(([key]) => !key.startsWith('_liti')),
                                      ),
                                      ...(Array.isArray(collection.schema.required)
                                          ? {
                                                required: collection.schema.required.filter(
                                                    (key) => typeof key === 'string' && !key.startsWith('_liti'),
                                                ),
                                            }
                                          : {}),
                                  },
                              }
                            : collection,
                    )
                }
                return result
            }),
        get: (input, context) =>
            rpc(async () => {
                await checkRead(input.collection, context, input.id)
                const model = managed(input.collection),
                    entry = model ? selected(model, input.id) : null
                const value = await base.get(
                    entry ? { ...input, id: documentId(model!, entry.id, entry.locale) } : input,
                    context,
                )
                return value ? clean(value) : null
            }),
        raw: (input, context) =>
            rpc(async () => {
                await checkRead(input.collection, context, input.id)
                return await base.raw(input, context)
            }),
        list: (input, context) =>
            rpc(async () => {
                await checkRead(input.collection, context)
                const page = await base.list(input, context)
                for (const item of page.items) await checkRead(input.collection, context, item.id)
                return { ...page, items: page.items.map(clean) }
            }),
        revisions: (input, context) =>
            rpc(async () => {
                await checkRead(input.collection, context, input.id)
                return await base.revisions(input, context)
            }),
        save: (input, context) =>
            rpc(async () => {
                const model = managed(input.collection)
                if (!model) return await base.save(input, context)
                await base.collections(context)
                const entry = selected(model, input.id)
                await checkRead(model.name, context, input.id)
                await nativeAccess(model.name, 'read', context, input.id)
                await nativeAccess(model.name, 'write', context, input.id)
                if (entry.locale !== (model.locales?.default ?? 'und'))
                    throw new ModelError(
                        'LITI_INVALID_INPUT',
                        'Use the translation form to edit sparse translated fields.',
                    )
                const receipt = await runtime.content.save(
                    model.name,
                    entry.id,
                    { data: input.data, body: input.body },
                    { actor: actor(context), locale: entry.locale, ifDigest: input.ifDigest },
                )
                warnings(receipt)
                const saved = await runtime.nativeContent
                    .collection(model.name)
                    .get(documentId(model, entry.id, entry.locale), { revision: receipt.revision })
                if (!saved) throw new Error('The Console save committed but its document could not be read.')
                return clean(saved)
            }),
        remove: (input, context) =>
            rpc(async () => {
                const model = managed(input.collection)
                if (!model) return await base.remove(input, context)
                await nativeAccess(model.name, 'write', context, input.id)
                const entry = selected(model, input.id)
                warnings(
                    await runtime.content.remove(model.name, entry.id, {
                        actor: actor(context),
                        locale: entry.locale,
                        ifDigest: input.ifDigest,
                    }),
                )
            }),
        restore: (input, context) =>
            rpc(async () => {
                const model = managed(input.collection)
                if (!model) return await base.restore(input, context)
                await checkRead(model.name, context, input.id)
                await nativeAccess(model.name, 'read', context, input.id)
                await nativeAccess(model.name, 'write', context, input.id)
                const entry = selected(model, input.id)
                const receipt = await runtime.content.restore(model.name, entry.id, input.revision, {
                    actor: actor(context),
                    locale: entry.locale,
                    ifDigest: input.ifDigest,
                })
                warnings(receipt)
                const saved = await runtime.nativeContent
                    .collection(model.name)
                    .get(documentId(model, entry.id, entry.locale), { revision: receipt.revision })
                if (!saved) throw new Error('The restore committed but its document could not be read.')
                return clean(saved)
            }),
        publish: (input, context) =>
            rpc(async () => {
                if (!managed(input.collection)) return await base.publish(input, context)
                for (const item of input.expect) await nativeAccess(input.collection, 'publish', context, item.id)
                const receipt = await runtime.content.publish(
                    await expectations(input.collection, input.expect, context),
                    { actor: actor(context) },
                )
                warnings(receipt)
                return {
                    revision: receipt.revision,
                    documents: input.expect.map((item) => ({
                        collection: input.collection,
                        id: item.id,
                        change: item.digest === null ? ('delete' as const) : ('update' as const),
                    })),
                }
            }),
        schedule: (input, context) =>
            rpc(async () => {
                if (!managed(input.collection)) return await base.schedule(input, context)
                for (const item of input.expect) await nativeAccess(input.collection, 'publish', context, item.id)
                const receipt = await runtime.content.schedule(
                    await expectations(input.collection, input.expect, context),
                    new Date(input.at),
                    { actor: actor(context) },
                )
                warnings(receipt)
                return { id: receipt.id, at: receipt.at, status: 'pending', documents: [...input.expect] }
            }),
        unschedule: (input, context) =>
            rpc(async () => {
                if (!managed(input.collection)) return await base.unschedule(input, context)
                await nativeAccess(input.collection, 'publish', context)
                warnings(await runtime.content.cancelSchedule(input.schedule, { actor: actor(context) }))
            }),
        overview: (input, context) =>
            rpc(async () => {
                await allRead(context)
                return await base.overview(input, context)
            }),
        search: (input, context) =>
            rpc(async () => {
                await allRead(context)
                return await base.search(input, context)
            }),
        references: (input, context) =>
            rpc(async () => {
                await allRead(context)
                return await base.references(input, context)
            }),
        sessions: (input, context) =>
            rpc(async () => {
                await allRead(context)
                return await base.sessions(input, context)
            }),
        session: (input, context) =>
            rpc(async () => {
                await checkRead(input.collection, context, input.id)
                return await base.session(input, context)
            }),
    }
    return actions
}
