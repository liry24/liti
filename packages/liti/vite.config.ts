import { defineConfig } from 'vite-plus'
import { readFileSync } from 'node:fs'
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
export default defineConfig({
    pack: {
        copy: [
            { from: '../../LICENSE', to: '.' },
            { from: '../../README.md', to: '.' },
            { from: 'src/runtime/admin', to: 'dist/runtime' },
        ],
        entry: {
            index: 'src/public.ts',
            'nuxt/index': 'src/nuxt/index.ts',
            'nuxt/types': 'src/nuxt/types.ts',
            'nuxt/server': 'src/nuxt/server.ts',
            'runtime/server/public.get': 'src/runtime/server/public.get.ts',
            'runtime/server/manage.post': 'src/runtime/server/manage.post.ts',
            'runtime/server/console': 'src/runtime/server/console.ts',
            'runtime/composables/query': 'src/runtime/composables/query.ts',
            'runtime/composables/models': 'src/runtime/composables/models.ts',
            'runtime/composables/session': 'src/runtime/composables/session.ts',
            'runtime/composables/form': 'src/runtime/composables/form.ts',
            'runtime/seo/index': 'src/runtime/seo/index.ts',
        },
        format: ['esm'],
        unbundle: true,
        platform: 'neutral',
        dts: { tsconfig: './tsconfig.pack.json' },
        deps: { neverBundle: [/^#app(?:\/|$)/u, '#liti/runtime'], dts: { neverBundle: true } },
        exports: false,
        plugins: [
            {
                name: 'liti-module-metadata',
                generateBundle() {
                    this.emitFile({
                        type: 'asset',
                        fileName: 'module.json',
                        source: JSON.stringify({
                            name: 'liti',
                            configKey: 'liti',
                            version,
                            compatibility: { nuxt: '^4.6.2' },
                        }),
                    })
                },
            },
        ],
    },
})
