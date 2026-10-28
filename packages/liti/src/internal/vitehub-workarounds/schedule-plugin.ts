import type { NitroConfig } from 'nitropack'
import { defineNuxtModule } from 'nuxt/kit'

export function transformSchedulePlugin(code: string, id: string) {
    if (!id.replaceAll('\\', '/').endsWith('/.vitehub/nitro/schedule/plugin.ts')) return
    return code.replace(
        "import { definePlugin } from 'nitro'",
        "import { defineNitroPlugin as definePlugin } from 'nitropack/runtime'",
    )
}

export default defineNuxtModule({
    meta: { name: 'liti-vitehub-schedule-plugin' },
    setup(_options, nuxt) {
        nuxt.hook('nitro:config', (input) => {
            const config = input as NitroConfig
            config.rollupConfig ||= {}
            config.rollupConfig.plugins ||= []
            config.rollupConfig.plugins.push({
                name: 'liti-vitehub-schedule-plugin',
                transform: transformSchedulePlugin,
            })
        })
    },
})
