import type { LitiAdapter, DatabaseAdapter } from 'liti/adapter'

export interface VoidDatabaseOptions {
    schema?: { generated?: string; entry?: string }
}

export function voidDatabase(options: VoidDatabaseOptions = {}): DatabaseAdapter {
    const generated = options.schema?.generated ?? 'db/schema.ts'
    const schema = { generated, entry: options.schema?.entry ?? generated }
    return {
        id: '@litijs/void/database',
        role: 'database',
        hosts: { nuxt: '@litijs/void/nuxt' },
        schema,
        async connect(context) {
            return (await import('./runtime')).connectDatabase(context, schema.entry)
        },
        tooling: {
            async generate(config, context) {
                return (await import('./tooling')).generate(config, context, schema)
            },
        },
    }
}

/** Each replacement owns its entire role, including the database's generation tooling. */
export function voidAdapter(overrides: LitiAdapter = {}): LitiAdapter {
    return {
        runtime: {
            id: '@litijs/void/runtime',
            role: 'runtime',
            hosts: { nuxt: '@litijs/void/nuxt' },
            context: (context) => context,
            async run(context, operation) {
                return (await import('./context')).withVoidContext(context.platformContext, operation)
            },
        },
        database: voidDatabase(),
        storage: {
            id: '@litijs/void/storage',
            role: 'storage',
            hosts: { nuxt: '@litijs/void/nuxt' },
            defaultStorage: 'content',
            async connect(context) {
                return (await import('./runtime-storage')).connectStorage(context)
            },
        },
        auth: {
            id: '@litijs/void/auth',
            role: 'auth',
            hosts: { nuxt: '@litijs/void/nuxt' },
            async authenticate(context) {
                return (await import('./runtime-auth')).authenticate(context)
            },
        },
        ...overrides,
    }
}
