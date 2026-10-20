import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadNuxtModuleInstance, resolveModuleWithOptions } from 'nuxt/kit'
import type { Nuxt, NuxtModule } from 'nuxt/schema'

/** Keep Nitro's TS transform active for generated config beneath its cache directory. */
export const allowGeneratedFilesConfig = (exclude: unknown, directory: string): Array<string | RegExp> => {
    const prefix = directory
        .replaceAll('\\', '/')
        .split('/')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('[\\\\/]')
    const patterns = Array.isArray(exclude) ? exclude : [exclude ?? /node_modules/u]
    return patterns.map((pattern: unknown) => {
        if (typeof pattern === 'string') return pattern
        if (pattern instanceof RegExp)
            return new RegExp(`^(?!${prefix}[\\\\/])[\\s\\S]*(?:${pattern.source})`, pattern.flags)
        throw new Error('[liti] Nitro TypeScript exclude filters must be strings or regular expressions.')
    })
}

export async function resolveVoidFilesSource(
    nuxt: Nuxt,
): Promise<{ path: string; module: NuxtModule | string; inline: Record<string, unknown> } | undefined> {
    const topLevel = (nuxt.options as typeof nuxt.options & { files?: { config?: unknown } | false }).files
    if (topLevel === false) return undefined
    let configured: { module: NuxtModule; inline: Record<string, unknown> } | undefined
    for (const entry of nuxt.options.modules ?? []) {
        const resolved = resolveModuleWithOptions(entry, nuxt)
        if (!resolved) continue
        const { nuxtModule } = await loadNuxtModuleInstance(resolved.module, nuxt)
        if ((await nuxtModule.getMeta?.())?.name === 'nuxt-files-sdk') {
            configured = { module: nuxtModule, inline: resolved.options }
            break
        }
    }
    const explicit = configured?.inline.config ?? topLevel?.config
    const native =
        configured && explicit !== undefined ? await configured.module.getOptions?.(configured.inline, nuxt) : undefined
    const filename = native?.config ?? explicit ?? 'files.config.ts'
    if (typeof filename !== 'string' || !filename.trim())
        throw new Error('[liti] Files configuration filename must be a non-empty string.')
    const path = resolve(nuxt.options.rootDir, filename)
    if (!existsSync(path)) {
        if (explicit !== undefined) throw new Error(`[liti] Files configuration file does not exist: ${path}`)
        return undefined
    }
    if (!statSync(path).isFile()) throw new Error(`[liti] Files configuration path must be a file: ${path}`)
    return { path, module: configured?.module ?? 'nuxt-files-sdk', inline: configured?.inline ?? {} }
}
