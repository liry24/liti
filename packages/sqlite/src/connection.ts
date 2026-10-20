import type { LitiConfig, LitiDatabase } from 'liti/adapter'
import { LitiError } from 'liti/adapter'
import { contentTableName, fieldStorage } from './model'
import { sqliteStorage } from './storage'
import { assertSqliteSchema } from './validate'
import type { AtomicStatement, DatabaseValue, SqliteConnection } from './statements'

export interface SqliteDatabase extends LitiDatabase, SqliteConnection {}

/** All drivers use the same typed-column codec and conditional commit compiler. */
export function createSqliteDatabase(connection: SqliteConnection): SqliteDatabase {
    return {
        ...connection,
        bind(config) {
            return {
                assertSchema: () => assertSqliteSchema(connection, config),
                ...sqliteStorage(connection, config, (model, id, data) => insertRevision(config, model, id, data)),
            }
        },
    }
}

function insertRevision(config: LitiConfig, model: string, id: string, data: Record<string, unknown>): AtomicStatement {
    const fields = config.models[model]?.fields
    if (!fields) throw new LitiError('LITI_SCHEMA_INCOMPATIBLE', `Unknown Model "${model}".`)
    const columns = ['revision_id', ...Object.keys(fields).map((key) => `field_${key}`)]
    const params: DatabaseValue[] = [
        id,
        ...Object.entries(fields).map(([key, field]): DatabaseValue => {
            const value = data[key]
            if (value === undefined || value === null) return null
            const storage = fieldStorage(field)
            if (storage === 'json') return JSON.stringify(value)
            if (storage === 'boolean') return value ? 1 : 0
            if (typeof value === 'string' || typeof value === 'number') return value
            throw new LitiError('LITI_INVALID_INPUT', `Invalid value for "${model}.${key}".`)
        }),
    ]
    return {
        sql: `INSERT INTO ${JSON.stringify(contentTableName(model))}(${columns.map((name) => JSON.stringify(name)).join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE EXISTS (SELECT 1 FROM liti_revisions WHERE id = ?)`,
        params: [...params, id],
    }
}

export type * from './statements'
export { assertAtomicResults } from './statements'
export { assertSqliteSchema } from './validate'
export { sqliteStorage } from './storage'
export { createD1Connection } from './d1'
export type { D1Binding } from './d1'
