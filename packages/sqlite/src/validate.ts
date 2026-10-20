import { LitiError, type LitiConfig } from 'liti/adapter'
import type { SqliteConnection } from './statements'
import { physicalSchema } from './schema'

const nullDefault = (value: string | null): boolean =>
    value === null || value.replace(/[\s()]/gu, '').toLowerCase() === 'null'

type NativeSchemaRow =
    | {
          kind: 'column'
          tableName: string
          name: string
          type: string
          notnull: number
          pk: number
          dflt_value: string | null
          indexName: null
      }
    | {
          kind: 'index'
          tableName: string
          name: string | null
          type: null
          notnull: null
          pk: null
          dflt_value: null
          indexName: string
      }

/** Read-only check: migrations are generated and applied outside the runtime. */
export const assertSqliteSchema = async (database: SqliteConnection, config: LitiConfig): Promise<void> => {
    const tables = Object.values(physicalSchema(config))
    // Table-valued PRAGMAs keep all read-only compatibility checks in one native snapshot/call.
    const nativeRows = (await database.query(
        `WITH names AS (SELECT value FROM json_each(?))
        SELECT 'column' AS kind,t.value AS tableName,p.name,p.type,p."notnull" AS "notnull",p.pk,p.dflt_value,NULL AS indexName FROM names t JOIN pragma_table_info(t.value) p
        UNION ALL SELECT 'index',t.value,p.name,NULL,NULL,NULL,NULL,i.name FROM names t JOIN pragma_index_list(t.value) i JOIN pragma_index_info(i.name) p WHERE i."unique"=1`,
        [JSON.stringify(tables.map((table) => table.name))],
    )) as NativeSchemaRow[]
    for (const table of tables) {
        const expected = table
        const required = Object.values(table.columns)
        const columns = nativeRows
            .filter((row) => row.kind === 'column')
            .filter((row) => row.tableName === expected.name)
        if (
            required.some((column) => {
                const actual = columns.find((item) => item.name === column.name)
                return (
                    !actual ||
                    actual.type.toLowerCase() !== column.type ||
                    (column.notNull && !actual.notnull && !actual.pk) ||
                    (!column.notNull && !column.primary && Boolean(actual.notnull)) ||
                    (column.primary && !actual.pk)
                )
            }) ||
            columns.some(
                (column) =>
                    !required.some((item) => item.name === column.name) &&
                    (column.pk || (column.notnull && nullDefault(column.dflt_value))),
            )
        )
            throw new LitiError(
                'LITI_MIGRATION_REQUIRED',
                `Database table "${expected.name}" does not match the generated schema. Generate and apply migrations explicitly.`,
            )
        // A retained UNIQUE key must be safe for every active-column insert.
        // Do not infer safety from partial predicates or nonconstant default expressions.
        const indexes = nativeRows
            .filter((row) => row.kind === 'index')
            .filter((row) => row.tableName === expected.name)
        for (const indexName of new Set(indexes.map((row) => row.indexName))) {
            const indexed = indexes.filter((row) => row.indexName === indexName)
            const retained = indexed.flatMap(({ name }) => {
                const column = columns.find((item) => item.name === name)
                return column && !required.some((item) => item.name === name) ? [column] : []
            })
            const uniqueRevision = indexed.some(({ name }) =>
                required.some((column) => column.name === name && column.primary),
            )
            const omittedNull = retained.some((column) => !column.notnull && nullDefault(column.dflt_value))
            if (retained.length && !uniqueRevision && !omittedNull)
                throw new LitiError(
                    'LITI_MIGRATION_REQUIRED',
                    `Retained UNIQUE columns in "${expected.name}" prevent active-column inserts. Generate and apply migrations explicitly.`,
                )
        }
    }
}
