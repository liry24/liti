import type { NitroConfig } from 'nitropack'
import { createRequire } from 'node:module'
import { defineNuxtModule } from 'nuxt/kit'

export default defineNuxtModule({
    meta: { name: 'liti-vitehub-libsql-native' },
    setup(_options, nuxt) {
        if (process.platform !== 'win32' || process.arch !== 'x64') return
        const framework = createRequire(import.meta.resolve('vite-hub'))
        const client = createRequire(framework.resolve('@libsql/client'))
        const binding = createRequire(client.resolve('libsql')).resolve('@libsql/win32-x64-msvc')
        nuxt.hook('nitro:config', (input) => {
            const config = input as NitroConfig
            config.externals ||= {}
            config.externals.traceInclude ||= []
            config.externals.traceInclude.push(binding)
        })
    },
})
