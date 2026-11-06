import { addImports, addComponent, createResolver, defineNuxtModule } from 'nuxt/kit'
import type { NuxtModule } from 'nuxt/schema'
import type { NitroConfig } from 'nitropack'
const module: NuxtModule = defineNuxtModule({
    meta: { name: '@litijs/blog', compatibility: { nuxt: '^4.6.2' } },
    setup(_options, nuxt) {
        nuxt.hook('nitro:config', (input) => {
            const config = input as NitroConfig
            config.externals ??= {}
            config.externals.inline ??= []
            config.externals.inline.push('comark')
        })
        const resolver = createResolver(import.meta.url)
        addImports({ name: 'useArticleReview', from: resolver.resolve('../vue/index') })
        addImports({ name: 'articleDates', from: '@litijs/blog' })
        addImports({ name: 'articleSummary', from: '@litijs/blog' })
        addComponent({ name: 'LitiArticleDate', export: 'ArticleDate', filePath: resolver.resolve('../vue/index') })
    },
})
export default module
