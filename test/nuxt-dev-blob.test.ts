import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { NitroConfig } from 'nitropack'
import type { Nuxt } from 'nuxt/schema'
import { expect, it, vi } from 'vite-plus/test'
import devBlobBindings from '../packages/liti/src/internal/vitehub-workarounds/dev-blob-bindings'

vi.mock('nuxt/kit', () => ({ defineNuxtModule: (definition: unknown) => definition }))

it('emulates only native R2 contributions and respects user Wrangler configuration', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'liti-dev-blob-'))
    let hook: ((config: NitroConfig) => Promise<void>) | undefined
    const nuxt = {
        options: { dev: true, rootDir: root, buildDir: resolve(root, '.nuxt'), compatibilityDate: '2026-10-26' },
        hook: (_name: string, handler: typeof hook) => {
            hook = handler
        },
    } as unknown as Nuxt
    try {
        ;(devBlobBindings as unknown as { setup(options: object, nuxt: Nuxt): void }).setup({}, nuxt)
        const config: NitroConfig = {
            preset: 'cloudflare-module',
            cloudflare: {
                wrangler: {
                    r2_buckets: [{ binding: 'MEDIA', bucket_name: 'synthetic-media' }],
                    d1_databases: [{ binding: 'DB', database_name: 'synthetic-db', database_id: 'synthetic' }],
                },
            },
        }
        await hook!(config)
        const generated = JSON.parse(await readFile(config.cloudflare!.dev!.configPath!, 'utf8'))
        expect(generated.r2_buckets).toEqual(config.cloudflare!.wrangler!.r2_buckets)
        expect(generated.d1_databases).toBeUndefined()
        const explicit = structuredClone(config)
        explicit.cloudflare!.dev!.configPath = resolve(root, 'custom.json')
        await hook!(explicit)
        expect(explicit.cloudflare!.dev!.configPath).toBe(resolve(root, 'custom.json'))
        await writeFile(resolve(root, 'wrangler.json'), '{}')
        delete config.cloudflare!.dev
        await hook!(config)
        expect(config.cloudflare!.dev).toBeUndefined()
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
