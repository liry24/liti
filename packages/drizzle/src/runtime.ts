import type { AdapterContext, LitiConfig, LitiDatabase } from 'liti/adapter'
import { LitiError } from 'liti/adapter'
import { createD1Connection, createSqliteDatabase } from '@litijs/sqlite/storage'
import type { D1Binding } from '@litijs/sqlite/storage'
import { createNativeSqliteDatabase } from '@litijs/sqlite/native'
import { physicalSchema } from '@litijs/sqlite/schema'
import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { npmVersion } from 'drizzle-orm/version'
import type { DrizzleOptions } from './index'
import { drizzleVersion } from './tooling'

export function validateDrizzleSchema(schema: Record<string, unknown>, config: LitiConfig): void {
    if (npmVersion !== drizzleVersion)
        throw new LitiError('LITI_DATABASE_UNSUPPORTED', `Expected Drizzle ${drizzleVersion}; received ${npmVersion}.`)
    if (schema.litiSchemaOwner !== `@litijs/drizzle:${drizzleVersion}`)
        throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', 'Regenerate the schema with the selected Drizzle tooling.')
    const tables = new Map<string, SQLiteTable>()
    for (const value of Object.values(schema)) {
        if (!is(value, SQLiteTable)) continue
        const name = getTableName(value)
        if (tables.has(name) && tables.get(name) !== value)
            throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', `Duplicate schema table "${name}".`)
        tables.set(name, value)
    }
    for (const expected of Object.values(physicalSchema(config))) {
        const table = tables.get(expected.name)
        if (!table) throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', `Missing Drizzle table "${expected.name}".`)
        const columns = new Map(Object.values(getTableColumns(table)).map((column) => [column.name, column]))
        for (const field of Object.values(expected.columns)) {
            const column = columns.get(field.name)
            if (
                !column ||
                column.getSQLType() !== field.type ||
                (field.notNull && !column.notNull) ||
                (field.primary && !column.primary) ||
                (field.mode === 'json' && column.dataType !== 'object json') ||
                (field.mode === 'boolean' && column.dataType !== 'boolean')
            )
                throw new LitiError(
                    'LITI_SCHEMA_INCOMPATIBLE',
                    `Incompatible Drizzle column "${expected.name}.${field.name}".`,
                )
        }
    }
}

export const createDrizzleDatabase = <Database extends LitiDatabase>(
    database: Database,
    schema: Record<string, unknown>,
): Database => ({
    ...database,
    bind(config) {
        validateDrizzleSchema(schema, config)
        return database.bind(config)
    },
})

const d1Connections = new WeakMap<object, WeakMap<object, Promise<LitiDatabase>>>()

export async function connectDrizzle(options: DrizzleOptions, context: AdapterContext): Promise<LitiDatabase> {
    const entry = options.schema?.entry ?? options.schema?.generated ?? 'liti-db/liti.ts'
    const schema = await context.loadModule?.(entry)
    if (!schema)
        throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', `The host must supply the Drizzle schema module "${entry}".`)
    if (options.connection.driver === 'd1') {
        const platform = context.platformContext as
            | { cloudflare?: { env?: Record<string, unknown> }; env?: Record<string, unknown> }
            | undefined
        const env = platform?.cloudflare?.env ?? platform?.env
        const binding = env?.[options.connection.binding] as D1Binding | undefined
        if (!binding || typeof binding.prepare !== 'function' || typeof binding.batch !== 'function')
            throw new LitiError('LITI_DATABASE_UNSUPPORTED', `Missing D1 binding "${options.connection.binding}".`)
        if (options.connection.binding !== 'DB' && binding === env?.DB)
            throw new LitiError(
                'LITI_DATABASE_UNSUPPORTED',
                'Independent Drizzle and Void must use distinct physical databases.',
            )
        let schemas = d1Connections.get(binding)
        if (!schemas) d1Connections.set(binding, (schemas = new WeakMap()))
        let pending = schemas.get(schema)
        if (!pending) {
            pending = import('drizzle-orm/d1').then(({ drizzle }) => {
                const database = drizzle(binding as Parameters<typeof drizzle>[0])
                return createDrizzleDatabase(
                    createSqliteDatabase(createD1Connection(database.$client as unknown as D1Binding)),
                    schema,
                )
            })
            schemas.set(schema, pending)
            void pending.catch(() => schemas!.delete(schema))
        }
        return pending
    }
    const [{ Database }, { drizzle }, { resolve }] = await Promise.all([
        import('bun:sqlite'),
        import('drizzle-orm/bun-sqlite'),
        import('node:path'),
    ])
    const filename =
        options.connection.filename === ':memory:'
            ? ':memory:'
            : resolve(context.projectRoot, options.connection.filename)
    const native = new Database(filename, { create: true, strict: true })
    const database = drizzle({ client: native })
    return createDrizzleDatabase(
        { ...createNativeSqliteDatabase(database.$client), close: () => native.close() },
        schema,
    )
}
