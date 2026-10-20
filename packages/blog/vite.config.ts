import { defineConfig } from 'vite-plus'

export default defineConfig({
    pack: {
        copy: [{ from: '../../LICENSE', to: '.' }],
        entry: { index: 'src/index.ts', vue: 'src/vue.ts' },
        format: ['esm'],
        unbundle: true,
        platform: 'neutral',
        dts: { tsconfig: '../../tsconfig.build.json' },
        deps: { neverBundle: true },
        exports: false,
    },
})
