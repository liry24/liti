import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { modelDatabaseContribution } from '@litijs/model/vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({
    plugins: [
        vitehub({ preset: 'node', database: true, console: false, agent: false, auth: false, schedule: false }),
        modelDatabaseContribution({
            module: fileURLToPath(new URL('./server/models/definitions.ts', import.meta.url)),
            export: 'tables',
        }),
    ],
})
