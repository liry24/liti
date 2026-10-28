import { AsyncLocalStorage } from 'node:async_hooks'
import type { ContentDocumentsRuntime, ContentDocument } from '@vite-hub/content'
import {
    registerWorkspacePlugin,
    useWorkspace,
    isWorkspaceConflict,
    type WorkspaceEntry,
    type WorkspaceRevision,
    type WorkspaceRevisionView,
    type WorkspaceWriteInput,
} from '@vite-hub/workspace'
import { authorize } from '../authorization/index'
import { assertIdentity, ModelError } from '../definition/errors'
import { normalizeModelUrl } from '../definition/url'
import { assertJson, referenceValues, validateData, queryFilter } from '../definition/validation'
import type { Actor, ContentModel, ModelAction } from '../definition/model'
import { notifyCommitted } from '../internal/committed'
import { documentId, modelLocale, resolveTranslation, splitDocumentId } from '../i18n/index'

import type {
    ModelOperation,
    SaveInput,
    PublicationInfo,
    ContentEntry,
    DraftEntry,
    PublishSelection,
} from '../definition/entries'
export type {
    ModelOperation,
    SaveInput,
    PublicationInfo,
    ContentEntry,
    DraftEntry,
    PublishSelection,
} from '../definition/entries'

export interface ContentBindingOptions {
    content: ContentDocumentsRuntime
    workspace: string
    models: readonly ContentModel[]
    records?: { exists(model: string, id: string): Promise<boolean> }
}
interface WriteScope {
    heads: Record<string, string | null>
    paths: Set<string>
    actor: Actor
    signal?: AbortSignal
}
interface SnapshotJob {
    id: string
    at: string
    actor: string
    revision: string
    selection: PublishSelection[]
    expectedPublished: Record<string, string | null>
}
const metaRoot = '.liti/model'
const queueRef = 'liti-schedules'
const jobPath = (id: string) => `${metaRoot}/schedules/${assertIdentity(id)}.json`
const receiptPath = (id: string) => `${metaRoot}/receipts/${assertIdentity(id)}.json`
const publicationPath = (model: string, id: string) => `${metaRoot}/publication/${model}/${assertIdentity(id)}.json`
const orderPath = (model: string) => `${metaRoot}/order/${model}.json`

