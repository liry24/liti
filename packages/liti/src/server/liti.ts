import { prepareTranslations } from './translations'
import { createManagementOperations } from './operations'
import type { ModelPreparation, ModelPreparationContext } from '../preparation'
import type { ActionResult, OperationContext } from '../plugins'
import type { ComarkContent, ContentFile } from 'comark-content'
import { createMarkdownContent } from '../markdown/content'
import { projectMarkdownListSummary } from '../markdown/list-summary'
import {
    astText,
    cleanText,
    collectMarkdown,
    entryDescription,
    markdownDocument,
    type MarkdownDocumentValue,
} from '../markdown/document'
import { addRoute, createRouter, findRoute, type RouterContext } from 'rou3'
import type { LitiStorage } from '../adapter'
import { PublicProjector, readPublicSnapshot } from './public-content'
import { AssetManager, durationMilliseconds } from './assets'

import type { ModelDefinition, LitiAssetAction, LitiLifecycleEvent, LitiModelAction, LitiSystemAction } from '../config'
import { createLitiDescriptor, type LitiDescriptor } from '../descriptor'
import { literalPresentation, type PresentationContext } from '../presentation'
import { LitiError, type LitiIssue } from '../errors'
import { searchQuery } from '../storage'
import { resolveTranslation, type Translations, type TranslationInput } from '../i18n'
import { createLitiRouteResolver, serializeLitiSeo, mergeLitiSeo, type LitiRouteResolver } from '../seo'
import type { AnyField } from '../fields'
import {
    applyFieldDefaults,
    collectReferences,
    fieldAtPath,
    projectStoredFields,
    validateModelData,
    type IndexedReference,
} from '../validation'
import type {
    StoragePublishedEntry,
    StorageRoute,
    StorageRouteChange,
    StorageRevisionCandidate,
    StorageContentCommit,
    StorageCondition,
    StorageEntryFilter,
} from '../storage'
import { entryPath, modelRouteOptions, routeRedirect } from './routes'
import type {
    EntryInput,
    EntryRecord,
    IncomingReference,
    PublicEntry,
    PublishDueResult,
    PublishEntryInput,
    RevisionRecord,
    LitiDiagnostic,
    LitiInspection,
    LitiOptions,
    UpdateEntryInput,
    UploadAssetInput,
    AssetRecord,
} from './types'

type EntryRow = EntryRecord
type RevisionRow = RevisionRecord
type ReferenceTargetRow = { id: string; model: string; publishedRevisionId: string | null }
type AssetRow = AssetRecord
type PublishedRow = StoragePublishedEntry
type RouteRow = StorageRoute

interface LLMSEntry {
    content?: string
    description?: string
    href: string
    title: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const stableJson = (value: unknown): string =>
    JSON.stringify(value, (_, item: unknown) =>
        isObject(item)
            ? Object.fromEntries(Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)))
            : item,
    )

const safeId = (value: string, label: string): string => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
        throw new LitiError('LITI_INVALID_INPUT', `${label} contains unsupported characters.`)
    }
    return value
}

const mimeMatches = (value: string, accepted: readonly string[]): boolean =>
    accepted.some((entry) => entry === value || (entry.endsWith('/*') && value.startsWith(entry.slice(0, -1))))

export class Liti<Context = unknown> {
    // shortcut: action results survive retries only within this runtime; durable exactly-once inference needs an operation store.
    readonly #publicationActions = new Map<string, Promise<ActionResult>>()
    readonly #assets: AssetManager<Context>
    readonly #storage: LitiStorage
    readonly diagnostics: LitiDiagnostic[] = []
    readonly #options: LitiOptions<Context>
    readonly #descriptor: LitiDescriptor
    readonly #resolveRouteRule: LitiRouteResolver
    readonly #content = new Map<string, { content: ComarkContent; generation: number }>()
    readonly #projection: PublicProjector<Context>
    readonly #parsedContent = new Map<string, { file: ContentFile; generation: number }>()
    readonly #seo = new Map<string, Promise<import('./types').PublicEntrySeo>>()
    readonly #routes = new Map<string, { generation: number; router: RouterContext<RouteRow> }>()
    #initializer: Promise<void> | undefined

