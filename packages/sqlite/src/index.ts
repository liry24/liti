import type { DatabaseAdapter, DatabaseTooling } from 'liti/adapter'
import { LitiError } from 'liti/adapter'

export interface SqliteOptions {
    driver: 'bun'
    filename: string
    tooling?: DatabaseTooling
}

/** Configuration is portable; the native driver is resolved only when connecting. */
export function sqlite(options: SqliteOptions): DatabaseAdapter {
    if (options.driver !== 'bun' || typeof options.filename !== 'string' || !options.filename.trim())
        throw new LitiError('LITI_DATABASE_UNSUPPORTED', 'SQLite requires driver "bun" and a non-empty filename.')
    return {
        id: '@litijs/sqlite',
        role: 'database',
        connectionKey: (context) => JSON.stringify([context.projectRoot, options.filename]),
        ...(options.tooling ? { tooling: options.tooling } : {}),
        async connect(context) {
            const { connectSqlite } = await import('./runtime')
            return connectSqlite(options, context)
        },
    }
}
