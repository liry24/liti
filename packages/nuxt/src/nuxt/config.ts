import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createJiti } from 'jiti'
import type { Nuxt } from 'nuxt/schema'
import type { NitroConfig } from 'nitropack/types'
import type { LitiConfigInput } from '../../../liti/src/config'
import { resolveLitiConfig } from '../../../liti/src/config-resolution'

export async function readLitiNuxtConfig(nuxt: Nuxt, filename: string, required: boolean) {
    const configPath = resolve(nuxt.options.rootDir, filename)
    if (!required && !existsSync(configPath)) return undefined
    const environments = (nuxt.options as typeof nuxt.options & { nitro: NitroConfig }).nitro.static
        ? ['production', 'prerender']
        : [nuxt.options.envName || (nuxt.options.dev ? 'development' : 'production')]
    const jiti = createJiti(configPath, { alias: nuxt.options.alias, fsCache: false, moduleCache: false })
    const input = await jiti.import<LitiConfigInput>(configPath, { default: true })
    return { configPath, environments, config: resolveLitiConfig(input, environments) }
}
