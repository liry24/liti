import { defineConfig } from 'vite-plus'

export default defineConfig({
    pack: {
        copy: [{ from: '../../LICENSE', to: '.' }],
        entry: {
            index: 'src/index.ts',
            runtime: 'src/runtime.ts',
            session: 'src/session.ts',
            context: 'src/context.ts',
            files: 'src/files.ts',
            auth: 'src/auth.ts',
            nuxt: 'src/nuxt.ts',
            storage: 'src/storage.ts',
            database: 'src/database.ts',
            schema: 'src/schema.ts',
            tooling: 'src/tooling.ts',
        },
        format: ['esm'],
        unbundle: true,
        platform: 'neutral',
        dts: { tsconfig: '../../tsconfig.build.json' },
        deps: { neverBundle: true },
        exports: false,
    },
})