export function createModelContent(options: ContentBindingOptions) {
    const models = new Map(options.models.map((model) => [model.name, model]))
    if (models.size !== options.models.length) throw new ModelError('LITI_INVALID_MODEL', 'Duplicate model name.')
    const scope = new AsyncLocalStorage<WriteScope>()
    const workspace = () => useWorkspace(options.workspace, { mode: 'write' })
    const modelOf = (name: string) => {
        const model = models.get(name)
        if (!model) throw new ModelError('LITI_INVALID_MODEL', `Unknown Content model: ${name}`)
        return model
    }
    const collection = (model: ContentModel) => {
        const value = options.content.collection(model.name)
        const expected = `${model.name}/**/*.${model.format === 'json' ? 'json' : 'md'}`
        if (value.kind !== 'documents' || value.path !== expected)
            throw new ModelError('LITI_INVALID_MODEL', `Connect ${model.name} with contentCollection().`)
        return value
    }
    for (const model of models.values()) collection(model)
    if (typeof options.content.commitPublished !== 'function')
        throw new ModelError(
            'LITI_INVALID_MODEL',
            'The pinned Content publication transaction extension must be applied in the application root.',
        )
    const refs = (model: ContentModel) => [
        ...Object.entries(model.fields).flatMap(([path, definition]) =>
            definition.reference ? [{ path, model: definition.reference }] : [],
        ),
        ...(model.references ?? []),
    ]
    const pathsFor = (model: ContentModel, id: string, locales = model.locales?.supported ?? ['und']) =>
        locales.map(
            (locale) => `${model.name}/${documentId(model, id, locale)}.${model.format === 'json' ? 'json' : 'md'}`,
        )
    const head = async (ref: string) => await workspace().history.head({ ref })
    const view = async (ref: string) => {
        const current = await head(ref)
        return current ? await workspace().history.open(current.id) : null
    }
    const snapshotFiles = new WeakMap<WorkspaceRevisionView, Promise<Map<string, WorkspaceEntry>>>()
    const index = async (snapshot: WorkspaceRevisionView) => {
        let indexed = snapshotFiles.get(snapshot)
        if (!indexed) {
            indexed = snapshot
                .list('', { recursive: true })
                .then((files) => new Map(files.map((file) => [file.path, file])))
            snapshotFiles.set(snapshot, indexed)
        }
        return await indexed
    }
    const files = async (snapshot: WorkspaceRevisionView | null) =>
        snapshot ? [...(await index(snapshot)).values()] : []
    const has = async (snapshot: WorkspaceRevisionView | null, path: string) =>
        snapshot ? (await index(snapshot)).get(path)?.type === 'file' : false
    const json = async <T>(snapshot: WorkspaceRevisionView | null, path: string): Promise<T | null> =>
        (await has(snapshot, path)) ? (JSON.parse(await snapshot!.readFile(path, { encoding: 'utf8' })) as T) : null
    const fingerprint = async (snapshot: WorkspaceRevisionView | null, path: string): Promise<string | null> => {
        if (!snapshot || !(await has(snapshot, path))) return null
        const digest = (await index(snapshot)).get(path)?.digest
        if (digest) return digest
        const bytes = new Uint8Array(await snapshot.readFile(path, { encoding: 'binary' }))
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
            value.toString(16).padStart(2, '0'),
        ).join('')
    }
    const check = async (
        model: ContentModel,
        action: ModelAction,
        id: string,
        locale: string,
        operation: ModelOperation,
    ) => {
        await authorize(model, { ...operation, action, id: assertIdentity(id), locale: modelLocale(model, locale) })
    }
    const run = async <T>(
        operation: ModelOperation,
        heads: Record<string, string | null>,
        paths: readonly string[],
        task: () => Promise<T>,
    ) =>
        await scope.run(
            {
                heads,
                paths: new Set(paths),
                actor: operation.actor,
                ...(operation.signal ? { signal: operation.signal } : {}),
            },
            async () => {
                operation.signal?.throwIfAborted()
                try {
                    return await task()
                } catch (error) {
                    if (isWorkspaceConflict(error))
                        throw new ModelError('LITI_CONFLICT', 'The Workspace changed before commit.', [], {
                            cause: error,
                        })
                    throw error
                }
            },
        )
    const commit = async <T>(
        ref: string,
        parent: string | null,
        task: (operationId: string) => Promise<T>,
        recover: (revision: WorkspaceRevision) => Promise<T> | T,
    ) => {
        const operationId = crypto.randomUUID()
        try {
            return { result: await task(operationId), postCommitErrors: [] as { code: string; message: string }[] }
        } catch (error) {
            // A write:after failure must not turn a committed write into an apparent failed save.
            let revision = await head(ref)
            while (revision && revision.id !== parent) {
                if (revision.metadata?.litiOperationId === operationId)
                    return {
                        result: await recover(revision),
                        postCommitErrors: [
                            { code: 'LITI_POST_COMMIT', message: 'The write committed; a post-commit hook failed.' },
                        ],
                    }
                revision = revision.parentId ? (await workspace().history.open(revision.parentId)).revision : null
            }
            throw error
        }
    }
    const guard = async (input: WorkspaceWriteInput) => {
        if (!models.has(input.path.split('/')[0]!) && !input.path.startsWith(`${metaRoot}/`)) return
        const active = scope.getStore()
        if (!active || !active.paths.has(input.path))
            throw new ModelError('LITI_FORBIDDEN', 'Use the authorized Model operation for this document.')
        active.signal?.throwIfAborted()
        for (const [ref, expected] of Object.entries(active.heads))
            if ((await head(ref))?.id !== (expected ?? undefined))
                throw new ModelError('LITI_CONFLICT', `${ref} changed during model validation.`)
    }
    const dispose = registerWorkspacePlugin(options.workspace, {
        id: 'liti-model-integrity',
        hooks: { 'write:validate': guard },
    })
    const stored = async (model: ContentModel, id: string, locale: string, snapshot: WorkspaceRevisionView | null) =>
        snapshot ? await collection(model).get(documentId(model, id, locale), { revision: snapshot.revision.id }) : null
    const dataOf = (document: ContentDocument | null) =>
        Object.fromEntries(Object.entries(document?.data ?? {}).filter(([key]) => !key.startsWith('_liti')))
    const originalLocale = (model: ContentModel) => model.locales?.default ?? 'und'
    const validateReferences = async (
        model: ContentModel,
        data: Record<string, unknown>,
        snapshot: WorkspaceRevisionView | null,
        candidates = new Set<string>(),
        removed = new Set<string>(),
    ) => {
        for (const reference of refs(model)) {
            const ids = referenceValues(data, reference.path)
            if ('optional' in reference && !reference.optional && !ids.length)
                throw new ModelError('LITI_REFERENCE', `Required reference: ${reference.path}`)
            for (const id of ids) {
                assertIdentity(id)
                const target = models.get(reference.model)
                const exists = target
                    ? !removed.has(`${target.name}/${id}`) &&
                      (candidates.has(`${target.name}/${id}`) ||
                          (await has(snapshot, pathsFor(target, id, [originalLocale(target)])[0]!)))
                    : await options.records?.exists(reference.model, id)
                if (!exists)
                    throw new ModelError('LITI_REFERENCE', `Missing ${reference.model}/${id}.`, [
                        { path: reference.path.split('.'), message: 'The referenced entry does not exist.' },
                    ])
            }
        }
    }
    const project = async (
        model: ContentModel,
        id: string,
        locale: string,
        snapshot: WorkspaceRevisionView | null,
        fallback = true,
    ): Promise<ContentEntry | null> => {
        const original = await stored(model, id, originalLocale(model), snapshot)
        if (!original) return null
        const translated = locale === originalLocale(model) ? original : await stored(model, id, locale, snapshot)
        if (!translated && !fallback) return null
        const data = Object.fromEntries(
            Object.entries(resolveTranslation(model, dataOf(original), dataOf(translated), fallback)).filter(
                ([key]) => model.fields[key]?.public !== false,
            ),
        )
        const body = translated?.data['_litiBody'] ? translated.body : fallback ? original.body : ''
        const routeData = Object.fromEntries(
            Object.entries(resolveTranslation(model, dataOf(original), dataOf(translated), true)).filter(
                ([key]) => model.fields[key]?.public !== false,
            ),
        )
        const url = normalizeModelUrl(model.url?.({ id, locale, data: routeData }))
        const ordering = await json<Record<string, number>>(snapshot, orderPath(model.name))
        return {
            id,
            model: model.name,
            locale,
            translated: Boolean(translated),
            data,
            body,
            order: ordering?.[id] ?? Number(original.data['_litiOrder']),
            url,
            publication: await json<PublicationInfo>(snapshot, publicationPath(model.name, id)),
        }
    }

    const read = async (name: string, id: string, locale?: string, readOptions: { fallback?: boolean } = {}) => {
        const model = modelOf(name)
        return await project(
            model,
            assertIdentity(id),
            modelLocale(model, locale),
            await view('published'),
            readOptions.fallback ?? true,
        )
    }
    const resolveUrl = async (path: string) => {
        const normalized = normalizeModelUrl(path)!
        const snapshot = await view('published')
        const routes = await json<Record<string, string>>(snapshot, `${metaRoot}/routes.json`)
        const owner = routes?.[normalized]
        if (!owner) return null
        const [name, id, locale] = owner.split('/')
        const entry = await project(modelOf(name!), assertIdentity(id!), modelLocale(modelOf(name!), locale), snapshot)
        return entry?.url
            ? { entry, url: entry.url, kind: entry.url === normalized ? ('entry' as const) : ('redirect' as const) }
            : null
    }
    const query = async (
        name: string,
        queryOptions: {
            locale?: string
            fallback?: boolean
            limit?: number
            offset?: number
            filter?: Record<string, unknown>
        } = {},
    ) => {
        const model = modelOf(name),
            snapshot = await view('published')
        const filter = await queryFilter(model.fields, queryOptions.filter)
        const suffix = `/${originalLocale(model)}.${model.format === 'json' ? 'json' : 'md'}`
        const ids = (await files(snapshot))
            .filter((file) => file.type === 'file' && file.path.startsWith(`${name}/`) && file.path.endsWith(suffix))
            .map((file) => splitDocumentId(file.path.slice(name.length + 1).replace(/\.(md|json)$/u, '')).id)
        const entries = (
            await Promise.all(
                ids.map((id) =>
                    project(
                        model,
                        id,
                        modelLocale(model, queryOptions.locale),
                        snapshot,
                        queryOptions.fallback ?? true,
                    ),
                ),
            )
        ).filter((entry) => entry !== null)
        const filtered = entries.filter((entry) =>
            Object.entries(filter).every(([key, value]) => entry.data[key] === value),
        )
        filtered.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        const limit = queryOptions.limit ?? 50,
            offset = queryOptions.offset ?? 0
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0)
            throw new ModelError('LITI_INVALID_INPUT', 'Invalid query page.')
        return {
            items: filtered.slice(offset, offset + limit),
            total: filtered.length,
            revision: snapshot?.revision.id ?? null,
        }
    }
    const readDraft = async (
        name: string,
        id: string,
        operation: ModelOperation,
        locale?: string,
        readOptions: { revision?: string } = {},
    ): Promise<DraftEntry | null> => {
        const model = modelOf(name),
            selected = modelLocale(model, locale)
        await check(model, 'readDraft', id, selected, operation)
        const snapshot = readOptions.revision
                ? await workspace().history.open(readOptions.revision)
                : await view('draft'),
            document = await stored(model, id, selected, snapshot)
        const ordering = await json<Record<string, number>>(snapshot, orderPath(name))
        return document
            ? {
                  id,
                  model: name,
                  locale: selected,
                  data: dataOf(document),
                  ...(document.data['_litiBody'] ? { body: document.body } : {}),
                  order: ordering?.[id] ?? Number(document.data['_litiOrder']),
                  digest: document.digest,
                  revision: document.revision,
                  updatedAt: document.updatedAt,
              }
            : null
    }
    const saveDraft = async (
        name: string,
        id: string,
        input: SaveInput,
        write: ModelOperation & { ifDigest: string | null; locale?: string },
        action: 'save' | 'restore',
    ) => {
        const model = modelOf(name),
            locale = modelLocale(model, write.locale),
            isOriginal = locale === originalLocale(model)
        await check(model, 'save', id, locale, write)
        if (!Object.hasOwn(write, 'ifDigest'))
            throw new ModelError('LITI_INVALID_INPUT', 'A reviewed draft digest is required.')
        const snapshot = await view('draft'),
            before = await stored(model, id, locale, snapshot)
        if ((before?.digest ?? null) !== write.ifDigest) throw new ModelError('LITI_CONFLICT', 'The draft changed.')
        const original = isOriginal ? before : await stored(model, id, originalLocale(model), snapshot)
        if (!isOriginal && !original)
            throw new ModelError('LITI_REFERENCE', 'Create the original translation group first.')
        if (input.body !== undefined && input.body !== null && typeof input.body !== 'string')
            throw new ModelError('LITI_INVALID_INPUT', 'A Markdown body must be a string.')
        const context = {
            ...write,
            id,
            locale,
            action: 'save' as const,
            previous: before ? dataOf(before) : null,
            body:
                input.body === null
                    ? (original?.body ?? '')
                    : (input.body ?? (before?.data['_litiBody'] ? before.body : original?.body) ?? ''),
            ...(snapshot ? { revision: snapshot.revision.id } : {}),
        }
        input = model.prepare ? await model.prepare(input, context) : input
        const data = await validateData(model.fields, input.data, { sparse: !isOriginal, localizedOnly: !isOriginal })
        if (input.body !== undefined && input.body !== null && typeof input.body !== 'string')
            throw new ModelError('LITI_INVALID_INPUT', 'A Markdown body must be a string.')
        if (isOriginal && input.body === null)
            throw new ModelError('LITI_INVALID_INPUT', 'Only translations can inherit a body.')
        const hasBody =
            input.body === null ? false : input.body !== undefined || Boolean(before?.data['_litiBody']) || isOriginal
        const body = hasBody ? (input.body ?? before?.body ?? '') : ''
        if (model.format === 'json' && body)
            throw new ModelError('LITI_INVALID_INPUT', 'JSON models have no Markdown body.')
        const order = input.order ?? Number(before?.data['_litiOrder'] ?? 0)
        if (!Number.isFinite(order)) throw new ModelError('LITI_INVALID_INPUT', 'Invalid ordering value.')
        const effectiveData = isOriginal
            ? data
            : await validateData(model.fields, resolveTranslation(model, dataOf(original), data, true))
        await validateReferences(model, effectiveData, snapshot)
        await model.validate?.(effectiveData, { ...context, body: hasBody ? body : (original?.body ?? '') })
        const path = pathsFor(model, id, [locale])[0]!
        const receipt = await run(write, { draft: snapshot?.revision.id ?? null }, [path], () =>
            commit(
                'draft',
                snapshot?.revision.id ?? null,
                (operationId) =>
                    collection(model).save(
                        documentId(model, id, locale),
                        {
                            data: {
                                ...data,
                                _litiOrder: order,
                                _litiBody: hasBody,
                            },
                            body,
                        },
                        {
                            ifDigest: write.ifDigest,
                            metadata: { litiActor: write.actor.id, litiOperationId: operationId },
                        },
                    ),
                async (revision) => {
                    const document = await stored(model, id, locale, await workspace().history.open(revision.id))
                    if (!document) throw new ModelError('LITI_NOT_FOUND', 'The committed save receipt is unavailable.')
                    return document
                },
            ),
        )
        receipt.postCommitErrors.push(
            ...(await notifyCommitted(
                model,
                {
                    action: action === 'restore' ? 'restore' : before ? 'update' : 'create',
                    id,
                    locale,
                    actor: write.actor,
                    revision: receipt.result.revision,
                },
                effectiveData,
            )),
        )
        return {
            id,
            locale,
            digest: receipt.result.digest,
            revision: receipt.result.revision,
            postCommitErrors: receipt.postCommitErrors,
        }
    }

    const save = async (
        name: string,
        id: string,
        input: SaveInput,
        write: ModelOperation & { ifDigest: string | null; locale?: string },
    ) => await saveDraft(name, id, input, write, 'save')

    async function publishSnapshot(
        selection: readonly PublishSelection[],
        source: WorkspaceRevisionView,
        operation: ModelOperation,
        job?: { queue: string; id: string; expectedPublished: Record<string, string | null> },
        action: 'publish' | 'schedule' = 'publish',
    ) {
        if (!selection.length) throw new ModelError('LITI_INVALID_INPUT', 'Select entries for publication.')
        if (new Set(selection.map((entry) => `${entry.model}/${entry.id}`)).size !== selection.length)
            throw new ModelError('LITI_INVALID_INPUT', 'Duplicate publication entry.')
        const published = await view('published')
        if (job)
            for (const [path, expected] of Object.entries(job.expectedPublished))
                if ((await fingerprint(published, path)) !== expected)
                    throw new ModelError(
                        'LITI_CONFLICT',
                        'A scheduled entry was published or unpublished after scheduling.',
                    )
        const putting: Record<string, string | Uint8Array> = {},
            deleting: string[] = []
        const candidates = new Set(selection.map((entry) => `${entry.model}/${assertIdentity(entry.id)}`))
        const removed = new Set<string>()
        for (const entry of selection) {
            const model = modelOf(entry.model)
            if (!(await stored(model, entry.id, originalLocale(model), source))) {
                removed.add(`${model.name}/${entry.id}`)
                candidates.delete(`${model.name}/${entry.id}`)
            }
        }
        const now = new Date().toISOString()
        let changed = false
        for (const entry of selection) {
            const model = modelOf(entry.model),
                locales = entry.locales ?? model.locales?.supported ?? ['und']
            if (new Set(locales).size !== locales.length)
                throw new ModelError('LITI_INVALID_INPUT', 'Duplicate selected locale.')
            if (!locales.includes(originalLocale(model)))
                throw new ModelError('LITI_INVALID_INPUT', 'Publish the original and its translations together.')
            let entryChanged = false
            if (
                removed.has(`${model.name}/${entry.id}`) &&
                !(await has(published, pathsFor(model, entry.id, [originalLocale(model)])[0]!))
            )
                throw new ModelError('LITI_NOT_FOUND', 'No reviewed document or published deletion to commit.')
            for (const locale of locales) {
                await check(model, action, entry.id, locale, operation)
                const document = await stored(model, entry.id, locale, source)
                if (!Object.hasOwn(entry.digests, locale))
                    throw new ModelError(
                        'LITI_INVALID_INPUT',
                        'Review each selected translation, including absent translations.',
                    )
                const expected = entry.digests[locale]
                if (document && document.digest !== expected)
                    throw new ModelError('LITI_CONFLICT', 'A selected translation changed after review.')
                if (!document) {
                    if (expected) throw new ModelError('LITI_CONFLICT', 'A reviewed translation was removed.')
                    const path = pathsFor(model, entry.id, [locale])[0]!
                    if (await has(published, path)) {
                        deleting.push(path)
                        entryChanged = true
                    }
                    continue
                }
                if (document.issues?.length) throw new ModelError('LITI_INVALID_INPUT', 'Content validation failed.')
                const original = await stored(model, entry.id, originalLocale(model), source)
                if (!original) throw new ModelError('LITI_REFERENCE', 'Translation group has no original.')
                const data = resolveTranslation(model, dataOf(original), dataOf(document), true)
                await validateData(model.fields, data)
                await validateReferences(model, data, published, candidates, removed)
                const previous = await stored(model, entry.id, locale, published)
                await model.validate?.(data, {
                    ...operation,
                    id: entry.id,
                    locale,
                    action,
                    body: document.data['_litiBody'] ? document.body : original.body,
                    revision: source.revision.id,
                    previous: previous ? dataOf(previous) : null,
                })
                putting[document.path] = await source.readFile(document.path)
                if ((await stored(model, entry.id, locale, published))?.digest !== document.digest) entryChanged = true
            }
            const old = await json<PublicationInfo>(published, publicationPath(model.name, entry.id))
            putting[publicationPath(model.name, entry.id)] = JSON.stringify({
                firstPublishedAt: old ? old.firstPublishedAt : now,
                updatedAt: entryChanged ? now : (old?.updatedAt ?? null),
            })
            if (entryChanged) changed = true
        }
        // Validate the whole resulting published graph and reserve historical URLs in this same CAS commit.
        const routes = (await json<Record<string, string>>(published, `${metaRoot}/routes.json`)) ?? {}
        for (const model of models.values()) {
            const existing = (await files(published)).filter(
                (file) => file.type === 'file' && file.path.startsWith(`${model.name}/`),
            )
            const paths = new Set([
                ...existing.map((file) => file.path),
                ...Object.keys(putting).filter((path) => path.startsWith(`${model.name}/`)),
            ])
            for (const path of paths) {
                if (deleting.includes(path)) continue
                const parsed = splitDocumentId(path.slice(model.name.length + 1).replace(/\.(md|json)$/u, ''))
                const fromSource = Object.hasOwn(putting, path)
                const document = await stored(model, parsed.id, parsed.locale, fromSource ? source : published)
                if (!document) continue
                await validateReferences(model, dataOf(document), published, candidates, removed)
                const original = await stored(
                    model,
                    parsed.id,
                    originalLocale(model),
                    candidates.has(`${model.name}/${parsed.id}`) ? source : published,
                )
                if (!original) throw new ModelError('LITI_REFERENCE', 'Publication would orphan a translation.')
            }
            const ids = new Set(
                [...paths]
                    .filter((path) => !deleting.includes(path))
                    .map((path) => splitDocumentId(path.slice(model.name.length + 1).replace(/\.(md|json)$/u, '')).id),
            )
            for (const id of ids) {
                const originalPath = pathsFor(model, id, [originalLocale(model)])[0]!
                if (deleting.includes(originalPath)) continue
                const original = await stored(
                    model,
                    id,
                    originalLocale(model),
                    Object.hasOwn(putting, originalPath) ? source : published,
                )
                if (!original) continue
                for (const locale of model.locales?.supported ?? ['und']) {
                    const path = pathsFor(model, id, [locale])[0]!
                    const translated = deleting.includes(path)
                        ? null
                        : await stored(model, id, locale, Object.hasOwn(putting, path) ? source : published)
                    const data = resolveTranslation(model, dataOf(original), dataOf(translated), true)
                    const publicData = Object.fromEntries(
                        Object.entries(data).filter(([key]) => model.fields[key]?.public !== false),
                    )
                    const url = normalizeModelUrl(model.url?.({ id, locale, data: publicData }))
                    if (!url) continue
                    const owner = `${model.name}/${id}/${locale}`
                    if (routes[url] && routes[url] !== owner)
                        throw new ModelError('LITI_ROUTE_CONFLICT', `A current or historical URL is reserved: ${url}`)
                    routes[url] = owner
                }
            }
        }
        for (const name of new Set(selection.map((entry) => entry.model))) {
            if (await has(source, orderPath(name))) {
                const model = modelOf(name)
                const currentIds = (await files(source))
                    .filter(
                        (file) =>
                            file.type === 'file' &&
                            file.path.startsWith(`${name}/`) &&
                            file.path.endsWith(`/${originalLocale(model)}.${model.format === 'json' ? 'json' : 'md'}`),
                    )
                    .map((file) => splitDocumentId(file.path.slice(name.length + 1).replace(/\.(md|json)$/u, '')).id)
                const sourceOrder = await source.readFile(orderPath(name))
                const oldOrder =
                    published && (await has(published, orderPath(name)))
                        ? await published.readFile(orderPath(name))
                        : null
                if (String(sourceOrder) !== String(oldOrder)) {
                    if (currentIds.some((id) => !candidates.has(`${name}/${id}`)))
                        throw new ModelError(
                            'LITI_INVALID_INPUT',
                            'Publish every current model entry when publishing a reordered list.',
                        )
                    changed = true
                }
                putting[orderPath(name)] = sourceOrder
            }
        }
        putting[`${metaRoot}/routes.json`] = JSON.stringify(routes)
        if (job) putting[receiptPath(job.id)] = JSON.stringify({ completedAt: now, actor: operation.actor.id })
        if (action === 'schedule' || (!changed && !job && published))
            return {
                revision: action === 'schedule' ? source.revision.id : published!.revision.id,
                publishedRevision: published?.revision.id ?? null,
                entries: selection.map((entry) => ({ model: entry.model, id: entry.id })),
                postCommitErrors: [],
            }
        const heads = {
            published: published?.revision.id ?? null,
            ...(job ? { [queueRef]: job.queue } : { draft: source.revision.id }),
        }
        const result = await run(operation, heads, [...Object.keys(putting), ...deleting], () =>
            options.content.commitPublished({
                ifHead: published?.revision.id ?? null,
                ifHeads: job ? { [queueRef]: job.queue } : { draft: source.revision.id },
                changes: { put: putting, delete: deleting },
                metadata: { litiActor: operation.actor.id },
            }),
        )
        const notifications = []
        for (const entry of selection)
            notifications.push(
                ...(await notifyCommitted(modelOf(entry.model), {
                    action: 'publish',
                    id: entry.id,
                    actor: operation.actor,
                    revision: result.revision.id,
                })),
            )
        return {
            revision: result.revision.id,
            publishedRevision: result.revision.id,
            entries: selection.map((entry) => ({ model: entry.model, id: entry.id })),
            postCommitErrors: [
                ...notifications,
                ...result.postCommitErrors.map(() => ({
                    code: 'LITI_POST_COMMIT',
                    message: 'Publication committed; a post-commit listener failed.',
                })),
            ],
        }
    }
    const publish = async (
        selection: readonly PublishSelection[],
        operation: ModelOperation & { ifDraftRevision?: string },
    ) => {
        const source = await view('draft')
        if (!source) throw new ModelError('LITI_NOT_FOUND', 'No draft to publish.')
        if (operation.ifDraftRevision !== undefined && source.revision.id !== operation.ifDraftRevision)
            throw new ModelError('LITI_CONFLICT', 'The reviewed draft list changed.')
        return await publishSnapshot(selection, source, operation)
    }
    const schedule = async (selection: readonly PublishSelection[], at: Date, operation: ModelOperation) => {
        if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now())
            throw new ModelError('LITI_INVALID_INPUT', 'Schedule a future publication.')
        const draft = await view('draft')
        if (!draft || !selection.length) throw new ModelError('LITI_NOT_FOUND', 'No reviewed draft.')
        const validation = await publishSnapshot(selection, draft, operation, undefined, 'schedule')
        const queue = await head(queueRef),
            id = crypto.randomUUID()
        const published = validation.publishedRevision
            ? await workspace().history.open(validation.publishedRevision)
            : null
        const expectedPublished: Record<string, string | null> = {}
        for (const entry of selection) {
            const model = modelOf(entry.model)
            for (const path of [
                ...pathsFor(model, entry.id, entry.locales ?? model.locales?.supported ?? ['und']),
                orderPath(model.name),
            ])
                expectedPublished[path] = await fingerprint(published, path)
        }
        const job: SnapshotJob = {
            id,
            at: at.toISOString(),
            actor: operation.actor.id,
            revision: draft.revision.id,
            selection: structuredClone([...selection]),
            expectedPublished,
        }
        assertJson(job)
        const receipt = await run(
            operation,
            { draft: draft.revision.id, published: validation.publishedRevision, [queueRef]: queue?.id ?? null },
            [jobPath(id)],
            () =>
                commit(
                    queueRef,
                    queue?.id ?? null,
                    (operationId) =>
                        workspace().history.commit({
                            ref: queueRef,
                            ifHead: queue?.id ?? null,
                            ifHeads: { draft: draft.revision.id, published: validation.publishedRevision },
                            changes: { put: { [jobPath(id)]: JSON.stringify(job) } },
                            metadata: { litiActor: operation.actor.id, litiOperationId: operationId },
                        }),
                    (revision) => revision,
                ),
        )
        for (const entry of selection)
            receipt.postCommitErrors.push(
                ...(await notifyCommitted(modelOf(entry.model), {
                    action: 'schedule',
                    id: entry.id,
                    actor: operation.actor,
                    revision: receipt.result.id,
                })),
            )
        return { id, at: job.at, revision: job.revision, postCommitErrors: receipt.postCommitErrors }
    }
    const cancelSchedule = async (id: string, operation: ModelOperation) => {
        const queue = await view(queueRef),
            job = await json<SnapshotJob>(queue, jobPath(id))
        if (!job) throw new ModelError('LITI_NOT_FOUND', 'No scheduled publication.')
        for (const entry of job.selection)
            await check(modelOf(entry.model), 'schedule', entry.id, originalLocale(modelOf(entry.model)), operation)
        const published = await view('published')
        if (await has(published, receiptPath(id)))
            throw new ModelError('LITI_CONFLICT', 'The scheduled publication already committed.')
        const receipt = await run(
            operation,
            { [queueRef]: queue!.revision.id, published: published?.revision.id ?? null },
            [jobPath(id)],
            () =>
                commit(
                    queueRef,
                    queue!.revision.id,
                    (operationId) =>
                        workspace().history.commit({
                            ref: queueRef,
                            ifHead: queue!.revision.id,
                            ifHeads: { published: published?.revision.id ?? null },
                            changes: { delete: [jobPath(id)] },
                            metadata: { litiActor: operation.actor.id, litiOperationId: operationId },
                        }),
                    (revision) => revision,
                ),
        )
        for (const entry of job.selection)
            receipt.postCommitErrors.push(
                ...(await notifyCommitted(modelOf(entry.model), {
                    action: 'cancelSchedule',
                    id: entry.id,
                    actor: operation.actor,
                    revision: receipt.result.id,
                })),
            )
        return { id, revision: receipt.result.id, postCommitErrors: receipt.postCommitErrors }
    }
    const inspect = async (name: string, id: string, operation: ModelOperation, locale?: string) => {
        const model = modelOf(name),
            selected = modelLocale(model, locale)
        await check(model, 'readDraft', assertIdentity(id), selected, operation)
        const queue = await view(queueRef),
            publishedView = await view('published')
        const published = publishedView
            ? await collection(model).get(documentId(model, id, selected), { revision: publishedView.revision.id })
            : null
        const schedules: { id: string; at: string; revision: string }[] = []
        for (const file of (await files(queue)).filter((candidate) =>
            candidate.path.startsWith(`${metaRoot}/schedules/`),
        )) {
            const job = await json<SnapshotJob>(queue, file.path)
            if (
                job?.selection.some((entry) => entry.model === name && entry.id === id) &&
                !(await has(publishedView, receiptPath(job.id)))
            )
                schedules.push({ id: job.id, at: job.at, revision: job.revision })
        }
        return {
            published: published ? { digest: published.digest, revision: published.revision } : null,
            publishedHead: publishedView?.revision.id ?? null,
            history: await options.content.revisions(name, documentId(model, id, selected), {
                ref: 'draft',
                limit: 100,
            }),
            schedules,
        }
    }
    const publishDue = async (operation: ModelOperation, now = new Date()) => {
        if (!Number.isFinite(now.getTime()))
            throw new ModelError('LITI_INVALID_INPUT', 'Invalid schedule execution time.')
        const queue = await view(queueRef)
        const completed: string[] = [],
            failed: { id: string; error: unknown }[] = []
        const cleanup: string[] = [],
            postCommitErrors: { id: string; message: string }[] = []
        for (const file of (await files(queue)).filter(
            (candidate) => candidate.type === 'file' && candidate.path.startsWith(`${metaRoot}/schedules/`),
        )) {
            const job = await json<SnapshotJob>(queue, file.path)
            if (!job || new Date(job.at).getTime() > now.getTime()) continue
            if (await has(await view('published'), receiptPath(job.id))) {
                cleanup.push(file.path)
                continue
            }
            try {
                for (const entry of job.selection)
                    await check(
                        modelOf(entry.model),
                        'publish',
                        entry.id,
                        originalLocale(modelOf(entry.model)),
                        operation,
                    )
                const result = await publishSnapshot(
                    job.selection,
                    await workspace().history.open(job.revision),
                    operation,
                    { queue: queue!.revision.id, id: job.id, expectedPublished: job.expectedPublished },
                )
                completed.push(job.id)
                cleanup.push(file.path)
                for (const error of result.postCommitErrors)
                    postCommitErrors.push({ id: job.id, message: error.message })
            } catch (error) {
                if (
                    (isWorkspaceConflict(error) || (error instanceof ModelError && error.code === 'LITI_CONFLICT')) &&
                    (await has(await view('published'), receiptPath(job.id)))
                ) {
                    completed.push(job.id)
                    cleanup.push(file.path)
                } else failed.push({ id: job.id, error })
            }
        }
        if (queue && cleanup.length)
            try {
                await run(operation, { [queueRef]: queue.revision.id }, cleanup, () =>
                    workspace().history.commit({
                        ref: queueRef,
                        ifHead: queue.revision.id,
                        changes: { delete: cleanup },
                    }),
                )
            } catch (error) {
                if (!isWorkspaceConflict(error) && !(error instanceof ModelError && error.code === 'LITI_CONFLICT'))
                    postCommitErrors.push({
                        id: queue.revision.id,
                        message: 'Publication committed; completed schedule cleanup must be retried.',
                    })
            }
        return { completed, failed, postCommitErrors }
    }
    const unpublish = async (name: string, id: string, operation: ModelOperation & { ifHead: string }) => {
        const model = modelOf(name)
        await check(model, 'publish', id, originalLocale(model), operation)
        const published = await view('published')
        if (!published || published.revision.id !== operation.ifHead)
            throw new ModelError('LITI_CONFLICT', 'The published version changed.')
        const deleting = (await files(published))
            .filter((file) => file.type === 'file' && file.path.startsWith(`${name}/${assertIdentity(id)}/`))
            .map((file) => file.path)
        if (!deleting.length) throw new ModelError('LITI_NOT_FOUND', 'The entry is not published.')
        for (const owner of models.values())
            for (const reference of refs(owner).filter((candidate) => candidate.model === name)) {
                for (const file of (await files(published)).filter(
                    (candidate) =>
                        candidate.type === 'file' &&
                        candidate.path.startsWith(`${owner.name}/`) &&
                        !deleting.includes(candidate.path),
                )) {
                    const parsed = splitDocumentId(file.path.slice(owner.name.length + 1).replace(/\.(md|json)$/u, ''))
                    if (
                        referenceValues(
                            dataOf(await stored(owner, parsed.id, parsed.locale, published)),
                            reference.path,
                        ).includes(id)
                    )
                        throw new ModelError('LITI_REFERENCE', 'A published entry still references this target.')
                }
            }
        const result = await run(operation, { published: published.revision.id }, deleting, () =>
            options.content.commitPublished({
                ifHead: published.revision.id,
                changes: { delete: deleting },
                metadata: { litiActor: operation.actor.id },
            }),
        )
        return {
            id,
            revision: result.revision.id,
            postCommitErrors: [
                ...(await notifyCommitted(model, {
                    action: 'unpublish',
                    id,
                    actor: operation.actor,
                    revision: result.revision.id,
                })),
                ...result.postCommitErrors.map(() => ({
                    code: 'LITI_POST_COMMIT',
                    message: 'Publication committed; a post-commit listener failed.',
                })),
            ],
        }
    }
    const remove = async (
        name: string,
        id: string,
        operation: ModelOperation & { ifDigest: string; locale?: string },
    ) => {
        const model = modelOf(name),
            locale = modelLocale(model, operation.locale),
            snapshot = await view('draft')
        await check(model, 'remove', id, locale, operation)
        const current = await stored(model, id, locale, snapshot)
        if (!current || current.digest !== operation.ifDigest)
            throw new ModelError('LITI_CONFLICT', 'The draft changed.')
        for (const owner of models.values())
            for (const reference of refs(owner).filter((candidate) => candidate.model === name)) {
                for (const file of (await files(snapshot)).filter(
                    (candidate) => candidate.type === 'file' && candidate.path.startsWith(`${owner.name}/`),
                )) {
                    const target = splitDocumentId(file.path.slice(owner.name.length + 1).replace(/\.(md|json)$/u, ''))
                    const document = await stored(owner, target.id, target.locale, snapshot)
                    if (referenceValues(dataOf(document), reference.path).includes(id))
                        throw new ModelError('LITI_REFERENCE', 'An entry still references this target.')
                }
            }
        if (
            locale === originalLocale(model) &&
            (await files(snapshot)).some(
                (file) => file.type === 'file' && file.path.startsWith(`${name}/${id}/`) && file.path !== current.path,
            )
        )
            throw new ModelError('LITI_REFERENCE', 'Remove translations before their original.')
        const receipt = await run(operation, { draft: snapshot?.revision.id ?? null }, [current.path], () =>
            commit(
                'draft',
                snapshot?.revision.id ?? null,
                (operationId) =>
                    collection(model).remove(documentId(model, id, locale), {
                        ifDigest: operation.ifDigest,
                        metadata: { litiActor: operation.actor.id, litiOperationId: operationId },
                    }),
                () => undefined,
            ),
        )
        receipt.postCommitErrors.push(
            ...(await notifyCommitted(
                model,
                {
                    action: 'remove',
                    id,
                    locale,
                    actor: operation.actor,
                },
                dataOf(current),
            )),
        )
        return { id, locale, postCommitErrors: receipt.postCommitErrors }
    }
    const restore = async (
        name: string,
        id: string,
        revision: string,
        operation: ModelOperation & { ifDigest: string | null; locale?: string },
    ) => {
        const model = modelOf(name),
            locale = modelLocale(model, operation.locale)
        await check(model, 'restore', id, locale, operation)
        const previous = await stored(model, id, locale, await workspace().history.open(revision))
        if (!previous) throw new ModelError('LITI_NOT_FOUND', 'The revision contains no entry.')
        return await saveDraft(
            name,
            id,
            {
                data: dataOf(previous),
                ...(previous.data['_litiBody'] ? { body: previous.body } : {}),
                order: Number(previous.data['_litiOrder']),
            },
            operation,
            'restore',
        )
    }
    const reorder = async (name: string, ids: readonly string[], operation: ModelOperation & { ifHead: string }) => {
        const model = modelOf(name),
            snapshot = await view('draft')
        if (!snapshot || snapshot.revision.id !== operation.ifHead || new Set(ids).size !== ids.length)
            throw new ModelError('LITI_CONFLICT', 'The ordering snapshot changed.')
        const expected = (await files(snapshot)).filter(
            (file) =>
                file.type === 'file' &&
                file.path.startsWith(`${name}/`) &&
                file.path.endsWith(`/${originalLocale(model)}.${model.format === 'json' ? 'json' : 'md'}`),
        )
        if (
            expected.length !== ids.length ||
            expected.some((file) => !ids.some((id) => file.path === pathsFor(model, id, [originalLocale(model)])[0]))
        )
            throw new ModelError('LITI_INVALID_INPUT', 'Reorder every current entry exactly once.')
        for (const id of ids) {
            await check(model, 'reorder', id, originalLocale(model), operation)
        }
        const receipt = await run(operation, { draft: snapshot.revision.id }, [orderPath(name)], () =>
            commit(
                'draft',
                snapshot.revision.id,
                (operationId) =>
                    workspace().history.commit({
                        ref: 'draft',
                        ifHead: snapshot.revision.id,
                        changes: {
                            put: {
                                [orderPath(name)]: JSON.stringify(
                                    Object.fromEntries(ids.map((id, order) => [id, order])),
                                ),
                            },
                        },
                        metadata: { litiActor: operation.actor.id, litiOperationId: operationId },
                    }),
                (revision) => revision,
            ),
        )
        for (const id of ids)
            receipt.postCommitErrors.push(
                ...(await notifyCommitted(model, {
                    action: 'reorder',
                    id,
                    actor: operation.actor,
                    revision: receipt.result.id,
                })),
            )
        return { revision: receipt.result.id, postCommitErrors: receipt.postCommitErrors }
    }
    return {
        read,
        resolveUrl,
        query,
        readDraft,
        save,
        remove,
        restore,
        publish,
        unpublish,
        schedule,
        cancelSchedule,
        inspect,
        publishDue,
        reorder,
        dispose,
    }
}
