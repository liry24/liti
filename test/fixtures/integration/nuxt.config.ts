import { fileURLToPath } from 'node:url'
import viteHubNuxt from 'vite-hub/nuxt'
import liti from 'liti/nuxt'
import blog from '@litijs/blog/nuxt'
const cloudflare = process.env.LITI_PROBE_PRESET === 'cloudflare'
export default defineNuxtConfig({
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
        liti,
        blog,
    ],
    devtools: { enabled: false },
})
