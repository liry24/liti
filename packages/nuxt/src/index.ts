import { resolve } from 'node:path'
import { normalize } from 'pathe'

import {
    addImports,
    addPlugin,
    addRouteMiddleware,
    addServerHandler,
    addServerImports,
    addServerPlugin,
    addTemplate,
    addTypeTemplate,
    createResolver,
    defineNuxtModule,
    installModule,
    tryResolveModule,
    directoryToURL,
} from 'nuxt/kit'
import type { Nuxt } from 'nuxt/schema'
import type { RequestEvent } from 'nuxt/server'
import { transformNitroCloudflareRequest } from './runtime/nitro2'
import { litiModuleDependencies } from './nuxt/dependencies'
import { stopNitroDevReloadOnClose } from './nuxt/dev-close'
import type { NitroConfig } from 'nitropack/types'
import { readLitiNuxtConfig } from './nuxt/config'

import type { LitiConfig, LitiLifecycleEvent } from '../../liti/src/config'
import type { EntryPrepareContext } from '../../vue/src/model'
import type { AnyField } from '../../liti/src/fields'
import { serializeLitiSeo, serializeLitiRouteRules } from '../../liti/src/seo'
import {
    litiNuxtClientTemplate,
    litiNuxtFormsTemplate,
    litiNuxtModelTypes,
    litiNuxtSeoTemplate,
} from './nuxt/client-templates'
import type { LitiActor } from '../../liti/src/server/types'
import { moduleMeta } from './meta'
import { litiNuxtMetadataTemplate, litiNuxtRouteTemplate } from './nuxt/route-templates'

export interface ModuleOptions {
    auth: boolean
    client: { basePath: string; origin?: string }
    configFile: string
    devtools: boolean
    enabled: boolean
    i18n: boolean
    markdown: boolean
    llms: boolean
    ogImage: boolean
    robots: boolean
    routing: { enabled: boolean; preserveHistory: boolean; redirects: boolean }
    schemaOrg: boolean
    seo: boolean
    server: { enabled: boolean; managementBase: string }
    sitemap: boolean
}

export type ModuleConfig = Omit<Partial<ModuleOptions>, 'client' | 'routing' | 'server'> & {
    client?: Partial<ModuleOptions['client']>
    routing?: Partial<ModuleOptions['routing']>
    server?: Partial<ModuleOptions['server']>
}

export interface LitiAuthorizeContext {
    actor: LitiActor
    event: RequestEvent
    session: { user: { id: string; role?: string | null }; session: unknown }
}

export interface LitiNuxtHost {
    imports: string[]
    platformProperties: string[]
}

declare module '@nuxt/schema' {
    interface NuxtConfig {
        liti?: ModuleConfig
    }

    interface NuxtOptions {
        liti: ModuleOptions
    }
    interface NuxtHooks {
        'liti:config': (config: LitiConfig) => void | Promise<void>
        'liti:host': (host: LitiNuxtHost) => void | Promise<void>
    }
}

declare module 'nuxt/schema' {
    interface NuxtServerHooks {
        'liti:authorize': (context: LitiAuthorizeContext) => void | Promise<void>
        'liti:entry:committed': (event: LitiLifecycleEvent) => void | Promise<void>
    }
}

declare module 'nuxt/app' {
    interface RuntimeNuxtHooks {
        'liti:entry:prepare': (context: EntryPrepareContext) => void | Promise<void>
    }
}

const defaults: ModuleOptions = {
    auth: false,
    client: { basePath: '/api/content' },
    configFile: './liti.config.ts',
    devtools: true,
    enabled: true,
    i18n: false,
    markdown: true,
    llms: false,
    ogImage: false,
    robots: false,
    routing: { enabled: true, preserveHistory: true, redirects: true },
    schemaOrg: false,
    seo: false,
    server: { enabled: true, managementBase: '/api/liti' },
    sitemap: false,
}

const normalizeBase = (value: string, name: string): string => {
    const normalized = `/${value.split('/').filter(Boolean).join('/')}`
    if (normalized === '/' || normalized.includes('?') || normalized.includes('#')) {
        throw new Error(`[liti] ${name} must be a non-root URL path.`)
    }
    return normalized
}

