import type { NitroConfig } from 'nitropack'
import { isAbsolute, resolve } from 'node:path'
import { defineNuxtModule } from 'nuxt/kit'

export function normalizeGeneratedPaths(root: string, config: NitroConfig) {
    const normalize = (path: string) =>
        isAbsolute(path) || path.includes('.vitehub') ? resolve(root, path).replaceAll('\\', '/') : path
    if (config.plugins) config.plugins = config.plugins.flatMap((plugin) => (plugin ? [normalize(plugin)] : []))
    for (const handler of config.handlers ?? []) {
        if (handler?.handler) handler.handler = normalize(handler.handler)
    }
}

export default defineNuxtModule({
    meta: { name: 'liti-vitehub-generated-paths' },
    setup(_options, nuxt) {
        nuxt.hook('nitro:build:before', (nitro) =>
            normalizeGeneratedPaths(nuxt.options.rootDir, nitro.options as NitroConfig),
        )
        // Database installs its config hook at modules:done; register after it.
        nuxt.hook('modules:done', () => {
            nuxt.hook('nitro:config', (config) => normalizeGeneratedPaths(nuxt.options.rootDir, config as NitroConfig))
        })
    },
})
