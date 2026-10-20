import { defineConfig } from 'vite-plus'

export default defineConfig({
    pack: {
        copy: [{ from: '../../LICENSE', to: '.' }],
        entry: {
            index: 'src/index.ts',
            runtime: 'src/runtime.ts',
            schema: 'src/schema.ts',
            'schema-source': 'src/schema-source.ts',
            connection: 'src/connection.ts',
            native: 'src/native.ts',
        },
        format: ['esm'],
        unbundle: true,
        platform: 'neutral',
        dts: { tsconfig: '../../tsconfig.build.json' },
        deps: { neverBundle: true, onlyImport: ['bun:sqlite', 'liti', 'node:path'] },
        exports: false,
    },
})
