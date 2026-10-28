import { fileURLToPath } from 'node:url'
import viteHubNuxt from 'vite-hub/nuxt'
import generatedPaths from './workarounds/generated-paths'
import libsqlNative from './workarounds/libsql-native'
import nitroCache from './workarounds/nitro-cache'
import schedulePlugin from './workarounds/schedule-plugin'
import devRuntime from './workarounds/dev-runtime'
import { databaseContribution } from './probe-database'

const cloudflare = process.env.LITI_PROBE_PRESET === 'cloudflare'

export default defineNuxtConfig({
    nitro: { prerender: { routes: ['/'] } },
    vite: { plugins: [databaseContribution] },
    compatibilityDate: '2026-10-26',
    modules: [
        [
            viteHubNuxt,
            {
                preset: cloudflare ? 'cloudflare' : 'node',
                auth: true,
                schedule: true,
                console: {
                    auth: 'app',
                    authorize: fileURLToPath(new URL('./server/console-authorize.ts', import.meta.url)),
                },
                database: cloudflare
                    ? {
                          driver: 'd1',
                          binding: 'DB',
                          databaseName: 'liti-vitehub-probe',
                          databaseId: '00000000-0000-4000-8000-000000000010',
                      }
                    : undefined,
            },
        ],
        generatedPaths,
        libsqlNative,
        nitroCache,
        schedulePlugin,
        devRuntime,
    ],
    devtools: { enabled: false },
})
