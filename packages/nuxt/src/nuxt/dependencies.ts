import { resolve } from 'node:path'
import { tryResolveModule, directoryToURL } from 'nuxt/kit'
import type { Nuxt, NuxtImport, ModuleDependencies } from 'nuxt/schema'
import { litiModuleOptions } from './module-options'
import type { ModuleOptions } from '../index'
import { preparePresentation } from './presentation'
import { readLitiNuxtConfig } from './config'

const prepared = new WeakSet<Nuxt>()
const modules = {
    i18n: '@nuxtjs/i18n',
    schemaOrg: 'nuxt-schema-org',
    llms: 'nuxt-llms',
    seo: 'nuxt-seo-utils',
    sitemap: '@nuxtjs/sitemap',
    robots: '@nuxtjs/robots',
    ogImage: 'nuxt-og-image',
} as const

/** Prepare/build never installs dependencies or changes the application's manifest. */
export const ensureLitiDependencies = async (nuxt: Nuxt, names: string[]) => {
    const roots = [nuxt.options.rootDir, ...nuxt.options.modulesDir.map((directory) => resolve(directory, '..'))].map(
        directoryToURL,
    )
    const resolved = await Promise.all(names.map(async (name) => ({ name, path: await tryResolveModule(name, roots) })))
    const missing = resolved.filter(({ path }) => !path).map(({ name }) => name)
    if (missing.length)
        throw new Error(
            `[liti] Missing dependencies: ${missing.join(', ')}. Install them explicitly before prepare/build.`,
        )
}

export const litiModuleDependencies = async (nuxt: Nuxt): Promise<ModuleDependencies> => {
    const options = (await litiModuleOptions(nuxt)) as ModuleOptions
    if (options.enabled === false) return {}
    const declaration = await readLitiNuxtConfig(nuxt, options.configFile, options.server?.enabled !== false)
    if (options.auth !== false && !prepared.has(nuxt)) {
        prepared.add(nuxt)
        // Better Auth's imports arrive after Nuxt's initial scan.
        nuxt.hook('imports:context', (ctx) => {
            const stop = nuxt.hooks.afterEach(async ({ name }) => {
                if (name !== 'modules:done') return
                stop()
                await ctx.modifyDynamicImports(async (imports) => {
                    const additions: NuxtImport[] = []
                    await nuxt.callHook('imports:extend', additions)
                    for (const item of additions)
                        if (
                            !imports.some(
                                (existing) =>
                                    existing.name === item.name &&
                                    existing.as === item.as &&
                                    existing.from === item.from,
                            )
                        )
                            imports.push(item)
                })
            })
        })
    }
    const dependencies: ModuleDependencies = {}
    const names: string[] = []
    if (options.server?.enabled !== false && declaration)
        for (const provider of Object.values(declaration.config.adapter ?? {})) {
            const host = provider?.hosts?.nuxt
            if (!host || dependencies[host]) continue
            dependencies[host] = {
                defaults: { config: declaration.config, environments: declaration.environments, auth: options.auth },
            }
            names.push(host)
        }
    for (const [flag, name] of Object.entries(modules) as Array<[keyof typeof modules, string]>) {
        if (!options[flag]) continue
        dependencies[name] = {}
        names.push(name)
    }
    if (options.markdown) names.push('comark')
    if (options.ogImage) names.push('@takumi-rs/core', '@takumi-rs/wasm')
    if (['schemaOrg', 'seo', 'sitemap', 'robots', 'ogImage'].some((flag) => options[flag as keyof ModuleOptions])) {
        names.push('nuxt-site-config')
        dependencies['nuxt-site-config'] = {}
    }
    await ensureLitiDependencies(nuxt, [...new Set(names)])
    if (options.i18n && options.server?.enabled !== false) await preparePresentation(nuxt)
    return dependencies
}
