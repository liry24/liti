import type { DatabaseContributingPlugin } from '@vite-hub/database/vite'
import { generatedPaths } from '../internal/vitehub-workarounds/generated-paths'

/** Contribute the application's generated native record schema to the official Database pipeline. */
export function modelDatabaseContribution(definition: {
    module: string
    export: string
}): DatabaseContributingPlugin & { name: string } {
    const plugin = {
        name: 'liti-model/database',
        ...generatedPaths(),
        configEnvironment(_name: string, config: { consumer?: string; resolve?: { noExternal?: unknown } }) {
            if (config.consumer === 'client' || config.resolve?.noExternal === true) return
            return { resolve: { noExternal: ['@litijs/model'] } }
        },
        vitehub: { databases: [{ name: 'liti-models', dialect: 'sqlite' as const, definition }] },
    }
    return plugin
}
