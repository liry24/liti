import { resolve } from 'node:path'
import { defineNuxtModule, installModule } from 'nuxt/kit'
import type { NitroConfig } from 'nitropack/types'
import { voidPlugin } from 'void'
import { createJiti } from 'jiti'
import type { LitiConfig } from 'liti/adapter'
import { resolveLitiConfig } from 'liti'
import type {} from 'liti/nuxt'
import { setupNuxtAuth } from './nuxt-auth'
import { resolveVoidFilesSource, allowGeneratedFilesConfig } from './nuxt-files'
import { resolveLitiAssets } from './assets-config'
import type { FilesEnvironmentConfig } from 'nuxt-files-sdk/config'

interface Options {
    config: LitiConfig
    environments: string[]
    auth: boolean
}

export default defineNuxtModule<Options>({
    meta: { name: '@litijs/void/nuxt', configKey: 'litiVoid' },
    async setup(options, nuxt) {
        const config = options.config
        const nativeAuth = options.auth && config.adapter?.auth?.id === '@litijs/void/auth'
        const contentDatabase = config.adapter?.database?.id === '@litijs/void/database'
        const runtime = config.adapter?.runtime?.id === '@litijs/void/runtime'
        const nitro = (nuxt.options as unknown as { nitro: NitroConfig }).nitro
        if (runtime || contentDatabase || nativeAuth) {
            nitro.modules ??= []
            if (!nitro.modules.includes('void/nitro')) nitro.modules.push('void/nitro')
            nitro.preset ??= 'cloudflare-module'
            nitro.cloudflare ??= {}
            nitro.cloudflare.dev ??= { configPath: './.void-wrangler.jsonc' }
            nuxt.options.vite.plugins ??= []
            // Void's synchronous factory captures cwd rather than the Vite project root.
            const directory = process.cwd()
            try {
                process.chdir(nuxt.options.rootDir)
                nuxt.options.vite.plugins.push(voidPlugin() as NonNullable<typeof nuxt.options.vite.plugins>[number])
            } finally {
                process.chdir(directory)
            }
            nuxt.options.alias['@schema'] = resolve(
                nuxt.options.rootDir,
                contentDatabase ? config.adapter!.database!.schema!.entry : 'db/schema.ts',
            )
        }
        if (nativeAuth) {
            setupNuxtAuth(nuxt, config)
            await installModule('@nuxtjs/better-auth', {}, nuxt)
            nuxt.hook('liti:host', (host) => {
                host.imports.push("import { getRequestSession } from '#imports'")
                host.platformProperties.push(`authenticate: async () => {
                    if (!event) return null
                    const session = await getRequestSession(getNitroRequest(event))
                    if (!session) return null
                    const roles = typeof session.user.role === 'string' ? session.user.role.split(',').map(role => role.trim()).filter(Boolean) : []
                    const authorized = { actor: { id: session.user.id, roles }, event, session }
                    await hooks.callHook('liti:authorize', authorized)
                    return authorized.actor
                }`)
            })
        }
        if (config.adapter?.storage?.id === '@litijs/void/storage' && config.assets) {
            const selected = await resolveVoidFilesSource(nuxt)
            if (!selected) return
            await installModule(selected.module, { ...selected.inline, config: selected.path }, nuxt)
            const files = await createJiti(selected.path, {
                fsCache: false,
                moduleCache: false,
                alias: nuxt.options.alias,
            }).import<FilesEnvironmentConfig>(selected.path, { default: true })
            const resolvedFiles = resolveLitiConfig({ ...files, models: {} }, options.environments)
            const unnamed = Boolean(resolvedFiles.storage && 'adapter' in resolvedFiles.storage)
            nuxt.hook('liti:config', (domain) => {
                if (domain.assets) domain.assets = resolveLitiAssets(domain.assets, resolvedFiles)!
            })
            nuxt.hook('liti:host', (host) => {
                host.imports.push("import { useServerFiles } from 'nuxt-files-sdk/runtime'")
                host.platformProperties.push(
                    unnamed
                        ? `files: async name => { if (name !== 'default') throw new Error('[liti] Unknown Files storage: ' + name); return useServerFiles() }`
                        : 'files: async name => useServerFiles(name)',
                )
            })
            nuxt.hook('prepare:types', ({ tsConfig }) => {
                ;(tsConfig.include ??= []).push(selected.path)
            })
            if (nuxt.options.dev) nuxt.options.watch.push(selected.path)
            nuxt.hook('nitro:config', (native) => {
                const config = native as NitroConfig
                config.esbuild ??= {}
                config.esbuild.options ??= {}
                config.esbuild.options.exclude = allowGeneratedFilesConfig(
                    config.esbuild.options.exclude,
                    resolve(config.buildDir ?? nuxt.options.buildDir, 'nuxt-files-sdk'),
                )
            })
        }
    },
})
