import { defineConfig } from 'vite-plus'

export default defineConfig({
    pack: {
        copy: [{ from: '../../LICENSE', to: '.' }],
        entry: {
            index: 'src/index.ts',
            content: 'src/content/index.ts',
            records: 'src/records/index.ts',
            'records/schema': 'src/records/schema.ts',
            vite: 'src/vite/index.ts',
        },
        format: ['esm'],
        unbundle: true,
        platform: 'neutral',
        dts: { tsconfig: './tsconfig.json' },
        deps: { neverBundle: true },
        exports: false,
    },
})