const resolvePeer = async (name: string, nuxt: Nuxt): Promise<string> => {
    const candidate = await tryResolveModule(
        name,
        [nuxt.options.rootDir, ...nuxt.options.modulesDir.map((dir) => resolve(dir, '..'))].map(directoryToURL),
    )
    if (!candidate)
        throw new Error(`[liti] Install the peer dependency "${name}" in your app, or disable its liti integration.`)
    return candidate
}

const hasAssets = (field: AnyField): boolean =>
    ['image', 'images', 'file'].includes(field.kind) ||
    (field.kind === 'object' && Object.values(field.fields).some(hasAssets)) ||
    (field.kind === 'array' && hasAssets(field.item))

const hasMarkdown = (field: AnyField): boolean =>
    field.kind === 'markdown' ||
    (field.kind === 'object' && Object.values(field.fields).some(hasMarkdown)) ||
    (field.kind === 'array' && hasMarkdown(field.item))

const localeOptions = (nuxt: Nuxt): { defaultLocale?: string; strategy: string; supported: string[] } => {
    const i18n = (
        nuxt.options as typeof nuxt.options & {
            i18n?: { defaultLocale?: string; locales?: Array<string | { code?: string }>; strategy?: string }
        }
    ).i18n
    const supported = (i18n?.locales ?? []).flatMap((locale) => {
        const code = typeof locale === 'string' ? locale : locale.code
        return code ? [code] : []
    })
    return {
        ...(i18n?.defaultLocale ? { defaultLocale: i18n.defaultLocale } : {}),
        strategy: i18n?.strategy ?? 'prefix_except_default',
        supported,
    }
}

