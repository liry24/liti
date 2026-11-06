import { defineNuxtModule } from 'nuxt/kit'
import type { NitroConfig } from 'nitropack'

export default defineNuxtModule({
    meta: { name: 'liti-probe-vitehub-dev-runtime' },
    setup(_options, nuxt) {
        if (!nuxt.options.dev) return
        const generated = nuxt.options.buildDir.replaceAll('\\', '/') + '/vitehub/'
        nuxt.hook('nitro:config', (input) => {
            const config = input as NitroConfig
            config.sourceMap = false
            config.externals ??= {}
            config.externals.inline ??= []
            config.externals.inline.push((id) => id.replaceAll('\\', '/').includes(generated))
        })
    },
})
