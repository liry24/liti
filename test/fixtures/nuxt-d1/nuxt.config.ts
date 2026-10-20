import { defineNuxtConfig } from 'nuxt/config'
import liti from 'liti/nuxt'
import type { NitroConfig } from 'nitropack/types'

const nitro = { preset: 'cloudflare-module', static: false, cloudflare: { nodeCompat: true } } satisfies NitroConfig

export default defineNuxtConfig({
    devtools: { enabled: false },
    modules: [liti],
    ...{ files: false },
    liti: {
        auth: true,
        i18n: false,
        llms: false,
        ogImage: false,
        robots: false,
        routing: { enabled: false },
        schemaOrg: false,
        seo: false,
        sitemap: false,
    },
    nitro,
})
