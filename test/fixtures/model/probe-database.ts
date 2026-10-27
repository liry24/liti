import { fileURLToPath } from 'node:url'
import { modelDatabaseContribution } from '@litijs/model/vite'

export const databaseContribution = modelDatabaseContribution({
    module: fileURLToPath(new URL('./server/models/definitions.ts', import.meta.url)),
    export: 'tables',
})