export default defineNuxtModule<ModuleConfig>({
    meta: moduleMeta,
    defaults,
    moduleDependencies: litiModuleDependencies,
    async setup(input, nuxt) {
        // Nuxt merges defaults before setup; the public input type allows nested partial options.
        const options = input as ModuleOptions
        if (!options.enabled) return
        if (nuxt.options.server?.builder && nuxt.options.server.builder !== '@nuxt/nitro-server') {
            throw new Error(
                '[liti] Nuxt 4.6 with the default Nitro 2 server builder is required for authentication and streaming adapters.',
            )
        }
        if (nuxt.options.dev) {
            nuxt.hook('nitro:init', stopNitroDevReloadOnClose)
        }
        addTypeTemplate(
            {
                filename: 'types/liti.d.ts',
                getContents: () => "import 'liti/nuxt'\nexport {}\n",
            },
            { nuxt: true, nitro: true, node: true },
        )
        options.client.basePath = normalizeBase(options.client.basePath, 'client.basePath')
        options.server.managementBase = normalizeBase(options.server.managementBase, 'server.managementBase')
        if (!options.server.enabled && !options.client.origin) {
            throw new Error('[liti] client.origin is required while server.enabled is false.')
        }
        if (options.server.enabled && options.client.basePath === options.server.managementBase) {
            throw new Error('[liti] Public and management API paths must differ.')
        }

        if (options.sitemap) {
            const sitemap = (nuxt.options as typeof nuxt.options & { sitemap?: { sources?: string[] } }).sitemap
            const source = `${options.client.origin ?? ''}${options.client.basePath}/_sitemap`
            if (sitemap) {
                sitemap.sources ??= []
                if (!sitemap.sources.includes(source)) sitemap.sources.push(source)
            } else {
                ;(nuxt.options as typeof nuxt.options & { sitemap: { sources: string[] } }).sitemap = {
                    sources: [source],
                }
            }
        }

        if (options.llms) {
            nuxt.hook('modules:done', () => {
                // Native LLMS adds routes through Kit after this module's setup.
                nuxt.hook('prerender:routes', ({ routes }) => {
                    routes.delete('/llms.txt')
                    routes.delete('/llms-full.txt')
                })
            })
        }

        const publicLocales = options.i18n ? localeOptions(nuxt) : { strategy: 'no_prefix', supported: [] }

        if (options.seo || options.ogImage || options.schemaOrg) {
            const plugin = addTemplate({
                filename: 'liti/metadata-plugin.mjs',
                getContents: () =>
                    litiNuxtMetadataTemplate({
                        ...options,
                        ...(options.server.enabled ? { presentationBase: options.client.basePath } : {}),
                    }),
                write: true,
            })
            addPlugin(plugin.dst)
        }

        const nitro = (nuxt.options as unknown as { nitro: NitroConfig }).nitro
        nitro.externals ??= {}
        // Nuxt 4.6's renderer subpaths must be bundled so Nitro replaces their build stubs.
        ;(nitro.externals.inline ??= []).push(
            'liti',
            normalize(createResolver(import.meta.url).resolve('.')),
            'nuxt/internal',
            resolve(nuxt.options.buildDir, 'liti'),
            ...(options.auth ? [resolve(nuxt.options.buildDir, 'better-auth/database.mjs')] : []),
        )

        let domainConfig: NonNullable<Awaited<ReturnType<typeof readLitiNuxtConfig>>>['config'] | undefined
        let configPath: string | undefined
        const declaration = await readLitiNuxtConfig(nuxt, options.configFile, options.server.enabled)
        const environments = declaration?.environments ?? []
        if (declaration) {
            configPath = declaration.configPath
            domainConfig = declaration.config
            // Nuxt appends dependency modules after their owner; hosts must register hooks first.
            const hosts = new Set(
                Object.values(domainConfig.adapter ?? {}).flatMap((provider) =>
                    provider?.hosts?.nuxt ? [provider.hosts.nuxt] : [],
                ),
            )
            for (const host of hosts)
                await installModule(host, { config: domainConfig, environments, auth: options.auth }, nuxt)
            const configFiles = [configPath]
            nuxt.hook('prepare:types', ({ tsConfig }) => {
                ;(tsConfig.include ??= []).push(...configFiles)
            })
            if (nuxt.options.dev) {
                // shortcut: watch entrypoints; configure Nuxt watch for additional imported helpers.
                nuxt.options.watch.push(...configFiles.map(normalize))
            }
            if (
                options.server.enabled &&
                (Object.keys(domainConfig.models).length || domainConfig.assets) &&
                !domainConfig.adapter?.database
            )
                throw new Error('[liti] Select adapter.database in liti.config.ts.')
            if (Object.values(domainConfig.models).some((model) => Object.values(model.fields).some(hasMarkdown))) {
                if (!options.markdown) throw new Error('[liti] Enable markdown for Markdown fields.')
                await resolvePeer('comark', nuxt)
            }
            const fields = Object.values(domainConfig.models).flatMap((model) => Object.values(model.fields))
            if (fields.some((field) => field.i18n) && (!options.i18n || !publicLocales.supported.length))
                throw new Error('[liti] Translated fields require i18n and configured Nuxt i18n locales.')
            if (fields.some(hasAssets) && !domainConfig.adapter?.storage)
                throw new Error('[liti] Select adapter.storage for asset fields.')
            await nuxt.callHook('liti:config', domainConfig)
            if (options.server.enabled && (options.auth || options.llms)) {
                addServerHandler({
                    middleware: true,
                    handler: createResolver(import.meta.url).resolve('./runtime/database-middleware'),
                })
            }
            if (options.server.enabled && domainConfig.assets) {
                nitro.rollupConfig ??= {}
                const existing = nitro.rollupConfig.plugins
                nitro.rollupConfig.plugins = [
                    existing,
                    {
                        name: 'liti-cloudflare-upload-stream',
                        transform: transformNitroCloudflareRequest,
                    },
                ]
            }
        }

        const namedActions = Boolean(Object.keys(domainConfig?.actions ?? {}).length)
        const cmsConfigured = !domainConfig || Boolean(Object.keys(domainConfig.models).length || domainConfig.assets)
        if (options.routing.enabled && cmsConfigured) {
            const middleware = addTemplate({
                filename: 'liti/route-middleware.mjs',
                getContents: () => litiNuxtRouteTemplate(options, publicLocales),
                write: true,
            })
            addRouteMiddleware({ global: true, name: 'liti-public-route', path: middleware.dst })
        }

        // Only the explicitly serializable public presentation contract enters client config.
        const publicConfig = nuxt.options.runtimeConfig.public as typeof nuxt.options.runtimeConfig.public & {
            liti?: { seo?: unknown; routeRules?: unknown }
        }
        publicConfig.liti = {
            seo: serializeLitiSeo(domainConfig?.seo),
            routeRules: serializeLitiRouteRules(domainConfig?.routeRules),
        }

        const clientTemplate = addTemplate({
            filename: 'liti/client.ts',
            getContents: () =>
                litiNuxtClientTemplate({
                    ...(publicLocales.defaultLocale ? { defaultLocale: publicLocales.defaultLocale } : {}),
                    basePath: options.client.basePath,
                    managementBase: options.server.managementBase,
                    i18n: options.i18n,
                    auth: options.auth,
                    actions: namedActions,
                    ...(options.client.origin ? { origin: options.client.origin } : {}),
                }),
            write: true,
        })
        const formsTemplate = addTemplate({
            filename: 'liti/forms.ts',
            getContents: () =>
                litiNuxtFormsTemplate({
                    vue: [
                        ...new Set(domainConfig?.plugins?.flatMap((plugin) => (plugin.vue ? [plugin.vue] : [])) ?? []),
                    ],
                    editors: Object.fromEntries(
                        Object.entries(domainConfig?.models ?? {})
                            .filter(([, model]) => model.editor)
                            .map(([name, model]) => [name, Object.keys(model.editor!)]),
                    ),
                }),
            write: true,
        })
        nuxt.options.optimization.keyedComposables.push({
            name: 'litiAsyncData',
            source: clientTemplate.dst,
            argumentLength: 3,
        })
        addImports([
            { from: clientTemplate.dst, name: 'useLitiQuery' },
            { from: clientTemplate.dst, name: 'useLitiModels' },
            { from: formsTemplate.dst, name: 'useLitiForm' },
        ])
        if (namedActions) {
            nuxt.options.optimization.keyedComposables.push({
                name: 'litiAiFetch',
                source: clientTemplate.dst,
                argumentLength: 3,
            })
            addImports({ from: clientTemplate.dst, name: 'useAi' })
        }
        if (options.seo || options.ogImage) {
            addTemplate({
                filename: 'liti/seo.ts',
                getContents: () => litiNuxtSeoTemplate({ seo: options.seo, ogImage: options.ogImage }),
                write: true,
            })
        }
        if (domainConfig && configPath) {
            addTypeTemplate(
                {
                    filename: 'types/liti-models.d.ts',
                    getContents: () =>
                        litiNuxtModelTypes(configPath!, environments, [
                            ...new Set(
                                domainConfig?.plugins?.flatMap((plugin) => (plugin.vue ? [plugin.vue] : [])) ?? [],
                            ),
                        ]),
                },
                { nuxt: true, nitro: true, node: false },
            )
        }

        if (!options.server.enabled || !domainConfig || !configPath) return
        const locales = publicLocales
        const nuxtSite = (nuxt.options as typeof nuxt.options & { site?: { name?: string; url?: string } }).site
        const site = {
            ...(typeof nuxtSite?.name === 'string' ? { name: nuxtSite.name } : {}),
            ...(typeof nuxtSite?.url === 'string' ? { url: nuxtSite.url } : {}),
        }
        const host: LitiNuxtHost = { imports: [], platformProperties: [] }
        await nuxt.callHook('liti:host', host)
        const databaseSchema = domainConfig.adapter?.database?.schema
        const localizePath = options.i18n
            ? `locales: {
      defaultLocale: ${JSON.stringify(locales.defaultLocale)},
      supported: ${JSON.stringify(locales.supported)},
      localizePath: (path, locale) => {
        const strategy = ${JSON.stringify(locales.strategy)}
        const defaultLocale = ${JSON.stringify(locales.defaultLocale)}
        if (strategy === 'no_prefix' || (strategy === 'prefix_except_default' && locale === defaultLocale)) return path
        return '/' + locale + (path === '/' ? '' : path)
      },
    },`
            : ''
        nitro.experimental ??= {}
        nitro.experimental.tasks = true
        nitro.tasks ??= {}
        const taskPaths = {
            publishDue: 'publish-due',
            assetGC: 'asset-gc',
            syncAssets: 'sync-assets',
            rebuildSearch: 'rebuild-search',
        } as const
        for (const [key, name] of Object.entries(taskPaths)) {
            const task = `liti:${name}`
            nitro.tasks[task] = { handler: createResolver(import.meta.url).resolve(`./runtime/tasks/${name}`) }
            const schedule = domainConfig.tasks?.[key as keyof typeof taskPaths]
            if (typeof schedule === 'string') {
                if (!schedule.trim()) throw new Error(`[liti] ${task} requires a non-empty cron expression.`)
                nitro.scheduledTasks ??= {}
                const existing = nitro.scheduledTasks[schedule]
                const scheduled = Array.isArray(existing) ? existing : existing ? [existing] : []
                if (!scheduled.includes(task)) scheduled.push(task)
                nitro.scheduledTasks[schedule] = scheduled
            }
        }
        // Nitro skips TypeScript transforms beneath node_modules/.cache (cf build).
        // Keep this generated plugin executable JavaScript, with JSDoc for the native types.
        const runtimeTemplate = addTemplate({
            filename: 'liti/runtime.mjs',
            getContents: () => `import { defineNitroPlugin } from 'nitropack/runtime'
import { useServerHooks } from 'nuxt/server'
import { currentLitiContext, withLitiContext, configureLitiContext } from 'liti/internal/runtime/context'
import { resolvePublicPresentation } from 'liti/internal/runtime/presentation'
${
    options.i18n
        ? `import { useTranslation } from '#imports'
import detector from ${JSON.stringify(normalize(resolve(nuxt.options.buildDir, 'liti/locale-detector.mjs')))}
import { createPresentationContext } from 'liti/internal/runtime/presentation'`
        : ''
}
${host.imports.join('\n')}
${namedActions ? "import { executeAction } from 'liti/server'" : ''}
${databaseSchema ? `import * as databaseSchema from ${JSON.stringify(normalize(resolve(nuxt.options.rootDir, databaseSchema.entry)))}` : ''}
import inputConfig from ${JSON.stringify(normalize(configPath))}
import { resolveLitiConfig } from 'liti/internal/config-resolution'
const domainConfig = resolveLitiConfig(inputConfig, ${JSON.stringify(environments)})
configureLitiContext(domainConfig.adapter?.runtime)
import { createRuntime } from 'liti/internal/server'
import { configureLitiRuntime, normalizeLitiAuthorizationError } from 'liti/internal/nuxt/server'
import { captureNitroRequest, getNitroRequest, getNitroContextEvent } from 'liti/internal/runtime/nitro2'

export default defineNitroPlugin((nitroApp) => {
  const hooks = useServerHooks()
  const presentation = ${
      options.i18n
          ? `(locale) => createPresentationContext(getNitroContextEvent(currentLitiContext()), locale, {
    locales: ${JSON.stringify(locales.supported)},
    detect: (event) => detector(event, { defaultLocale: ${JSON.stringify(locales.defaultLocale ?? '')} }),
    translate: useTranslation,
  })`
          : `async (locale = '') => ({ locale, t: () => { throw new Error('[liti] Translated presentation requires Nuxt i18n.') } })`
  }
  /** @type {WeakMap<import('liti/internal/server').LitiDatabase, Promise<import('liti/internal/server').Liti<import('nuxt/server').RequestEvent>>>} */
  const instances = new WeakMap()
  /** @type {WeakMap<object, import('nuxt/server').RequestEvent>} */
  const nativeEvents = new WeakMap()
  const platformFor = (event, context = event?.context ?? currentLitiContext()) => ({ ...context, ${host.platformProperties.join(',\n')} })
  const authorize = async (request, event) => {
    try {
      const input = { request, signal: request.signal, platformContext: platformFor(event) }
      const context = domainConfig.adapter?.runtime ? await domainConfig.adapter.runtime.context(input) : input
      return await domainConfig.adapter?.auth?.authenticate(context) ?? null
    } catch (error) { throw normalizeLitiAuthorizationError(error) }
  }
  const connections = new Map()
  const opened = new Set()
  nitroApp.hooks.hook('close', () => Promise.all([...opened].map(database => database.close?.())))
  const connect = async context => {
    const provider = domainConfig.adapter.database
    if (!provider.connectionKey) return provider.connect(context)
    const key = await provider.connectionKey(context)
    if (!connections.has(key)) {
      const pending = Promise.resolve().then(() => provider.connect(context))
      connections.set(key, pending)
      pending.catch(() => connections.delete(key))
    }
    return connections.get(key)
  }
  nitroApp.hooks.hook('request', (event) => {
    captureNitroRequest(event, ${JSON.stringify(options.server.managementBase)}, ${JSON.stringify(Boolean(domainConfig.assets))})
  })
  /** @param {import('nuxt/server').RequestEvent} [event] @returns {Promise<import('liti/internal/server').Liti<import('nuxt/server').RequestEvent>>} */
  const getLiti = async (event, platformContext) => {
    if (event) nativeEvents.set(event.context, event)
    const context = {
      projectRoot: ${JSON.stringify(nuxt.options.rootDir)},
      environment: ${JSON.stringify(environments)},
      platformContext: platformFor(event, platformContext ?? event?.context ?? currentLitiContext()),
      loadModule: async specifier => {
        ${databaseSchema ? `if (specifier === ${JSON.stringify(databaseSchema.entry)}) return databaseSchema` : ''}
        throw new Error('[liti] No bundled schema module: ' + specifier)
      },
    }
    const database = await connect(context)
    let pending = instances.get(database)
    if (pending) return pending
    opened.add(database)
    pending = (async () => {
    const getStorage = domainConfig.assets && domainConfig.adapter.storage
      ? await domainConfig.adapter.storage.connect(context) : undefined
    const liti = createRuntime({
    authorize,
    presentation,
    afterCommit: (event) => hooks.callHook('liti:entry:committed', event),
    config: { ...domainConfig, assets: ${JSON.stringify(domainConfig.assets)} },
    database,
    ...(getStorage ? { getStorage } : {}),
    ${localizePath}
    managementBase: ${JSON.stringify(options.server.managementBase)},
    publicBase: ${JSON.stringify(options.client.basePath)},
    routing: ${JSON.stringify(options.routing)},
    site: ${JSON.stringify(site)},
    })
    await liti.initialize()
    return liti
    })()
    instances.set(database, pending)
    pending.catch(() => instances.delete(database))
    return pending
  }
  ${
      options.llms
          ? `nitroApp.hooks.hook('llms:generate', async (event, options) => {
    const entries = await withLitiContext(event.context, async () => (await getLiti(nativeEvents.get(event.context))).llmsEntries())
    if (entries.length === 0) return
    options.sections.push({
      links: entries.map(({ content: _, ...entry }) => entry),
      title: 'Site content',
    })
  })
  nitroApp.hooks.hook('llms:generate:full', async (event, _options, contents) => {
    const entries = await withLitiContext(event.context, async () => (await getLiti(nativeEvents.get(event.context))).llmsEntries())
    contents.push(...entries.map((entry) =>
      \`## [\${entry.title}](\${entry.href})\${entry.description ? \`\\n\\n\${entry.description}\` : ''}\${entry.content ? \`\\n\\n\${entry.content}\` : ''}\`,
    ))
  })`
          : ''
  }
  configureLitiRuntime({
    ${nuxt.options.dev ? `development: ${JSON.stringify({ connector: domainConfig.adapter?.database?.id ?? '', devDatabase: true, locales })},` : ''}
    managementBase: ${JSON.stringify(options.server.managementBase)},
    publicBase: ${JSON.stringify(options.client.basePath)},
    tasks: ${JSON.stringify(domainConfig.tasks ?? {})},
    getLiti,
    presentation: async (_event, path) => resolvePublicPresentation(domainConfig, path, await presentation()),
    initializeRequest: (event) => { nativeEvents.set(event.context, event) },
    ${
        namedActions
            ? `executeAction: async (event, name, input) => executeAction(domainConfig, name, input, {
      actor: await authorize?.(event.req, event), request: event.req, platformContext: event.context,
    }),`
            : ''
    }
  })

})
`,
            write: true,
        })
        addServerPlugin(runtimeTemplate.dst)
        const resolver = createResolver(import.meta.url)
        if (options.seo || options.ogImage)
            addServerHandler({
                handler: resolver.resolve('./runtime/presentation-handler'),
                route: `${options.client.basePath}/_presentation`,
            })
        if (cmsConfigured)
            addServerHandler({
                handler: resolver.resolve('./runtime/public-handler'),
                route: `${options.client.basePath}/**`,
            })
        {
            if (namedActions)
                addServerHandler({
                    handler: resolver.resolve('./runtime/action-handler'),
                    route: `${options.server.managementBase}/actions/**`,
                })
            addServerHandler({
                handler: resolver.resolve('./runtime/management-handler'),
                route: `${options.server.managementBase}/**`,
            })
        }
        if (
            nuxt.options.dev &&
            options.devtools &&
            nuxt.options.devtools !== false &&
            (typeof nuxt.options.devtools !== 'object' || nuxt.options.devtools.enabled !== false)
        ) {
            const { setupLitiDevtools } = await import('./devtools')
            await setupLitiDevtools(nuxt)
        }
        addServerImports({ from: 'liti/nuxt/server', name: 'useAdmin' })
        nitro.externals.inline!.push(normalize(runtimeTemplate.dst), normalize(configPath))
    },
})
