import type {} from '@nuxt/nitro-server/augments'
import { createRequire } from 'node:module'
import { defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
    meta: { name: 'liti-probe-vitehub-libsql-native' },
    setup(_options, nuxt) {
        if (process.platform !== 'win32' || process.arch !== 'x64') return
        const binding = createRequire(import.meta.url).resolve('@libsql/win32-x64-msvc')
        nuxt.hook('nitro:config', (config) => {
            config.externals ||= {}
            config.externals.traceInclude ||= []
            config.externals.traceInclude.push(binding)
        })
    },
})
