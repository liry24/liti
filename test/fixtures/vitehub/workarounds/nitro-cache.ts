import type {} from '@nuxt/nitro-server/augments'
import { fileURLToPath } from 'node:url'
import { defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
    meta: { name: 'liti-probe-vitehub-nitro-cache' },
    setup(_options, nuxt) {
        nuxt.hook('nitro:config', (config) => {
            config.alias ||= {}
            config.alias['nitro/cache'] = fileURLToPath(import.meta.resolve('nitropack/runtime'))
        })
    },
})
