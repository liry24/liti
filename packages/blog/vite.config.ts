import { defineConfig } from 'vite-plus'

export default defineConfig({
    pack: {
        copy: [{ from: '../../LICENSE', to: '.' }],
        entry: {
            index: 'src/index.ts',
            'agents/index': 'src/agents/index.ts',
            'vue/index': 'src/vue/index.ts',
            'nuxt/index': 'src/nuxt/index.ts',
        },
        format: ['esm'],
        unbundle: true,
        platform: 'neutral',
        dts: { tsconfig: './tsconfig.pack.json' },
        deps: { neverBundle: true },
        exports: false,
    },
})
