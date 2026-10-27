import type { DatabaseContributingPlugin } from '@vite-hub/database/vite'

/** Contribute the application's generated native record schema to the official Database pipeline. */
export function modelDatabaseContribution(definition: {
    module: string
    export: string
}): DatabaseContributingPlugin & { name: string } {
    return {
        name: 'liti-model/database',
        vitehub: { databases: [{ name: 'liti-models', dialect: 'sqlite', definition }] },
    }
}
