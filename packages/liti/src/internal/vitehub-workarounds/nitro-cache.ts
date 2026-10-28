import type { NitroConfig } from 'nitropack'
import { fileURLToPath } from 'node:url'
import { defineNuxtModule } from 'nuxt/kit'

export default defineNuxtModule({
    meta: { name: 'liti-vitehub-nitro-cache' },
    setup(_options, nuxt) {
        nuxt.hook('nitro:config', (input) => {
            const config = input as NitroConfig
            config.alias ||= {}
            config.alias['nitro/cache'] = fileURLToPath(import.meta.resolve('nitropack/runtime'))
        })
    },
})
