import { fileURLToPath } from 'node:url'
import type { DatabaseContributingPlugin } from '@vite-hub/database/vite'
import type { Plugin } from 'vite'

export const databaseContribution: Plugin & DatabaseContributingPlugin = {
    name: 'liti-probe/database-contribution',
    vitehub: {
        databases: [
            {
                name: 'probe-records',
                dialect: 'sqlite',
                definition: {
                    module: fileURLToPath(new URL('./server/database/records.ts', import.meta.url)),
                    export: 'recordsSchema',
                },
            },
        ],
    },
}
