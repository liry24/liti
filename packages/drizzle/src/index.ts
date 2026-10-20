import type { DatabaseAdapter } from 'liti/adapter'
import { LitiError } from 'liti/adapter'
import { drizzleKit } from './tooling'
import type { DrizzleToolingOptions } from './tooling'

export interface DrizzleOptions extends DrizzleToolingOptions {
    connection: { driver: 'd1'; binding: string } | { driver: 'bun'; filename: string }
}

/** The declaration loads neither a driver nor an ORM during config evaluation. */
export function drizzle(options: DrizzleOptions): DatabaseAdapter {
    const connection = options?.connection
    if (!connection || !['d1', 'bun'].includes(connection.driver))
        throw new LitiError('LITI_DATABASE_UNSUPPORTED', 'Drizzle supports D1 and Bun SQLite.')
    const target = connection.driver === 'd1' ? connection.binding : connection.filename
    if (typeof target !== 'string' || !target.trim())
        throw new LitiError('LITI_DATABASE_UNSUPPORTED', 'Drizzle requires a non-empty binding or filename.')
    return {
        id: '@litijs/drizzle',
        role: 'database',
        ...(connection.driver === 'bun'
            ? {
                  connectionKey: (context: import('liti/adapter').AdapterContext) =>
                      JSON.stringify([context.projectRoot, connection.filename]),
              }
            : {}),
        schema: {
            generated: options.schema?.generated ?? 'liti-db/liti.ts',
            entry: options.schema?.entry ?? options.schema?.generated ?? 'liti-db/liti.ts',
        },
        tooling: drizzleKit(options),
        async connect(context) {
            return (await import('./runtime')).connectDrizzle(options, context)
        },
    }
}
