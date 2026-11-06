import type {} from '@nuxt/nitro-server/augments'
import { defineNuxtModule } from '@nuxt/kit'

export function transformSchedulePlugin(code: string, id: string) {
    if (!id.replaceAll('\\', '/').endsWith('/.vitehub/nitro/schedule/plugin.ts')) return
    return code.replace(
        "import { definePlugin } from 'nitro'",
        "import { defineNitroPlugin as definePlugin } from 'nitropack/runtime'",
    )
}

export default defineNuxtModule({
    meta: { name: 'liti-probe-vitehub-schedule-plugin' },
    setup(_options, nuxt) {
        nuxt.hook('nitro:config', (config) => {
            config.rollupConfig ||= {}
            config.rollupConfig.plugins ||= []
            config.rollupConfig.plugins.push({
                name: 'liti-probe-vitehub-schedule-plugin',
                transform: transformSchedulePlugin,
            })
        })
    },
})
