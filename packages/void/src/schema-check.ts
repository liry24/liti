import type { DrizzleConnection as Database } from './database'
import { getTableColumns } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import type { LitiConfig } from 'liti/adapter'
import { LitiError } from 'liti/adapter'
import { contentTableName, fieldStorage, validateContentNames, physicalSchema } from '@litijs/sqlite/schema'
import { assertSqliteSchema } from '@litijs/sqlite/storage'
import { queryRows } from './d1-connection'

export function contentTables(database: Database, config: LitiConfig) {
    validateContentNames(config)
    return Object.fromEntries(
        Object.entries(config.models).map(([name, model]) => {
            const table = database.tables.get(contentTableName(name))
            if (!table) throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', `Missing generated table for Model "${name}".`)
            const columns = getTableColumns(table)
            if (columns.revisionId?.name !== 'revision_id' || !columns.revisionId.primary)
                throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', `Regenerate the schema for Model "${name}".`)
            for (const [key, field] of Object.entries(model.fields)) {
                const column = columns[key],
                    storage = fieldStorage(field)
                const type = storage === 'json' ? 'text' : storage === 'boolean' ? 'integer' : storage
                const dataType =
                    storage === 'json'
                        ? 'json'
                        : storage === 'boolean'
                          ? 'boolean'
                          : storage === 'text'
                            ? 'string'
                            : storage === 'integer'
                              ? 'number'
                              : 'number'
                if (
                    !column ||
                    column.name !== `field_${key}` ||
                    column.getSQLType() !== type ||
                    column.dataType !== dataType ||
                    column.notNull !== Boolean(field.required)
                )
                    throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', `Regenerate the schema for "${name}.${key}".`)
            }
            return [name, table]
        }),
    )
}

/** ORM declarations and the native database must describe the same selected schema. */
export const assertLitiSchema = async (database: Database, config: LitiConfig): Promise<void> => {
    contentTables(database, config)
    for (const table of Object.values(physicalSchema(config))) {
        const supplied = database.tables.get(table.name)
        if (
            !supplied ||
            Object.values(table.columns).some((column) => {
                const actual = getTableConfig(supplied).columns.find((item) => item.name === column.name)
                return (
                    !actual ||
                    actual.getSQLType() !== column.type ||
                    actual.notNull !== Boolean(column.notNull || column.primary) ||
                    actual.primary !== Boolean(column.primary)
                )
            })
        )
            throw new LitiError(
                'LITI_SCHEMA_INCOMPATIBLE',
                `Missing or incompatible generated schema table "${table.name}".`,
            )
    }
    await assertSqliteSchema(
        {
            query: (sql, params) => queryRows(database, sql, params),
            atomic: async () => {
                throw new Error('Schema validation is read-only.')
            },
        },
        config,
    )
}
