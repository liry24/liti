import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineNuxtModule } from 'nuxt/kit'
import type { NitroConfig } from 'nitropack'

export default defineNuxtModule({
    meta: { name: 'liti-vitehub-dev-blob-bindings' },
    setup(_options, nuxt) {
        if (!nuxt.options.dev) return
        nuxt.hook('nitro:config', async (input) => {
            const config = input as NitroConfig
            if (typeof config.preset !== 'string' || !config.preset.startsWith('cloudflare')) return
            const cloudflare = config.cloudflare,
                buckets = cloudflare?.wrangler?.r2_buckets
            if (!buckets?.length || cloudflare?.dev?.configPath) return
            if (
                ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'].some((file) =>
                    existsSync(resolve(nuxt.options.rootDir, file)),
                )
            )
                return
            const file = resolve(nuxt.options.buildDir, 'vitehub-blob-wrangler.json')
            // Native Nuxt dev Database migrations target SQLite; only Blob needs these emulated bindings.
            const source = JSON.stringify(
                {
                    name: 'liti-local-blob',
                    compatibility_date:
                        typeof nuxt.options.compatibilityDate === 'string'
                            ? nuxt.options.compatibilityDate
                            : '2026-10-26',
                    compatibility_flags: cloudflare?.wrangler?.compatibility_flags,
                    r2_buckets: buckets,
                },
                null,
                2,
            )
            await mkdir(nuxt.options.buildDir, { recursive: true })
            if (
                (await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== 'ENOENT') throw error
                    return null
                })) !== source
            )
                await writeFile(file, source)
            config.cloudflare ??= {}
            config.cloudflare.dev ??= {}
            config.cloudflare.dev.configPath = file
        })
    },
})
