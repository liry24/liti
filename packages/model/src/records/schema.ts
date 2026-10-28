import {
    sqliteTable,
    text,
    integer,
    real,
    uniqueIndex,
    type AnySQLiteColumn,
    type SQLiteColumnBuilderBase,
    type SQLiteTableWithColumns,
} from 'drizzle-orm/sqlite-core'
import type { RecordModel, ModelData } from '../definition/model'
import { ModelError } from '../definition/errors'

const baseTable = (
    name: string,
    columns: Record<string, SQLiteColumnBuilderBase>,
    unique: readonly (readonly string[])[],
) =>
    sqliteTable(
        name,
        {
            id: text('id').primaryKey(),
            version: integer('version').notNull(),
            createdAt: text('created_at').notNull(),
            updatedAt: text('updated_at').notNull(),
            ...columns,
        },
        (table) =>
            unique.map((keys, index) =>
                uniqueIndex(`${name}_unique_${index}`).on(
                    ...(keys.map((key) => table[key as keyof typeof table] as AnySQLiteColumn) as [
                        AnySQLiteColumn,
                        ...AnySQLiteColumn[],
                    ]),
                ),
            ),
    )
type BaseRecordTable = ReturnType<typeof baseTable>
export type RecordTable<M extends RecordModel = RecordModel> = string extends keyof M['fields']
    ? BaseRecordTable
    : SQLiteTableWithColumns<
          Omit<BaseRecordTable['_']['config'], 'columns'> & {
              columns: BaseRecordTable['_']['columns'] & {
                  [Key in keyof ModelData<M> & string]: AnySQLiteColumn<{
                      data: Exclude<ModelData<M>[Key], undefined>
                      notNull: false
                  }>
              }
          }
      >
export type RecordTables<Models extends readonly RecordModel[] = readonly RecordModel[]> = {
    [Name in Models[number]['name']]: RecordTable<Extract<Models[number], { name: Name }>>
}

function sqlKind(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') return
    const schema = input as { type?: string | string[]; anyOf?: unknown[]; oneOf?: unknown[]; enum?: unknown[] }
    const types = Array.isArray(schema.type)
        ? schema.type
        : schema.type
          ? [schema.type]
          : [...(schema.anyOf ?? schema.oneOf ?? [])].flatMap((item) => sqlKind(item) ?? [])
    if (!types.length && schema.enum)
        types.push(...schema.enum.filter((value) => value !== null).map((value) => typeof value))
    const present = [...new Set(types.filter((type) => type !== 'null'))]
    return present.length === 1 ? present[0] : undefined
}

/** Native Drizzle tables are contributed to ViteHub Database; no driver or migration executor lives here. */
export function recordSchema<const Models extends readonly RecordModel[]>(models: Models): RecordTables<Models> {
    const tables: RecordTables = {}
    const names = new Set<string>()
    for (const model of models) {
        if (names.has(model.name.toLowerCase()))
            throw new ModelError('LITI_INVALID_MODEL', 'Record names collide in native SQL.')
        names.add(model.name.toLowerCase())
        const columns: Record<string, SQLiteColumnBuilderBase> = {}
        const columnNames = new Set(['id', 'version', 'created_at', 'updated_at'])
        for (const [key, field] of Object.entries(model.fields)) {
            if (columnNames.has(key.toLowerCase()))
                throw new ModelError('LITI_INVALID_MODEL', 'Record field names collide in native SQL.')
            columnNames.add(key.toLowerCase())
            const kind = sqlKind(field.schema['~standard'].jsonSchema.output({ target: 'draft-2020-12' }))
            if (field.reference) {
                if (kind !== 'string' || !models.some((target) => target.name === field.reference))
                    throw new ModelError(
                        'LITI_INVALID_MODEL',
                        'Record references must be native string foreign keys to another record model.',
                    )
                columns[key] = text(key).references(() => tables[field.reference!]!.id, { onDelete: 'restrict' })
            } else if (kind === 'integer') columns[key] = integer(key)
            else if (kind === 'number') columns[key] = real(key)
            else if (kind === 'boolean') columns[key] = integer(key, { mode: 'boolean' })
            else if (kind === 'string') columns[key] = text(key)
            else columns[key] = text(key, { mode: 'json' })
        }
        for (const keys of model.unique ?? [])
            for (const key of keys) {
                const kind = sqlKind(
                    model.fields[key]!.schema['~standard'].jsonSchema.output({ target: 'draft-2020-12' }),
                )
                if (!['string', 'integer', 'number', 'boolean'].includes(kind ?? ''))
                    throw new ModelError('LITI_INVALID_MODEL', 'Unique tuples require scalar SQL columns.')
            }
        if (model.references?.length)
            throw new ModelError(
                'LITI_INVALID_MODEL',
                'Record references use field reference metadata and native foreign keys.',
            )
        tables[model.name] = baseTable(`liti_${model.name}`, columns, model.unique ?? [])
    }
    return tables as RecordTables<Models>
}
