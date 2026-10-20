import { defineConfig } from 'vite-plus'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { moduleMeta } from '../nuxt/src/meta.ts'
import { bundledLicenses } from '../../scripts/bundled-licenses.ts'

const manifest: { version: string } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
const bridgeDependencies = [
    /^@tanstack\//u,
    'vue-demi',
    '@nuxt/devtools-kit',
    '@nuxt/kit',
    'devframe',
    'h3',
    'nostics',
    'tinyexec',
    'crossws',
    'srvx',
    'pathe',
    'ufo',
    'cookie-es',
    'iron-webcrypto',
    'radix3',
    'defu',
    'destr',
    'uncrypto',
    /^node-mock-http(?:\/|$)/u,
]
const formRequire = createRequire(new URL('../vue/package.json', import.meta.url))
const formOwner = createRequire(formRequire.resolve('@tanstack/vue-form/package.json'))
const formAliases = Object.fromEntries(
    ['@tanstack/vue-form', '@tanstack/vue-store'].map((name) => [
        name,
        resolve(dirname(formOwner.resolve(`${name}/package.json`)), 'dist/index.js'),
    ]),
)

export default defineConfig({
    pack: [
        {
            clean: true,
            alias: formAliases,
            copy: [
                { from: '../../LICENSE', to: '.' },
                { from: '../../README.md', to: '.' },
                { from: '../nuxt/src/devtools/client/index.html', to: 'dist/devtools/client' },
            ],
            deps: {
                dts: {
                    neverBundle: true,
                    alwaysBundle: [
                        ...bridgeDependencies.filter((name) => name !== 'h3'),
                        'comark-content',
                        'unstorage',
                        'hookable',
                    ],
                },
                neverBundle: true,
                alwaysBundle: bridgeDependencies,
                onlyImport: [
                    /^node:/u,
                    /^@litijs\/void(?:\/|$)/u,
                    '@noble/hashes',
                    'liti/adapter',
                    'nuxt',
                    'nypm',
                    /^#app(?:\/|$)/u,
                    '@nuxt/schema',
                    '@nuxtjs/better-auth',
                    '@better-auth/drizzle-adapter',
                    '@standard-schema/spec',
                    '@tanstack/vue-form',
                    'better-auth',
                    'ai',
                    'comark',
                    'comark-content',
                    'drizzle-orm',
                    'drizzle-kit',
                    'devframe',
                    '@nuxt/devtools-kit',
                    'files-sdk',
                    'h3',
                    'jiti',
                    'nuxt-files-sdk',
                    'nuxt-llms',
                    'pathe',
                    'node:path',
                    'node:crypto',
                    'node:stream',
                    'node:async_hooks',
                    'node:url',
                    'node:fs/promises',
                    'node:fs',
                    'node:util',
                    'node:module',
                    'nitropack',
                    'rou3',
                    'vue',
                    'void',
                    'auth',
                ],
            },
            dts: { tsconfig: '../../tsconfig.build.json' },
            entry: {
                adapter: 'src/adapter.ts',
                tooling: 'src/tooling.ts',
                client: 'src/client.ts',
                'public-client': 'src/public-client.ts',
                'admin-client': 'src/admin-client.ts',
                descriptor: 'src/descriptor.ts',
                'server-api': '../nuxt/src/server-api.ts',
                'config-resolution': 'src/config-resolution.ts',
                form: '../vue/src/form.ts',
                vue: '../vue/src/index.ts',
                config: 'src/config.ts',
                model: '../vue/src/model.ts',
                index: 'src/index.ts',
                nuxt: '../nuxt/src/index.ts',
                'nuxt/server': '../nuxt/src/nuxt/server.ts',
                'runtime/nitro2': '../nuxt/src/runtime/nitro2.ts',
                'runtime/composables': '../nuxt/src/runtime/composables.ts',
                'runtime/seo': '../nuxt/src/runtime/seo.ts',
                'runtime/context': '../nuxt/src/runtime/context.ts',
                'runtime/presentation': '../nuxt/src/runtime/presentation.ts',
                'runtime/presentation-handler': '../nuxt/src/runtime/presentation-handler.ts',
                'runtime/tasks': '../nuxt/src/runtime/tasks.ts',
                'runtime/tasks/publish-due': '../nuxt/src/runtime/tasks/publish-due.ts',
                'runtime/tasks/asset-gc': '../nuxt/src/runtime/tasks/asset-gc.ts',
                'runtime/tasks/sync-assets': '../nuxt/src/runtime/tasks/sync-assets.ts',
                'runtime/tasks/rebuild-search': '../nuxt/src/runtime/tasks/rebuild-search.ts',
                'runtime/database-middleware': '../nuxt/src/runtime/database-middleware.ts',
                'devtools/index': '../nuxt/src/devtools/index.ts',
                'devtools/dock': '../nuxt/src/devtools/dock.ts',
                'runtime/devtools-snapshot': '../nuxt/src/runtime/devtools-snapshot.ts',
                server: 'src/server/index.ts',
                seo: 'src/seo.ts',
                'runtime/management-handler': '../nuxt/src/runtime/management-handler.ts',
                'runtime/action-handler': '../nuxt/src/runtime/action-handler.ts',
                'runtime/public-handler': '../nuxt/src/runtime/public-handler.ts',
            },
            exports: false,
            format: ['esm'],
            platform: 'neutral',
            sourcemap: false,
            unbundle: false,
            treeshake: { moduleSideEffects: (id) => !id.startsWith('unstorage/drivers/') },
            plugins: [
                bundledLicenses(),
                {
                    name: 'public-host-modules',
                    resolveId(id) {
                        if (id === '@nuxt/kit') return { id: 'nuxt/kit', external: true }
                        if (id === 'vue-demi') return { id: 'vue', external: true }
                    },
                },
                {
                    name: 'nuxt-module-metadata',
                    generateBundle() {
                        this.emitFile({
                            type: 'asset',
                            fileName: 'module.json',
                            source: JSON.stringify({ ...moduleMeta, version: manifest.version }, null, 2) + '\n',
                        })
                    },
                },
            ],
        },
        {
            entry: { cli: '../cli/src/index.ts' },
            format: 'esm',
            platform: 'node',
            dts: false,
            clean: false,
            sourcemap: false,
            deps: { neverBundle: true },
        },
        {
            entry: { app: '../nuxt/src/devtools/client/app.ts' },
            outDir: 'dist/devtools/client',
            format: 'esm',
            platform: 'browser',
            dts: false,
            clean: false,
            minify: true,
            plugins: [bundledLicenses()],
            sourcemap: false,
            deps: {
                alwaysBundle: [/^(?:birpc|devframe|nostics|p-map|ufo)(?:\/|$)/u],
                onlyBundle: [/^(?:birpc|devframe|nostics|p-map|ufo)(?:\/|$)/u],
            },
        },
    ],
})
