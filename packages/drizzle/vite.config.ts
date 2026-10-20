import { defineConfig } from 'vite-plus'

export default defineConfig({
    pack: {
        entry: { index: 'src/index.ts', runtime: 'src/runtime.ts', schema: 'src/schema.ts', tooling: 'src/tooling.ts' },
        format: ['esm'],
        unbundle: true,
        platform: 'neutral',
        dts: { tsconfig: '../../tsconfig.build.json' },
        deps: { neverBundle: true, onlyImport: ['bun:sqlite', 'liti', '@litijs/sqlite', 'drizzle-orm', 'node:path'] },
        exports: false,
    },
})
