import { bindings, defineConfig } from 'cf/config'

export default defineConfig({
    worker: {
        name: 'liti-d1-test',
        compatibilityDate: '2026-09-14',
        compatibilityFlags: ['nodejs_compat'],
        entrypoint: 'worker.ts',
        env: {
            LITI_DB: bindings.d1({
                name: 'liti-test',
                id: '00000000-0000-4000-8000-000000000001',
            }),
            ASSETS: bindings.r2({
                name: 'liti-test-assets',
            }),
            DRAFT_ASSETS: bindings.r2({
                name: 'liti-test-draft-assets',
            }),
        },
    },
})