    constructor(options: LitiOptions<Context>) {
        if (options.config.assets)
            options = {
                ...options,
                config: {
                    ...options.config,
                    assets: {
                        ...options.config.assets,
                        storage:
                            options.config.assets.storage ??
                            options.config.adapter?.storage?.defaultStorage ??
                            'content',
                    },
                },
            }
        if (typeof options.database?.bind !== 'function')
            throw new LitiError('LITI_DATABASE_UNSUPPORTED', 'Provide a liti storage adapter.')
        this.#storage = options.database.bind(options.config)

        durationMilliseconds(options.config.assets?.cleanup?.minimumAge ?? 60 * 60 * 24)
        durationMilliseconds(options.config.assets?.operationLeaseSeconds ?? 60 * 15)
        if (
            options.config.assets?.separateDrafts === true &&
            (options.config.assets.operationLeaseSeconds ?? 60 * 15) === 0
        )
            throw new LitiError('LITI_INVALID_INPUT', 'separateDrafts requires a positive operationLeaseSeconds.')
        const maxSize = options.config.assets?.maxUploadSize
        if (maxSize !== undefined && (!Number.isSafeInteger(maxSize) || maxSize <= 0))
            throw new LitiError('LITI_INVALID_INPUT', 'maxUploadSize must be a positive safe integer.')
        for (const [name, model] of Object.entries(options.config.models)) {
            if (model.publishing === false && model.scheduling === true)
                throw new LitiError('LITI_INVALID_INPUT', `Model "${name}" cannot schedule without publishing.`)
            if (model.unique !== undefined && !Array.isArray(model.unique))
                throw new LitiError('LITI_INVALID_INPUT', `Model "${name}" unique constraints must be field tuples.`)
            for (const fields of model.unique ?? []) {
                if (
                    !Array.isArray(fields) ||
                    !fields.length ||
                    new Set(fields).size !== fields.length ||
                    fields.some((key) => {
                        const field = model.fields[key]
                        return (
                            !field ||
                            field.i18n ||
                            ![
                                'text',
                                'textarea',
                                'url',
                                'datetime',
                                'select',
                                'number',
                                'boolean',
                                'relation',
                            ].includes(field.kind)
                        )
                    })
                )
                    throw new LitiError(
                        'LITI_INVALID_INPUT',
                        `Model "${name}" unique constraints require distinct, non-translated scalar fields.`,
                    )
            }
        }
        if (Object.hasOwn(options.config.authorization?.roles ?? {}, 'admin'))
            throw new LitiError('LITI_INVALID_INPUT', 'The built-in admin role cannot be overridden.')
        this.#options = options
        this.#projection = new PublicProjector(options)
        this.#assets = new AssetManager(
            options,
            this.#storage,
            () => this.initialize(),
            (ids) => this.#publishedAssetIds(ids),
        )
        this.#resolveRouteRule = createLitiRouteResolver(options.config.routeRules)
        this.#descriptor = createLitiDescriptor(options.config)
    }

    get config(): LitiOptions<Context>['config'] {
        return this.#options.config
    }

    get descriptor(): LitiDescriptor {
        return {
            ...structuredClone(this.#descriptor),
            ...(this.#options.locales?.defaultLocale
                ? {
                      i18n: {
                          defaultLocale: this.#options.locales.defaultLocale,
                          locales: [...(this.#options.locales.supported ?? [])],
                      },
                  }
                : {}),
        }
    }

    presentationContext(locale?: string): Promise<PresentationContext> {
        return this.#options.presentation?.(locale) ?? Promise.resolve({ ...literalPresentation, locale: locale ?? '' })
    }

    #modelSeo(entry: PublicEntry): Promise<import('./types').PublicEntrySeo> {
        const key = JSON.stringify([this.#projection.generation, entry.model, entry.id, entry.revisionId, entry.locale])
        const cached = this.#seo.get(key)
        if (cached) return cached
        const definition = this.#model(entry.model)
        const pending = (async () =>
            serializeLitiSeo(
                typeof definition.seo === 'function'
                    ? definition.seo(structuredClone(entry), await this.presentationContext(entry.locale))
                    : definition.seo,
            ))()
        this.#seo.set(key, pending)
        void pending.catch(() => this.#seo.delete(key))
        if (this.#seo.size > 256) this.#seo.delete(this.#seo.keys().next().value!)
        return pending
    }

    async #presentEntry(entry: PublicEntry): Promise<PublicEntry> {
        return {
            ...entry,
            seo: this.#projection.sanitizeSeo(mergeLitiSeo(entry.seo, await this.#modelSeo(entry))),
        }
    }

    descriptorFor(actor: import('./types').LitiActor, context?: PresentationContext): LitiDescriptor {
        const descriptor = this.descriptor
        if (context) descriptor.models = createLitiDescriptor(this.config, context).models
        descriptor.models = Object.fromEntries(
            Object.entries(descriptor.models).filter(([modelName]) => this.can(actor, 'model', 'readDraft', modelName)),
        )
        if (!this.can(actor, 'asset', 'read')) descriptor.assets = false
        return descriptor
    }

    async authorizeRequest(request: Request, context?: Context): Promise<import('./types').LitiActor> {
        const actor = await this.#options.authorize?.(request, context)
        if (!actor?.id) throw new LitiError('LITI_AUTH_REQUIRED', 'Authentication is required.')
        return actor
    }

    can(
        actor: import('./types').LitiActor,
        kind: 'asset' | 'model' | 'system',
        action: LitiAssetAction | LitiModelAction | LitiSystemAction,
        modelName?: string,
    ): boolean {
        if (actor.roles?.includes('admin')) return true
        for (const role of actor.roles ?? []) {
            const definition = this.config.authorization?.roles[role]
            if (!definition) continue
            if (kind === 'asset' && definition.assets?.includes(action as LitiAssetAction)) return true
            if (kind === 'system' && definition.system?.includes(action as LitiSystemAction)) return true
            if (
                kind === 'model' &&
                modelName &&
                (definition.models?.[modelName]?.includes(action as LitiModelAction) ||
                    definition.models?.['*']?.includes(action as LitiModelAction))
            )
                return true
        }
        return false
    }

    assertPermission(
        actor: import('./types').LitiActor,
        kind: 'asset' | 'model' | 'system',
        action: LitiAssetAction | LitiModelAction | LitiSystemAction,
        modelName?: string,
    ): void {
        if (!this.can(actor, kind, action, modelName)) {
            throw new LitiError('LITI_FORBIDDEN', 'This role is not allowed to perform that operation.')
        }
    }

    initialize(): Promise<void> {
        this.#initializer ??= this.#initialize()
        void this.#initializer.catch(() => {
            this.#initializer = undefined
        })
        return this.#initializer
    }

    async #initialize(): Promise<void> {
        this.#validateConfig()
        await this.#storage.assertSchema()
        const mode = await this.#storage.assetStorageMode()
        const assets = this.config.assets
        if (
            mode &&
            (mode.separate !== (assets?.separateDrafts === true) || (mode.separate && mode.storage !== assets?.storage))
        )
            throw new LitiError(
                'LITI_MIGRATION_REQUIRED',
                'Migrate existing Asset copies before changing the storage mode.',
            )
        if (assets?.separateDrafts === true) {
            await this.#assets.assertStores()
            if (await this.#storage.hasLegacyAssetOriginals())
                throw new LitiError(
                    'LITI_MIGRATION_REQUIRED',
                    'Move existing Asset originals to private draft storage before enabling separateDrafts.',
                )
            await this.#storage.bindAssetStorageMode(assets.storage!)
        }

        await this.#reconcileRoutes()
        if (assets?.separateDrafts === true) {
            const sync = await this.#assets.sync()
            if (sync.failed.length)
                this.diagnostics.push({
                    code: 'LITI_ASSET_SYNC_FAILED',
                    message: 'Asset copies need retry through publishDue or Asset GC.',
                })
        }
    }

    #validateConfig(): void {
        for (const [modelName, definition] of Object.entries(this.config.models)) {
            safeId(modelName, 'Model name')
            if (Object.hasOwn(definition.fields, '_liti')) {
                throw new LitiError('LITI_INVALID_INPUT', '"_liti" is reserved for public metadata.')
            }
            for (const [fieldName, field] of Object.entries(definition.fields)) {
                safeId(fieldName, `Field name in model "${modelName}"`)
                this.#validateFieldConfig(field)
                if (field.i18n && !this.#options.locales?.supported?.length)
                    throw new LitiError('LITI_INVALID_INPUT', 'Enable i18n before using translated fields.')
            }
            const route = modelRouteOptions(definition)
            if (route?.redirect) {
                const field = definition.fields[route.redirect]
                if (field?.kind !== 'url') {
                    throw new LitiError(
                        'LITI_INVALID_INPUT',
                        `Redirect field "${route.redirect}" in model "${modelName}" must be a URL field.`,
                    )
                }
            }
            if (definition.route) {
                const pattern = route?.path ?? `/${modelName}/:id`
                const data: Record<string, unknown> = {}
                for (const [, key] of pattern.matchAll(/:([A-Za-z0-9_-]+)/gu)) {
                    if (key === 'id') continue
                    if (!Object.hasOwn(definition.fields, key!))
                        throw new LitiError('LITI_INVALID_INPUT', `Unknown route field "${key}".`)
                    data[key!] = 'config-check'
                }
                entryPath(modelName, definition, { id: 'config-check', data }, this.#apiBases())
            }
        }
    }

    #validateFieldConfig(field: AnyField, nested = false): void {
        if (nested && field.i18n) throw new LitiError('LITI_INVALID_INPUT', 'Only top-level fields can be translated.')
        if (field.kind === 'relation' && !Object.hasOwn(this.config.models, field.model)) {
            throw new LitiError('LITI_INVALID_INPUT', `Relation target model "${field.model}" does not exist.`)
        }
        if (field.kind === 'object') {
            for (const [name, child] of Object.entries(field.fields)) {
                safeId(name, 'Nested field name')
                this.#validateFieldConfig(child, true)
            }
        }
        if (field.kind === 'array') this.#validateFieldConfig(field.item, true)
    }

    #model(name: string): ModelDefinition {
        const definition = this.config.models[name]
        if (!definition) throw new LitiError('LITI_MODEL_NOT_FOUND', `Unknown model "${name}".`)
        return definition
    }

    #publicModel(name: string): ModelDefinition | undefined {
        const definition = this.config.models[name]
        return definition?.public === false ? undefined : definition
    }

    #locale(definition: ModelDefinition, locale?: string): string {
        if (!this.#options.locales?.supported?.length) {
            if (locale) throw new LitiError('LITI_INVALID_INPUT', 'i18n is disabled.')
            return ''
        }
        const normalized = locale || this.#options.locales?.defaultLocale
        if (!normalized) {
            throw new LitiError('LITI_INVALID_INPUT', 'A locale is required for localized content.')
        }
        if (this.#options.locales?.supported && !this.#options.locales.supported.includes(normalized)) {
            throw new LitiError('LITI_INVALID_INPUT', `Unsupported locale "${normalized}".`)
        }
        return normalized
    }

    #readLocale(definition: ModelDefinition, locale?: string): string | undefined {
        return locale === undefined ? undefined : this.#locale(definition, locale)
    }

    #localizedPath(definition: ModelDefinition, path: string, locale: string): string {
        return this.#options.locales?.localizePath ? this.#options.locales.localizePath(path, locale) : path
    }

    #entryRow(id: string): Promise<EntryRecord | undefined> {
        return this.#storage.readEntry(id)
    }

    async #requiredEntry(id: string, loaded?: EntryRecord): Promise<EntryRow> {
        if (loaded) {
            if (loaded.id !== id)
                throw new LitiError('LITI_INVALID_INPUT', 'The loaded entry does not match the requested ID.')
            return loaded
        }
        const row = await this.#entryRow(id)
        if (!row) throw new LitiError('LITI_ENTRY_NOT_FOUND', `Entry "${id}" does not exist.`)
        return row
    }

    async getEntry(id: string, locale?: string): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(id)
        if (locale) this.#locale(this.#model(entry.model), locale)
        return resolveTranslation(entry, locale)
    }

    async listEntries(modelName?: string): Promise<EntryRecord[]> {
        await this.initialize()
        if (modelName) this.#model(modelName)
        return this.#storage.entries(modelName ? { models: [modelName] } : {})
    }

    async pageEntries(
        filter: StorageEntryFilter,
        page: { limit: number; offset: number },
    ): Promise<{ items: EntryRecord[]; total: number }> {
        searchQuery(filter.q)
        await this.initialize()
        for (const model of filter.models ?? []) this.#model(model)
        const result = await this.#storage.pageEntries(filter, page)
        return { ...result, items: result.items.map((entry) => resolveTranslation(entry, filter.locale)) }
    }

    async listRevisions(entryId: string, loaded?: EntryRecord): Promise<RevisionRecord[]> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId, loaded)
        this.#assertFeature(entry.model, 'revisions')
        return this.#storage.revisions(entryId)
    }

    async referencesTo(
        entryId: string,
        options: { field?: string; from?: string; view: 'current' | 'published' },
        loaded?: EntryRecord,
    ): Promise<IncomingReference[]> {
        await this.initialize()
        await this.#requiredEntry(entryId, loaded)
        if (options.from) this.#model(options.from)
        if (options.view !== 'current' && options.view !== 'published')
            throw new LitiError('LITI_INVALID_INPUT', 'view must be current or published.')
        return this.#storage.incomingReferences(entryId, options)
    }

    async restoreRevision(
        entryId: string,
        revisionId: string,
        input: { actorId?: string; expectedVersion: number },
        loaded?: EntryRecord,
        context: OperationContext = {},
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId, loaded)
        this.#assertFeature(entry.model, 'revisions')
        const revision = await this.#revision(revisionId, entryId)
        return this.#updateEntry(
            entry,
            {
                ...input,
                data: projectStoredFields(this.#model(entry.model).fields, revision.data),
                translations: {
                    ...Object.fromEntries(Object.keys(entry.translations).map((locale) => [locale, null])),
                    ...revision.translations,
                },
            },
            'restore',
            context,
        )
    }

    async pruneRevisions(entryId: string, retain: number, loaded?: EntryRecord): Promise<{ deleted: string[] }> {
        await this.initialize()
        await this.#requiredEntry(entryId, loaded)
        if (!Number.isInteger(retain) || retain < 0) {
            throw new LitiError('LITI_INVALID_INPUT', '"retain" must be a non-negative integer.')
        }
        this.#assertFeature((await this.#requiredEntry(entryId, loaded)).model, 'revisions')
        const candidates = (await this.#storage.revisionIds(entryId)).slice(retain)
        return { deleted: await this.#storage.pruneRevisions(entryId, candidates) }
    }

    async #revision(id: string, entryId?: string): Promise<RevisionRecord> {
        const row = await this.#storage.readRevision(id, entryId)
        if (!row) throw new LitiError('LITI_ENTRY_NOT_FOUND', `Revision "${id}" does not exist.`)
        return row
    }

    async #prepareData(
        definition: ModelDefinition,
        value: Record<string, unknown>,
        defaults: boolean,
        preparation?: Omit<ModelPreparationContext, 'data' | 'issues' | 'read' | 'executeAction'>,
    ): Promise<{ assets: IndexedReference[]; data: Record<string, unknown>; relations: IndexedReference[] }> {
        let data = defaults ? applyFieldDefaults(definition.fields, value) : structuredClone(value)
        if (preparation && (definition.prepare || definition.preparePublication)) {
            const { validate: _validate, ...structureDefinition } = definition
            const structure = await validateModelData(structureDefinition, data)
            if (!structure.data) throw new LitiError('LITI_INVALID_INPUT', 'Model validation failed.', structure.issues)
            data = structure.data
            await this.#runPreparation(definition.prepare, data, preparation)
            if (
                definition.preparePublication &&
                (preparation.operation === 'publish' || preparation.operation === 'schedule')
            ) {
                const key = stableJson([
                    preparation.model,
                    preparation.entryId,
                    preparation.previous?.version,
                    preparation.operation,
                    preparation.locale,
                    preparation.actor,
                    data,
                ])
                await this.#runPreparation(definition.preparePublication, data, preparation, false, key)
            }
        }
        const validated = await validateModelData(definition, data)
        if (!validated.data) {
            throw new LitiError('LITI_INVALID_INPUT', 'Model validation failed.', validated.issues)
        }
        const references = collectReferences(definition.fields, validated.data)
        await this.#assertReferences(definition, references)
        return { data: validated.data, ...references }
    }

    async #runPreparation(
        hook: ModelPreparation | undefined,
        data: Record<string, unknown>,
        context: Omit<ModelPreparationContext, 'data' | 'issues' | 'read' | 'executeAction'>,
        immutable = false,
        actionCacheKey?: string,
    ) {
        if (!hook) return
        context.signal?.throwIfAborted()
        const operations = createManagementOperations<Context, Record<string, Record<string, unknown>>>(
            () => this,
            context,
        )
        const issues: LitiIssue[] = []
        const candidate = immutable ? structuredClone(data) : data
        await hook({
            ...context,
            ...(context.previous ? { previous: structuredClone(context.previous) } : {}),
            data: candidate,
            issues,
            read: {
                current: {
                    getEntry: operations.getEntry,
                    listEntries: operations.listEntries,
                    listAllEntries: operations.listAllEntries,
                    referencesTo: operations.referencesTo,
                },
                published: {
                    get: (model, id, locale) => this.getPublicEntry(model, id, locale),
                    list: (model, locale) => this.listPublicEntries(model, locale),
                    routeAvailable: async (value) => {
                        const definition = this.#model(context.model)
                        if (
                            definition.public === false ||
                            this.#options.routing?.enabled === false ||
                            (routeRedirect(definition, value) && this.#options.routing?.redirects === false)
                        )
                            return true
                        const path = entryPath(
                            context.model,
                            definition,
                            { id: context.entryId, data: value },
                            this.#apiBases(),
                        )
                        if (path === null) return true
                        const routes = await this.#storage.routes({
                            path: this.#localizedPath(definition, path, context.locale),
                        })
                        return routes.every((route) => route.entryId === context.entryId)
                    },
                },
            },
            executeAction: async (name, input) => {
                if (actionCacheKey === undefined) return operations.executeAction(name, input)
                const key = stableJson([actionCacheKey, name, input])
                let pending = this.#publicationActions.get(key)
                if (!pending) {
                    pending = operations.executeAction(name, input)
                    this.#publicationActions.set(key, pending)
                    void pending.catch(() => {
                        if (this.#publicationActions.get(key) === pending) this.#publicationActions.delete(key)
                    })
                    if (this.#publicationActions.size > 32)
                        this.#publicationActions.delete(this.#publicationActions.keys().next().value!)
                }
                return structuredClone(await pending)
            },
        })
        context.signal?.throwIfAborted()
        if (issues.length) throw new LitiError('LITI_INVALID_INPUT', 'Model preparation failed.', issues)
        if (immutable && stableJson(candidate) !== stableJson(data))
            throw new LitiError(
                'LITI_SCHEMA_MIGRATION_REQUIRED',
                'Publication validation cannot change stored values; save a new revision.',
            )
    }

    async #prepareSnapshot(
        definition: ModelDefinition,
        data: Record<string, unknown>,
        defaultLocale: string,
        input: TranslationInput = {},
        previous: Translations = {},
        defaults = false,
        preparation?: Omit<
            ModelPreparationContext,
            'data' | 'issues' | 'read' | 'executeAction' | 'locale' | 'defaultLocale'
        >,
    ) {
        const prepare = preparation
            ? (value: Record<string, unknown>, locale: string, withDefaults = false) =>
                  this.#prepareData(definition, value, withDefaults, { ...preparation, locale, defaultLocale })
            : undefined
        const original = prepare
            ? await prepare(data, defaultLocale, defaults)
            : await this.#prepareData(definition, data, defaults)
        const translations = await prepareTranslations(
            definition,
            original.data,
            defaultLocale,
            this.#options.locales?.supported ?? [],
            input,
            previous,
            prepare && (async (value, locale) => (await prepare(value, locale)).data),
        )
        const assets = original.assets.map((ref) => ({ ...ref, locale: defaultLocale }))
        const relations = original.relations.map((ref) => ({ ...ref, locale: defaultLocale }))
        for (const [locale, override] of Object.entries(translations)) {
            const prepared = collectReferences(definition.fields, { ...original.data, ...override })
            await this.#assertReferences(definition, prepared)
            assets.push(...prepared.assets.map((ref) => ({ ...ref, locale })))
            relations.push(...prepared.relations.map((ref) => ({ ...ref, locale })))
        }
        return { data: original.data, translations, assets, relations }
    }

    async #prepareRevision(definition: ModelDefinition, revision: RevisionRow, defaultLocale: string) {
        const stored = projectStoredFields(definition.fields, revision.data)
        const prepared = await this.#prepareSnapshot(definition, stored, defaultLocale, revision.translations)
        if (
            stableJson(prepared.data) !== stableJson(stored) ||
            stableJson(prepared.translations) !== stableJson(revision.translations)
        ) {
            throw new LitiError(
                'LITI_SCHEMA_MIGRATION_REQUIRED',
                'Validation transforms changed this revision; save the transformed data before publishing.',
            )
        }
        return prepared
    }

    async #assertReferences(
        definition: ModelDefinition,
        references: { assets: IndexedReference[]; relations: IndexedReference[] },
    ): Promise<void> {
        const issues: LitiIssue[] = []
        const relationIds = [...new Set(references.relations.map((reference) => reference.id))]
        const relationTargets = new Map<string, ReferenceTargetRow>()
        if (relationIds.length > 0) {
            const rows = await this.#storage.referenceTargets(relationIds)

            for (const row of rows) relationTargets.set(row.id, row)
        }
        for (const reference of references.relations) {
            const target = relationTargets.get(reference.id)
            const field = fieldAtPath(definition.fields, reference.path)
            if (!target) issues.push({ message: `Entry "${reference.id}" does not exist.`, path: reference.path })
            else if (field?.kind === 'relation' && target.model !== field.model) {
                issues.push({ message: `Expected a ${field.model} entry.`, path: reference.path })
            }
        }

        const assetIds = [...new Set(references.assets.map((reference) => reference.id))]
        const assets = new Map<string, AssetRow>()
        if (assetIds.length > 0) {
            const rows = await this.#storage.assets({ ids: assetIds })

            for (const row of rows) assets.set(row.id, row)
        }
        for (const reference of references.assets) {
            const asset = assets.get(reference.id)
            const field = fieldAtPath(definition.fields, reference.path)
            if (!asset || asset.state !== 'ready') {
                issues.push({ message: `Asset "${reference.id}" is not ready.`, path: reference.path })
            } else if (field && 'accept' in field && field.accept && !mimeMatches(asset.contentType, field.accept)) {
                issues.push({
                    message: `Asset type "${asset.contentType}" is not accepted.`,
                    path: reference.path,
                })
            }
        }
        if (issues.length > 0) {
            const assetFailure = issues.some((entry) => entry.message.startsWith('Asset'))
            throw new LitiError(
                assetFailure ? 'LITI_ASSET_NOT_READY' : 'LITI_INVALID_INPUT',
                'Referenced records are invalid.',
                issues,
            )
        }
    }

    #guard(entryId: string, expectedVersion: number): StorageCondition {
        return { kind: 'entryVersion', id: entryId, version: expectedVersion }
    }

    #referenceGuard(
        definition: ModelDefinition,
        references: { assets: IndexedReference[]; relations: IndexedReference[] },
        publishing: boolean,
    ): StorageCondition[] {
        const targets = new Map<string, { id: string; model: string; published: boolean }>()
        for (const reference of references.relations) {
            const field = fieldAtPath(definition.fields, reference.path)
            if (field?.kind === 'relation') {
                const key = `${reference.id}\0${field.model}`
                targets.set(key, {
                    id: reference.id,
                    model: field.model,
                    published: targets.get(key)?.published === true || (publishing && field.required === true),
                })
            }
        }
        return [
            { kind: 'assetsReady', ids: references.assets.map(({ id }) => id) },
            { kind: 'relations', targets: [...targets.values()] },
        ]
    }

    #revisionCandidate(input: {
        actorId?: string
        translations?: Translations
        assets: IndexedReference[]
        data: Record<string, unknown>
        entryId: string
        model: string
        revisionId: string

        time: string
        relations: IndexedReference[]
    }): StorageRevisionCandidate {
        return {
            id: input.revisionId,
            entryId: input.entryId,
            actorId: input.actorId ?? null,
            createdAt: input.time,
            data: input.data,
            translations: input.translations ?? {},
            model: input.model,
            assets: input.assets,
            relations: input.relations.map((reference) => {
                const field = fieldAtPath(this.#model(input.model).fields, reference.path)
                return { ...reference, required: field?.kind === 'relation' && field.required === true }
            }),
        }
    }

    async #currentRoute(entryId: string, locale: string): Promise<RouteRow | undefined> {
        return (await this.#storage.routes({ entryId, kinds: ['page', 'redirect'], locales: [locale] }))[0]
    }

    async #routeChanges(input: {
        data: Record<string, unknown>
        translations?: Translations
        definition: ModelDefinition
        entryId: string
        modelName: string
        locale: string
        revisionId: string
        time: string
    }): Promise<StorageRouteChange[]> {
        const translations = input.translations ?? {}
        const locales = [input.locale, ...Object.keys(translations)]
        const changes: StorageRouteChange[] = []
        const previous = await this.#storage.routes({ entryId: input.entryId, kinds: ['page', 'redirect'] })
        for (const route of previous)
            if (!locales.includes(route.locale))
                changes.push({ kind: 'remove', entryId: input.entryId, locale: route.locale })
        for (const locale of locales)
            changes.push(
                ...(await this.#localeRouteChanges({
                    ...input,
                    locale,
                    data: { ...input.data, ...translations[locale] },
                })),
            )
        return changes
    }

    async #localeRouteChanges(input: {
        data: Record<string, unknown>
        definition: ModelDefinition
        entryId: string
        modelName: string
        locale: string
        revisionId: string

        time: string
    }): Promise<StorageRouteChange[]> {
        const redirect = routeRedirect(input.definition, input.data)
        const current = await this.#currentRoute(input.entryId, input.locale)
        const basePath =
            this.#options.routing?.enabled === false ||
            (redirect && this.#options.routing?.redirects === false) ||
            input.definition.public === false
                ? null
                : entryPath(
                      input.modelName,
                      input.definition,
                      { id: input.entryId, data: input.data },
                      this.#apiBases(),
                  )
        const path = basePath === null ? null : this.#localizedPath(input.definition, basePath, input.locale)
        const status = this.config.modelDefaults?.historicalRedirectStatus ?? 301
        const changes: StorageRouteChange[] = [
            { kind: 'retargetHistory', entryId: input.entryId, path, status, locale: input.locale },
            { kind: 'remove', entryId: input.entryId, kinds: ['page', 'redirect'], locale: input.locale },
        ]
        if (!path) return changes
        changes.push({ kind: 'remove', entryId: input.entryId, path })
        if (current && current.path !== path && this.#options.routing?.preserveHistory !== false)
            changes.push({
                kind: 'put',
                route: {
                    path: current.path,
                    locale: current.locale,
                    entryId: input.entryId,
                    revisionId: null,
                    kind: 'historical',
                    targetPath: path,
                    status,
                    createdAt: input.time,
                },
            })
        changes.push({
            kind: 'put',
            route: {
                path,
                locale: input.locale,
                entryId: input.entryId,
                revisionId: input.revisionId,
                kind: redirect ? 'redirect' : 'page',
                targetPath: redirect?.target ?? null,
                status: redirect?.status ?? null,
                createdAt: input.time,
            },
        })
        return changes
    }

    async #reconcileRoutes(): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            const generation = await this.#storage.publicGeneration()
            const routes = await this.#storage.routes()
            const rows = await this.#publishedRows()
            const graph = await this.#publicSnapshot(rows)
            const routesByEntry = new Map<string, RouteRow[]>()
            for (const route of routes) {
                const list = routesByEntry.get(route.entryId) ?? []
                list.push(route)
                routesByEntry.set(route.entryId, list)
            }
            const statements: StorageRouteChange[] = []
            for (const entryId of routesByEntry.keys()) {
                const row = graph.get(entryId)
                const definition = row && this.#publicModel(row.model)
                if (!row || !definition?.route || this.#options.routing?.enabled === false) {
                    statements.push({ kind: 'remove', entryId })
                    routesByEntry.delete(entryId)
                }
            }
            const time = this.#now()
            for (const row of rows) {
                if (!graph.has(row.id)) continue
                const definition = this.#publicModel(row.model)
                if (!definition?.route || this.#options.routing?.enabled === false) continue
                const data = row.data
                const redirect = routeRedirect(definition, data)
                if (redirect && this.#options.routing?.redirects === false) {
                    if (routesByEntry.has(row.id)) {
                        statements.push({ kind: 'remove', entryId: row.id })
                    }
                    continue
                }
                const basePath = entryPath(row.model, definition, row, this.#apiBases())
                if (!basePath) continue
                const path = this.#localizedPath(definition, basePath, row.locale)
                const current = routesByEntry
                    .get(row.id)
                    ?.find((route) => route.kind === 'page' || route.kind === 'redirect')
                if (
                    current?.path === path &&
                    current.locale === row.locale &&
                    current.revisionId === row.revisionId &&
                    current.kind === (redirect ? 'redirect' : 'page') &&
                    current.targetPath === (redirect?.target ?? null) &&
                    current.status === (redirect?.status ?? null)
                )
                    continue
                statements.push(
                    ...(await this.#routeChanges({
                        data,
                        translations: row.translations,
                        definition,
                        entryId: row.id,
                        locale: row.locale,
                        modelName: row.model,
                        revisionId: row.revisionId,

                        time,
                    })),
                )
            }
            if (statements.length === 0) return
            try {
                await this.#commit({
                    conditions: [{ kind: 'publicGeneration', generation }],
                    routes: statements,
                    publicGeneration: true,
                })
                return
            } catch (error) {
                if (!(error instanceof LitiError) || error.code !== 'LITI_CONFLICT' || attempt >= 2) throw error
            }
        }
    }

    async #commit(input: StorageContentCommit, context: OperationContext = {}): Promise<void> {
        const guard = () => {
            context.signal?.throwIfAborted()
            context.request?.signal.throwIfAborted()
            if (context.deadline !== undefined && context.deadline <= Date.now())
                throw new DOMException('The operation deadline has elapsed.', 'TimeoutError')
        }
        guard()
        const unique: StorageCondition[] = []
        for (const revision of input.revisions ?? []) {
            const current =
                input.create?.currentRevisionId === revision.id ||
                input.updates?.some(
                    (update) => update.id === revision.entryId && update.patch.currentRevisionId === revision.id,
                )
            if (!current) continue
            for (const fields of this.#model(revision.model).unique ?? []) {
                if (fields.some((field) => revision.data[field] == null)) continue
                const values: Record<string, string | number | boolean> = {}
                for (const field of fields) {
                    const value = revision.data[field]
                    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
                        throw new LitiError('LITI_INVALID_INPUT', `Unique field "${field}" must be scalar.`)
                    values[field] = value
                }
                unique.push({ kind: 'uniqueValues', model: revision.model, entryId: revision.entryId, values })
            }
        }
        if (unique.length) input = { ...input, conditions: [...(input.conditions ?? []), ...unique] }
        if (input.prune !== undefined || !Object.values(this.config.models).some((model) => model.revisions === false))
            return this.#storage.commit(input)
        const ids = new Set([
            ...(input.revisions ?? []).map((value) => value.entryId),
            ...(input.updates ?? []).map((value) => value.id),
        ])
        const prune: string[] = []
        for (const id of ids) {
            const model =
                input.revisions?.find((value) => value.entryId === id)?.model ??
                (await this.#storage.readEntry(id))?.model
            if (model && this.#model(model).revisions === false) prune.push(id)
        }
        guard()
        await this.#storage.commit({ ...input, ...(prune.length ? { prune } : {}) })
    }

    async #afterCommit(event: LitiLifecycleEvent, publicGraphChanged = false): Promise<void> {
        let failed = false
        if (publicGraphChanged) {
            try {
                failed = (await this.#assets.sync()).failed.length > 0
            } catch {
                failed = true
            }
        }
        if (this.#options.afterCommit) {
            try {
                await this.#options.afterCommit(event)
            } catch (error) {
                this.diagnostics.push({
                    code: 'LITI_HOOK_FAILED',
                    message: error instanceof Error ? error.message : 'A post-commit hook failed.',
                })
            }
        }
        if (failed) {
            const error = new LitiError(
                'LITI_STORAGE_UNAVAILABLE',
                'The entry was saved; retry Asset synchronization only.',
            )
            error.committed = true
            error.receipt = {
                id: event.entryId,
                model: event.model,
                version: event.version!,
                ...(event.type === 'delete' ? { deleted: true } : {}),
            }
            error.effects = { assets: 'pending' }
            throw error
        }
    }

    async createEntry(modelName: string, input: EntryInput, context: OperationContext = {}): Promise<EntryRecord> {
        await this.initialize()
        const definition = this.#model(modelName)
        const locale = this.#locale(definition, input.defaultLocale)
        const id = safeId(input.id ?? this.#id(), 'Entry ID')
        const prepared = await this.#prepareSnapshot(definition, input.data, locale, input.translations, {}, true, {
            ...context,
            model: modelName,
            entryId: id,
            operation: 'create',
        })
        const revisionId = this.#id()
        const time = this.#now()
        const published = definition.publishing === false
        const publicGraphChanged = published && definition.public !== false
        if (published) await this.#assertPublishableRelations(definition, prepared.relations, id)
        await this.#commit(
            {
                conditions: this.#referenceGuard(definition, prepared, published),
                create: {
                    id,
                    model: modelName,
                    defaultLocale: locale,
                    sortOrder: input.sortOrder ?? null,
                    version: 1,
                    createdAt: time,
                    updatedAt: time,
                    publishedAt: published ? time : null,
                    firstPublishedAt: published ? time : null,
                    currentRevisionId: revisionId,
                    publishedRevisionId: published ? revisionId : null,
                    scheduledRevisionId: null,
                    scheduledAt: null,
                },
                revisions: [
                    this.#revisionCandidate({
                        ...(input.actorId ? { actorId: input.actorId } : {}),
                        ...prepared,
                        entryId: id,
                        model: modelName,
                        revisionId,

                        time,
                    }),
                ],
                routes: published
                    ? await this.#routeChanges({
                          data: prepared.data,
                          translations: prepared.translations,
                          definition,
                          entryId: id,
                          modelName,
                          locale,
                          revisionId,

                          time,
                      })
                    : [],
                publicGeneration: publicGraphChanged,
            },
            context,
        )
        await this.#afterCommit(
            {
                ...(input.actorId ? { actorId: input.actorId } : {}),
                entryId: id,
                model: modelName,
                revisionId,
                type: 'create',
                data: prepared.data,
                version: 1,
            },
            publicGraphChanged,
        )
        return this.getEntry(id)
    }

    async updateEntry(
        entryId: string,
        input: UpdateEntryInput,
        loaded?: EntryRecord,
        context: OperationContext = {},
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId, loaded)
        return this.#updateEntry(entry, input, 'update', context)
    }

    async #updateEntry(
        entry: EntryRecord,
        input: UpdateEntryInput,
        type: 'update' | 'restore',
        context: OperationContext,
    ): Promise<EntryRecord> {
        const entryId = entry.id
        const definition = this.#model(entry.model)
        if (entry.version !== input.expectedVersion)
            throw new LitiError('LITI_CONFLICT', 'The entry version changed; reload before saving.')
        const prepared = await this.#prepareSnapshot(
            definition,
            { ...projectStoredFields(definition.fields, entry.data), ...input.data },
            entry.defaultLocale,
            input.translations,
            entry.translations,
            false,
            { ...context, model: entry.model, entryId, previous: entry, operation: type },
        )
        const revisionId = this.#id(),
            time = this.#now(),
            published = definition.publishing === false
        const publicGraphChanged = published && definition.public !== false
        if (published) await this.#assertPublishableRelations(definition, prepared.relations, entryId)
        await this.#commit(
            {
                conditions: [
                    this.#guard(entryId, input.expectedVersion),
                    ...this.#referenceGuard(definition, prepared, published),
                ],
                revisions: [
                    this.#revisionCandidate({
                        ...(input.actorId ? { actorId: input.actorId } : {}),
                        ...prepared,
                        entryId,
                        model: entry.model,
                        revisionId,

                        time,
                    }),
                ],
                routes: published
                    ? await this.#routeChanges({
                          data: prepared.data,
                          translations: prepared.translations,
                          definition,
                          entryId,
                          modelName: entry.model,
                          locale: entry.defaultLocale,
                          revisionId,

                          time,
                      })
                    : [],
                updates: [
                    {
                        id: entryId,
                        patch: {
                            currentRevisionId: revisionId,
                            updatedAt: time,
                            ...(published
                                ? {
                                      publishedRevisionId: revisionId,
                                      publishedAt: time,
                                      firstPublishedAt: entry.firstPublishedAt ?? time,
                                  }
                                : {}),
                        },
                    },
                ],
                publicGeneration: publicGraphChanged,
            },
            context,
        )
        await this.#afterCommit(
            {
                ...(input.actorId ? { actorId: input.actorId } : {}),
                entryId,
                model: entry.model,
                revisionId,
                type,
                data: prepared.data,
                version: input.expectedVersion + 1,
            },
            publicGraphChanged,
        )
        return this.getEntry(entryId)
    }

    async #assertPublishableRelations(
        definition: ModelDefinition,
        references: IndexedReference[],
        entryId: string,
    ): Promise<void> {
        const required = references.filter((reference) => {
            const field = fieldAtPath(definition.fields, reference.path)
            return field?.kind === 'relation' && field.required
        })
        if (references.length === 0) return
        const ids = [...new Set(references.map((reference) => reference.id))]
        const rows = await this.#publishedRows(undefined, ids)
        const graph = await this.#publicSnapshot(rows)
        const published = new Set(graph.keys())
        const issues = required
            .filter((reference) => !published.has(reference.id))
            .map((reference) => ({
                message: `Required relation "${reference.id}" is not published.`,
                path: reference.path,
            }))
        if (issues.length > 0) {
            throw new LitiError('LITI_RELATION_BLOCKED', 'Required relations must be published first.', issues)
        }
        const budget = { nodes: 1 }
        for (const reference of references) {
            const target = graph.get(reference.id)
            if (target) this.#projection.project(target, graph, new Set([entryId]), budget)
        }
    }

    async #publicationCandidate(
        entry: EntryRecord,
        input: PublishEntryInput,
        publishing: boolean,
        context: OperationContext = {},
    ) {
        const definition = this.#model(entry.model)
        if (entry.version !== input.expectedVersion)
            throw new LitiError('LITI_CONFLICT', 'The entry version changed; reload before publishing.')
        const preparation = {
            ...context,
            model: entry.model,
            entryId: entry.id,
            previous: entry,
            operation: publishing ? ('publish' as const) : ('schedule' as const),
        }
        if (input.draft !== undefined && input.revisionId !== undefined)
            throw new LitiError('LITI_INVALID_INPUT', 'draft and revisionId are mutually exclusive.')
        if (
            input.draft !== undefined &&
            (!isObject(input.draft) ||
                (input.draft.data !== undefined && !isObject(input.draft.data)) ||
                (!Object.hasOwn(input.draft, 'data') && !Object.hasOwn(input.draft, 'translations')))
        )
            throw new LitiError('LITI_INVALID_INPUT', 'Publish draft must contain data.')
        const revision = input.draft
            ? undefined
            : await this.#revision(input.revisionId ?? entry.currentRevisionId, entry.id)
        const prepared = input.draft
            ? await this.#prepareSnapshot(
                  definition,
                  { ...projectStoredFields(definition.fields, entry.data), ...input.draft.data },
                  entry.defaultLocale,
                  input.draft.translations,
                  entry.translations,
                  false,
                  preparation,
              )
            : await this.#prepareRevision(definition, revision!, entry.defaultLocale)
        for (const locale of [entry.defaultLocale, ...Object.keys(prepared.translations)])
            await this.#runPreparation(
                definition.validatePublication,
                { ...prepared.data, ...prepared.translations[locale] },
                { ...preparation, locale, defaultLocale: entry.defaultLocale },
                true,
            )
        const revisionId = revision?.id ?? this.#id()
        if (publishing) await this.#assertPublishableRelations(definition, prepared!.relations, entry.id)
        const time = this.#now()
        return {
            definition,
            prepared,
            revisionId,

            time,
            conditions: [
                this.#guard(entry.id, input.expectedVersion),
                ...(prepared ? this.#referenceGuard(definition, prepared, publishing) : []),
            ],
            revisions:
                input.draft && prepared
                    ? [
                          this.#revisionCandidate({
                              ...(input.actorId ? { actorId: input.actorId } : {}),
                              ...prepared,
                              entryId: entry.id,
                              model: entry.model,
                              revisionId,

                              time,
                          }),
                      ]
                    : [],
        }
    }

    async publishEntry(
        entryId: string,
        input: PublishEntryInput,
        loaded?: EntryRecord,
        context: OperationContext = {},
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId, loaded)
        this.#assertFeature(entry.model, 'publishing')
        return this.#publishEntry(entry, input, true, context)
    }

    async #publishEntry(
        entry: EntryRecord,
        input: PublishEntryInput,
        synchronize: boolean,
        context: OperationContext = {},
    ): Promise<EntryRecord> {
        await this.initialize()
        const entryId = entry.id
        const candidate = await this.#publicationCandidate(entry, input, true, context)
        const { definition, prepared, revisionId, time, conditions, revisions } = candidate
        await this.#commit(
            {
                conditions,
                revisions,
                routes: await this.#routeChanges({
                    data: prepared!.data,
                    translations: prepared!.translations,
                    definition,
                    entryId,
                    modelName: entry.model,
                    locale: entry.locale,
                    revisionId,

                    time,
                }),
                publicGeneration: definition.public !== false,
                updates: [
                    {
                        id: entryId,
                        patch: {
                            ...(input.draft ? { currentRevisionId: revisionId, updatedAt: time } : {}),
                            publishedRevisionId: revisionId,
                            publishedAt: time,
                            firstPublishedAt: entry.firstPublishedAt ?? time,
                            scheduledRevisionId: null,
                            scheduledAt: null,
                        },
                    },
                ],
            },
            context,
        )
        await this.#afterCommit(
            {
                ...(input.actorId ? { actorId: input.actorId } : {}),
                entryId,
                model: entry.model,
                revisionId,
                type: 'publish',
                data: prepared!.data,
                version: input.expectedVersion + 1,
            },
            synchronize && definition.public !== false,
        )
        return this.getEntry(entryId)
    }

    async #assertCanUnpublish(entryId: string): Promise<void> {
        const incoming = await this.#storage.incomingReferences(entryId, {
            view: 'published',
            required: true,
            excludeSelf: true,
        })

        const blocking = incoming.filter((reference) => this.#publicModel(reference.model))
        if (blocking.length > 0) {
            throw new LitiError(
                'LITI_RELATION_BLOCKED',
                'Published entries contain required relations to this entry.',
                blocking.map((reference) => ({
                    message: 'Required published relation would be broken.',
                    path: reference.field,
                })),
            )
        }
    }

    #unpublishGuard(entryId: string): StorageCondition {
        return {
            kind: 'noRequiredPublicReferences',
            id: entryId,
            models: Object.entries(this.config.models)
                .filter(([, definition]) => definition.public !== false)
                .map(([name]) => name),
        }
    }

    async unpublishEntry(
        entryId: string,
        input: { actorId?: string; expectedVersion: number },
        loaded?: EntryRecord,
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId, loaded)
        this.#assertFeature(entry.model, 'publishing')
        await this.#assertCanUnpublish(entryId)
        const publicGraphChanged = Boolean(this.#publicModel(entry.model) && entry.publishedRevisionId)
        await this.#commit({
            conditions: [this.#guard(entryId, input.expectedVersion), this.#unpublishGuard(entryId)],
            routes: [{ kind: 'remove', entryId }],
            publicGeneration: publicGraphChanged,
            updates: [
                {
                    id: entryId,
                    patch: {
                        publishedRevisionId: null,
                        scheduledRevisionId: null,
                        scheduledAt: null,
                        publishedAt: null,
                    },
                },
            ],
        })
        await this.#afterCommit(
            {
                ...(input.actorId ? { actorId: input.actorId } : {}),
                entryId,
                model: entry.model,
                version: input.expectedVersion + 1,
                type: 'unpublish',
                data: entry.data,
            },
            publicGraphChanged,
        )
        return this.getEntry(entryId)
    }

    async schedulePublish(
        entryId: string,
        input: PublishEntryInput & { at: Date | string },
        loaded?: EntryRecord,
        context: OperationContext = {},
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId, loaded)
        this.#assertFeature(entry.model, 'scheduling')
        const at = input.at instanceof Date ? input.at : new Date(input.at)
        if (!Number.isFinite(at.getTime()) || at.getTime() <= this.#date().getTime())
            throw new LitiError('LITI_INVALID_INPUT', 'Scheduled publish time must be in the future.')
        const candidate = await this.#publicationCandidate(entry, input, false, context)
        const { revisionId, time, conditions, revisions } = candidate
        const scheduledData = candidate.prepared?.data ?? (await this.#revision(revisionId, entry.id)).data
        entryPath(entry.model, candidate.definition, { id: entry.id, data: scheduledData }, this.#apiBases())
        await this.#commit(
            {
                conditions,
                revisions,
                updates: [
                    {
                        id: entryId,
                        patch: {
                            ...(input.draft ? { currentRevisionId: revisionId, updatedAt: time } : {}),
                            scheduledRevisionId: revisionId,
                            scheduledAt: at.toISOString(),
                        },
                    },
                ],
            },
            context,
        )
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            revisionId,
            type: 'schedule',
            data: scheduledData,
            version: input.expectedVersion + 1,
        })
        return this.getEntry(entryId)
    }

    async cancelScheduledPublish(
        entryId: string,
        input: { actorId?: string; expectedVersion: number },
        loaded?: EntryRecord,
    ): Promise<EntryRecord> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId, loaded)
        this.#assertFeature(entry.model, 'scheduling')
        await this.#commit({
            conditions: [this.#guard(entryId, input.expectedVersion)],
            updates: [{ id: entryId, patch: { scheduledRevisionId: null, scheduledAt: null } }],
        })
        await this.#afterCommit({
            ...(input.actorId ? { actorId: input.actorId } : {}),
            entryId,
            model: entry.model,
            data: entry.data,
            type: 'cancelSchedule',
            version: input.expectedVersion + 1,
        })
        return this.getEntry(entryId)
    }

    async publishDue(now = this.#date(), context: OperationContext = {}): Promise<PublishDueResult> {
        await this.initialize()
        const due = await this.#storage.scheduledBefore(now.toISOString())

        const result: PublishDueResult = { failed: [], published: [] }
        for (const entry of due) {
            try {
                this.#assertFeature((await this.#requiredEntry(entry.id)).model, 'scheduling')
                await this.#publishEntry(
                    await this.#requiredEntry(entry.id),
                    {
                        expectedVersion: Number(entry.version),
                        revisionId: entry.revisionId,
                    },
                    false,
                    context,
                )
                result.published.push(entry.id)
            } catch (error) {
                result.failed.push({
                    entryId: entry.id,
                    message: error instanceof Error ? error.message : 'Scheduled publish failed.',
                })
            }
        }
        if (this.config.assets?.separateDrafts === true) result.assets = await this.#assets.sync()
        return result
    }

    async setSortOrder(
        entryId: string,
        sortOrder: number | null,
        expectedVersion: number,
        actorId?: string,
    ): Promise<EntryRecord> {
        const entry = await this.getEntry(entryId)
        return (await this.setSortOrders(entry.model, [{ id: entryId, sortOrder, expectedVersion }], actorId))[0]!
    }

    async setSortOrders(
        model: string,
        items: Array<{ id: string; sortOrder: number | null; expectedVersion: number }>,
        actorId?: string,
    ): Promise<EntryRecord[]> {
        await this.initialize()
        if (!this.#model(model).sortable) throw new LitiError('LITI_INVALID_INPUT', 'Model is not sortable.')
        if (
            !Array.isArray(items) ||
            items.some(
                (item) =>
                    !item ||
                    typeof item.id !== 'string' ||
                    !Number.isSafeInteger(item.expectedVersion) ||
                    item.expectedVersion < 0 ||
                    (item.sortOrder !== null &&
                        (typeof item.sortOrder !== 'number' || !Number.isFinite(item.sortOrder))),
            ) ||
            new Set(items.map((item) => item.id)).size !== items.length
        )
            throw new LitiError(
                'LITI_INVALID_INPUT',
                'Sort items require unique IDs, finite orders and non-negative integer versions.',
            )
        if (!items.length) return []
        const entries = await Promise.all(items.map(({ id }) => this.#entryRow(id)))
        await this.#commit({
            conditions: items.map(({ id, expectedVersion }) => ({
                kind: 'entryVersion',
                id,
                version: expectedVersion,
                model,
            })),
            prune: this.#model(model).revisions === false ? items.map((item) => item.id) : [],
            publicGeneration: Boolean(this.#publicModel(model)) && entries.some((entry) => entry?.publishedRevisionId),
            updates: items.map((item) => ({
                id: item.id,
                patch: {
                    sortOrder: item.sortOrder,
                },
            })),
        })
        for (const [index, item] of items.entries()) {
            const entry = entries[index]
            if (entry?.sortOrder === item.sortOrder) continue
            await this.#afterCommit({
                ...(actorId ? { actorId } : {}),
                entryId: item.id,
                model,
                ...(entry ? { data: entry.data } : {}),
                type: 'sort',
                version: item.expectedVersion + 1,
            })
        }
        return Promise.all(items.map((item) => this.getEntry(item.id)))
    }

    async deleteEntry(
        entryId: string,
        input: { actorId?: string; expectedVersion: number },
        loaded?: EntryRecord,
    ): Promise<void> {
        await this.initialize()
        const entry = await this.#requiredEntry(entryId, loaded)
        const publicGraphChanged = Boolean(this.#publicModel(entry.model) && entry.publishedRevisionId)
        if (await this.#storage.hasRetainedRelations(entryId))
            throw new LitiError('LITI_RELATION_BLOCKED', 'Retained revisions still reference this entry.')
        await this.#commit({
            conditions: [this.#guard(entryId, input.expectedVersion), { kind: 'noRetainedRelations', id: entryId }],
            routes: [{ kind: 'remove', entryId }],
            delete: entryId,
            publicGeneration: publicGraphChanged,
        })
        await this.#afterCommit(
            {
                ...(input.actorId ? { actorId: input.actorId } : {}),
                entryId,
                model: entry.model,
                version: input.expectedVersion + 1,
                type: 'delete',
                data: entry.data,
            },
            publicGraphChanged,
        )
    }

    #assertFeature(model: string, feature: 'publishing' | 'scheduling' | 'revisions'): void {
        const definition = this.#model(model)
        if ((definition[feature] ?? (feature === 'scheduling' ? definition.publishing !== false : true)) === false)
            throw new LitiError('LITI_INVALID_INPUT', `${feature} is disabled for model "${model}".`)
    }

    #id(): string {
        return this.#options.id?.() ?? crypto.randomUUID()
    }

    #date(): Date {
        return this.#options.now?.() ?? new Date()
    }

    #now(): string {
        return this.#date().toISOString()
    }

    async #publishedRows(modelName?: string, ids?: string[], locale?: string): Promise<PublishedRow[]> {
        return this.#storage.published({
            ...(modelName ? { model: modelName } : {}),
            ...(ids ? { ids } : {}),
            ...(locale !== undefined ? { locale } : {}),
        })
    }

    async #publicSnapshot(
        roots: PublishedRow[],
        requestedLocale?: string,
        indexed?: Map<string, ReturnType<typeof collectReferences>>,
    ): Promise<Map<string, PublishedRow>> {
        const candidates = new Map<string, PublishedRow>()
        const references = new Map<string, ReturnType<typeof collectReferences>>()
        const assetIds = new Set<string>()
        let frontier = roots.filter((row) => this.#publicModel(row.model))
        while (frontier.length > 0) {
            const nextIds = new Set<string>()
            for (const row of frontier) {
                if (candidates.has(row.id)) continue
                const definition = this.#publicModel(row.model)
                if (!definition) continue
                try {
                    if (row.locale !== this.#locale(definition, row.locale || undefined)) continue
                } catch {
                    continue
                }
                const stored = projectStoredFields(definition.fields, row.data)
                const validated = await validateModelData(definition, stored)
                if (!validated.data || stableJson(validated.data) !== stableJson(stored)) continue
                const found = indexed?.get(row.id) ?? collectReferences(definition.fields, stored)
                candidates.set(row.id, row)
                references.set(row.id, found)
                for (const reference of found.relations) if (!candidates.has(reference.id)) nextIds.add(reference.id)
                for (const reference of found.assets) assetIds.add(reference.id)
            }
            if (nextIds.size === 0) break
            frontier = (await this.#publishedRows(undefined, [...nextIds], requestedLocale)).map((row) =>
                resolveTranslation(row, requestedLocale ?? roots[0]?.locale),
            )
        }
        const readyAssets = new Set<string>()
        if (assetIds.size > 0) {
            const rows = await this.#storage.assets({ state: 'ready', ids: [...assetIds] })

            for (const row of rows) readyAssets.add(row.id)
        }
        let changed = true
        while (changed) {
            changed = false
            for (const [id, found] of references) {
                if (!candidates.has(id)) continue
                const definition = this.#publicModel(candidates.get(id)?.model ?? '')
                const missingAsset = found.assets.some((reference) => !readyAssets.has(reference.id))
                const missingRequiredRelation = found.relations.some((reference) => {
                    const field = definition && fieldAtPath(definition.fields, reference.path)
                    return field?.kind === 'relation' && field.required && !candidates.has(reference.id)
                })
                if (missingAsset || missingRequiredRelation) {
                    candidates.delete(id)
                    changed = true
                }
            }
        }
        return candidates
    }

    async #publicEntryGraph(roots: PublishedRow[], requestedLocale?: string): Promise<Map<string, PublishedRow>> {
        const graph = await this.#publicSnapshot(roots, requestedLocale)
        const candidates = [...graph.values()]
        const metadata = this.#options.locales?.supported?.length
            ? await this.#storage.publicTranslations([...graph.keys()])
            : []
        for (const row of candidates) {
            const routes = metadata.filter((value) => value.entryId === row.id)
            row.translations = {
                ...Object.fromEntries(routes.map((value) => [value.locale, value.data])),
                ...row.translations,
            }
        }
        for (const row of candidates) this.#projection.availableLocales.set(row, new Set())
        const locales = new Set(candidates.flatMap((row) => [row.defaultLocale, ...Object.keys(row.translations)]))
        for (const locale of locales) {
            const variants = candidates.filter(
                (row) => row.defaultLocale === locale || Object.hasOwn(row.translations, locale),
            )
            const indexed = new Map(
                metadata
                    .filter((value) => value.locale === locale)
                    .map((value) => [
                        value.entryId,
                        {
                            assets: value.assets.filter((ref) =>
                                fieldAtPath(this.config.models[graph.get(value.entryId)!.model]!.fields, ref.path),
                            ),
                            relations: value.relations.filter((ref) =>
                                fieldAtPath(this.config.models[graph.get(value.entryId)!.model]!.fields, ref.path),
                            ),
                        },
                    ]),
            )
            const safe = await this.#publicSnapshot(
                variants.map((row) => resolveTranslation(row, locale)),
                locale,
                indexed,
            )
            for (const row of variants) if (safe.has(row.id)) this.#projection.availableLocales.get(row)!.add(locale)
        }
        return graph
    }

    async #projectRoots(
        rows: PublishedRow[],
        requestedLocale?: string,
        markdownSource = false,
    ): Promise<PublicEntry[]> {
        const groups = new Map<string, PublishedRow[]>()
        for (const row of rows) {
            const group = groups.get(row.locale) ?? []
            group.push(row)
            groups.set(row.locale, group)
        }
        const projected = new Map<string, PublicEntry>()
        const budget = { nodes: 0 }
        for (const [locale, roots] of groups) {
            const graph = await this.#publicEntryGraph(roots, requestedLocale ?? locale)
            for (const row of roots)
                if (graph.has(row.id))
                    projected.set(
                        row.id,
                        await this.#presentEntry(
                            this.#projection.project(row, graph, new Set(), budget, markdownSource),
                        ),
                    )
        }
        return rows.flatMap((row) => (projected.has(row.id) ? [projected.get(row.id)!] : []))
    }

    async listPublicEntries(modelName: string, locale?: string): Promise<PublicEntry[]> {
        await this.initialize()
        return readPublicSnapshot(
            () => this.publicGeneration(),
            async () => {
                return this.#listPublicEntries(modelName, locale)
            },
        )
    }

    async #listPublicEntries(modelName: string, locale?: string, markdownSource = false): Promise<PublicEntry[]> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false) throw new LitiError('LITI_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const normalizedLocale = this.#readLocale(definition, locale)
        const roots: PublishedRow[] = []
        for (let offset = 0; ; offset += 100) {
            const page = await this.#storage.pagePublished(
                { model: modelName, locale: normalizedLocale ?? '' },
                { limit: 100, offset },
            )
            roots.push(...page.items)
            if (offset + page.items.length >= page.total) break
        }
        const rows = roots.map((row) => resolveTranslation(row, normalizedLocale))
        return this.#projectRoots(rows, normalizedLocale, markdownSource)
    }

    async getPublicEntry(
        modelName: string,
        id: string,
        locale?: string,
        markdownSource = false,
    ): Promise<PublicEntry | null> {
        await this.initialize()
        return readPublicSnapshot(
            () => this.publicGeneration(),
            () => this.#publicEntry(modelName, id, locale, markdownSource),
        )
    }

    async #publicEntry(
        modelName: string,
        id: string,
        locale?: string,
        markdownSource = false,
    ): Promise<PublicEntry | null> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false) throw new LitiError('LITI_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const normalizedLocale = this.#readLocale(definition, locale)
        const original = (
            await this.#storage.published({ model: modelName, ids: [id], locale: normalizedLocale ?? '' })
        )[0]
        const row = original && resolveTranslation(original, normalizedLocale)

        if (!row) return null
        const graph = await this.#publicEntryGraph([row], normalizedLocale ?? row.locale)
        return graph.has(row.id)
            ? this.#presentEntry(this.#projection.project(row, graph, new Set(), { nodes: 0 }, markdownSource))
            : null
    }

    async rebuildSearch(): Promise<{ indexed: number }> {
        await this.initialize()
        return this.#storage.rebuildSearch()
    }

    async publicGeneration(): Promise<number> {
        await this.initialize()
        const generation = await this.#storage.publicGeneration()
        this.#projection.generation = generation
        return generation
    }

    async contentDocument(modelName: string, id: string, locale?: string): Promise<ContentFile | null> {
        await this.initialize()
        return readPublicSnapshot(
            () => this.publicGeneration(),
            async (generation) => {
                const entry = await this.#publicEntry(modelName, id, locale, true)
                if (!entry) return null
                const key = id + '\0' + entry.locale
                const cached = this.#parsedContent.get(key)
                if (cached?.generation === generation) return structuredClone(cached.file)
                const content = await createMarkdownContent(
                    modelName,
                    this.#model(modelName),
                    [entry],
                    this.config.markdown,
                    (assetId) => this.#projection.assetUrl(assetId),
                )
                this.#prepareContent(content, this.#model(modelName), generation)
                return (await content.get(id + '.json')) ?? null
            },
        )
    }

    async contentPage(modelName: string, page: { limit: number; offset: number }, locale?: string) {
        await this.initialize()
        return readPublicSnapshot(
            () => this.publicGeneration(),
            async (generation) => {
                if (
                    !Number.isSafeInteger(page.limit) ||
                    page.limit < 1 ||
                    page.limit > 100 ||
                    !Number.isSafeInteger(page.offset) ||
                    page.offset < 0
                )
                    throw new LitiError('LITI_INVALID_INPUT', 'limit must be 1–100 and offset non-negative.')
                const definition = this.#model(modelName)
                if (definition.public === false) throw new LitiError('LITI_NOT_PUBLIC', 'Model is private.')
                const normalized = this.#readLocale(definition, locale)
                const result = await this.#storage.pagePublished({ model: modelName, locale: normalized ?? '' }, page)
                const roots = result.items.map((row) => resolveTranslation(row, normalized))
                const entries = await this.#projectRoots(roots, normalized, true)
                const content = await createMarkdownContent(
                    modelName,
                    definition,
                    entries,
                    this.config.markdown,
                    (id) => this.#projection.assetUrl(id),
                    (id) => {
                        const entry = entries.find((item) => item.id === id)!
                        const cached = this.#parsedContent.get(id + '\0' + entry.locale)
                        return cached?.generation === generation ? structuredClone(cached.file) : undefined
                    },
                )
                this.#prepareContent(content, definition, generation)
                return { items: await content.list(), total: result.total, ...page }
            },
        )
    }

    async contentList(modelName: string, locale?: string) {
        const documents = await (await this.content(modelName, locale)).list()
        return documents
    }

    async content(modelName: string, locale?: string): Promise<ComarkContent> {
        await this.initialize()
        const definition = this.#model(modelName)
        if (definition.public === false) throw new LitiError('LITI_NOT_PUBLIC', `Model "${modelName}" is private.`)
        const normalizedLocale = this.#readLocale(definition, locale)
        const initialGeneration = await this.publicGeneration()
        const cacheKey = `${modelName}\0${normalizedLocale}`
        const cached = this.#content.get(cacheKey)
        if (cached?.generation === initialGeneration) return cached.content
        return readPublicSnapshot(
            () => this.publicGeneration(),
            async (generation) => {
                const entries = await this.#listPublicEntries(modelName, normalizedLocale, true)
                const content = await createMarkdownContent(
                    modelName,
                    definition,
                    entries,
                    this.config.markdown,
                    (id) => this.#projection.assetUrl(id),
                    (id) => {
                        const parsed = this.#parsedContent.get(
                            id + '\0' + entries.find((entry) => entry.id === id)!.locale,
                        )
                        return parsed?.generation === generation ? structuredClone(parsed.file) : undefined
                    },
                )
                this.#prepareContent(content, definition, generation)
                this.#content.set(cacheKey, { content, generation })
                if (this.#content.size > 64) this.#content.delete(this.#content.keys().next().value!)
                return content
            },
            initialGeneration,
        )
    }

    #prepareContent(content: ComarkContent, definition: ModelDefinition, generation: number): void {
        content.hooks.hook('file:parsed', async ({ file }) => {
            if (!file) return
            const metadata = file.data['_liti']
            const description = entryDescription(definition, file.data).text
            if (isObject(metadata) && description !== undefined)
                metadata.seo = this.#projection.sanitizeSeo(
                    mergeLitiSeo(
                        serializeLitiSeo(metadata.seo),
                        { description },
                        await this.#modelSeo({ ...metadata, data: file.data } as unknown as PublicEntry),
                    ),
                )
            if (isObject(metadata) && typeof metadata.id === 'string') {
                this.#parsedContent.set(metadata.id + '\0' + String(metadata.locale ?? ''), {
                    file: structuredClone(file),
                    generation,
                })
                if (this.#parsedContent.size > 256) this.#parsedContent.delete(this.#parsedContent.keys().next().value!)
            }
        })
    }

    async resolvePath(
        path: string,
        locale?: string,
        markdown: 'full' | 'summary' = 'full',
    ): Promise<{ entry: PublicEntry; kind: 'page' } | { kind: 'redirect'; status: number; target: string } | null> {
        await this.initialize()
        const normalizedLocale = locale ?? '*'
        if (
            normalizedLocale !== '*' &&
            normalizedLocale &&
            this.#options.locales?.supported &&
            !this.#options.locales.supported.includes(normalizedLocale)
        )
            throw new LitiError('LITI_INVALID_INPUT', 'Unsupported route locale.')
        const generation = await this.publicGeneration()
        const cached = this.#routes.get(normalizedLocale)
        if (cached?.generation !== generation) {
            const router = createRouter<RouteRow>()
            const routes = (
                await this.#storage.routes(normalizedLocale === '*' ? {} : { locales: [normalizedLocale, ''] })
            ).sort((left, right) => Number(left.locale === '') - Number(right.locale === ''))

            for (const route of routes) addRoute(router, 'GET', route.path, route)
            this.#routes.set(normalizedLocale, { generation, router })
            if (this.#routes.size > 64) this.#routes.delete(this.#routes.keys().next().value!)
        }
        const normalizedPath = new URL(path, 'http://liti.local').pathname
        const match = findRoute(this.#routes.get(normalizedLocale)!.router, 'GET', normalizedPath, { normalize: true })
        if (!match) return null
        const route = match.data
        const rows = await this.#publishedRows(undefined, [route.entryId])
        const entry = rows[0] && resolveTranslation(rows[0], route.locale)
        if (!entry) return null
        const graph = await this.#publicEntryGraph([entry])
        if (!graph.has(entry.id)) return null
        if (route.kind === 'page') {
            const budget = { nodes: 0 }
            const projected = await this.#presentEntry(this.#projection.project(entry, graph, new Set(), budget))
            const definition = this.#model(entry.model)
            let parsed = this.#parsedContent.get(entry.id + '\0' + entry.locale)
            if (parsed?.generation !== generation) {
                // Parse the already-projected route entry; no second database fetch.
                const content = await createMarkdownContent(
                    entry.model,
                    definition,
                    [await this.#presentEntry(this.#projection.project(entry, graph, new Set(), { nodes: 0 }, true))],
                    this.config.markdown,
                    (id) => this.#projection.assetUrl(id),
                )
                this.#prepareContent(content, definition, generation)
                await content.get(`${entry.id}.json`)
                parsed = this.#parsedContent.get(entry.id + '\0' + entry.locale)
            }
            const file =
                parsed &&
                (markdown === 'summary'
                    ? (
                          await projectMarkdownListSummary([parsed.file], entry.model, this.config, (id) =>
                              this.#projection.assetUrl(id),
                          )
                      )[0]!
                    : parsed.file)
            const metadata = file?.data['_liti']
            if (isObject(metadata)) projected.seo = serializeLitiSeo(metadata.seo)
            if (file) {
                const { _liti: _, ...data } = file.data
                projected.data = structuredClone(data)
            }
            // Keep the existing route DTO's self alternate for nonlocalized entries.
            projected.alternates ??= projected.path ? [{ locale: projected.locale, path: projected.path }] : []
            return { entry: projected, kind: 'page' }
        }
        if (!route.targetPath) return null
        return { kind: 'redirect', status: route.status ?? 302, target: route.targetPath }
    }

    async sitemap(): Promise<Array<{ loc: string; lastmod?: string }>> {
        await this.initialize()
        const routes = (await this.#storage.routes({ kinds: ['page'] })).sort((left, right) =>
            left.path.localeCompare(right.path),
        )

        const rows = await this.#publishedRows(undefined, [...new Set(routes.map((route) => route.entryId))])
        const graph = await this.#publicSnapshot(rows)
        const byId = new Map(rows.map((row) => [row.id, row]))
        return routes.flatMap((route) => {
            const row = byId.get(route.entryId)
            const definition = row && this.#publicModel(row.model)
            const options = definition ? modelRouteOptions(definition) : null
            return row &&
                graph.has(row.id) &&
                (this.#resolveRouteRule(route.path).sitemap ?? options?.sitemap) !== false
                ? [{ lastmod: row.updatedAt, loc: decodeURI(route.path) }]
                : []
        })
    }

    async routeSnapshot(): Promise<
        Array<{
            entryId: string
            kind: RouteRow['kind']
            locale: string
            path: string
            status: number | null
            targetPath: string | null
        }>
    > {
        await this.initialize()
        return (await this.#storage.routes()).map(({ entryId, kind, locale, path, status, targetPath }) => ({
            entryId,
            kind,
            locale,
            path,
            status,
            targetPath,
        }))
    }

    async inspect(): Promise<LitiInspection> {
        await this.initialize()
        const stats = await this.#storage.statistics()
        return {
            assets: Object.fromEntries(stats.assets.map(({ state, count }) => [state, count])),
            diagnostics: structuredClone(this.diagnostics),
            entries: Object.fromEntries(stats.entries.map(({ model, ...counts }) => [model, counts])),
            orphanAssets: stats.orphanAssets,
            publicGeneration: await this.publicGeneration(),
        }
    }

    async llmsEntries(): Promise<LLMSEntry[]> {
        await this.initialize()
        const entries: LLMSEntry[] = []
        for (const [modelName, definition] of Object.entries(this.config.models)) {
            if (definition.public === false || !definition.route) continue
            const route = modelRouteOptions(definition)
            if (route?.redirect) continue
            const locales = this.#options.locales?.supported?.length
                ? (this.#options.locales?.supported ?? [this.#locale(definition)])
                : ['']
            for (const locale of locales) {
                const items = await (await this.content(modelName, locale)).list()
                for (const item of items) {
                    if (!isObject(item.data)) continue
                    const metadata = item.data['_liti']
                    if (!isObject(metadata) || metadata.locale !== locale) continue
                    const path = metadata.path
                    if (typeof path !== 'string') continue
                    if ((this.#resolveRouteRule(path).llms ?? route?.llms) === false) continue
                    const titleKeys = [definition.displayFields?.title, 'title', 'name']
                    const title =
                        titleKeys
                            .map((key) => (key && typeof item.data[key] === 'string' ? cleanText(item.data[key]) : ''))
                            .find(Boolean) || String(metadata.id ?? path)
                    const documents: MarkdownDocumentValue[] = []
                    for (const [name, field] of Object.entries(definition.fields)) {
                        collectMarkdown(field, item.data[name], documents)
                    }
                    const descriptionValue = definition.displayFields?.description
                        ? item.data[definition.displayFields.description]
                        : undefined
                    const descriptionDocument = markdownDocument(descriptionValue) ?? documents[0]
                    const description = cleanText(astText(descriptionDocument?.meta?.summary))
                    let href = path
                    if (this.#options.site?.url) {
                        try {
                            href = new URL(path, this.#options.site.url).href
                        } catch {}
                    }
                    const content = cleanText(documents.map((document) => astText(document.nodes)).join(' '))
                    entries.push({
                        ...(content ? { content } : {}),
                        ...(description ? { description: description.slice(0, 240) } : {}),
                        href,
                        title,
                    })
                }
            }
        }
        return entries
    }

    async llms(full = false): Promise<string> {
        const lines = [`# ${this.#options.site?.name ?? 'Site content'}`, '', '> Published runtime content.']
        for (const entry of await this.llmsEntries()) {
            lines.push('', `- [${entry.title}](${entry.href})${entry.description ? ` — ${entry.description}` : ''}`)
            if (full && entry.content) lines.push('', `## ${entry.title}`, '', entry.content)
        }
        return `${lines.join('\n')}\n`
    }

    uploadAsset(input: UploadAssetInput) {
        return this.#assets.uploadAsset(input)
    }
    getAsset(id: string) {
        return this.#assets.getAsset(id)
    }
    downloadAsset(id: string, published = true) {
        return this.#assets.downloadAsset(id, published)
    }
    deleteAsset(id: string) {
        return this.#assets.deleteAsset(id)
    }
    runAssetGC() {
        return this.#assets.runAssetGC()
    }
    syncAssetCopies() {
        return this.#assets.syncAssetCopies()
    }

    async #publishedAssetIds(entryIds?: string[]): Promise<Set<string>> {
        const roots = await this.#publishedRows(undefined, entryIds)
        const ids = new Set<string>()
        const locales = new Set(roots.flatMap((row) => [row.defaultLocale, ...Object.keys(row.translations)]))
        for (const locale of locales) {
            const variants = roots.filter(
                (row) => row.defaultLocale === locale || Object.hasOwn(row.translations, locale),
            )
            const graph = await this.#publicSnapshot(
                variants.map((row) => resolveTranslation(row, locale)),
                locale,
            )
            for (const row of graph.values()) {
                const definition = this.#publicModel(row.model)
                if (definition)
                    for (const reference of collectReferences(definition.fields, row.data).assets) ids.add(reference.id)
            }
        }
        return ids
    }

    #publicBase(): string {
        return (this.#options.publicBase ?? '/api/content').replace(/\/$/u, '')
    }

    #apiBases(): string[] {
        return [this.#publicBase(), (this.#options.managementBase ?? '/api/liti').replace(/\/$/u, '')]
    }
}

export const createRuntime = <Context = unknown>(options: LitiOptions<Context>): Liti<Context> => new Liti(options)
