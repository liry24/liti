import type { Nuxt } from 'nuxt/schema'
import { installModule } from 'nuxt/kit'
import generatedPaths from './generated-paths'
import libsqlNative from './libsql-native'
import nitroCache from './nitro-cache'
import schedulePlugin from './schedule-plugin'
import devRuntime from './dev-runtime'

/** Removal contracts and exact upstream versions live in patches/manifest.json. */
export async function registerViteHubWorkarounds(nuxt: Nuxt) {
    for (const module of [generatedPaths, libsqlNative, nitroCache, schedulePlugin, devRuntime])
        await installModule(module, {}, nuxt)
}
