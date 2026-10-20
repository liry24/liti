import { loadNuxtModuleInstance, resolveModuleWithOptions } from 'nuxt/kit'
import type { Nuxt } from 'nuxt/schema'
import { moduleMeta } from '../meta'

/** Respect native module metadata and tuple options, including function/path entries. */
export const litiModuleOptions = async (nuxt: Nuxt) => {
    for (const entry of nuxt.options.modules ?? []) {
        const resolved = resolveModuleWithOptions(entry, nuxt)
        if (!resolved) continue
        const { nuxtModule } = await loadNuxtModuleInstance(resolved.module, nuxt)
        if ((await nuxtModule.getMeta?.())?.name !== moduleMeta.name) continue
        return nuxtModule.getOptions ? await nuxtModule.getOptions(resolved.options, nuxt) : nuxt.options.liti
    }
    return nuxt.options.liti
}
