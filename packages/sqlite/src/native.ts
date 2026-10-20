import { createSqliteDatabase } from './connection'
import { assertAtomicResults } from './statements'
import type { DatabaseValue } from './statements'

type NativeValue = Exclude<DatabaseValue, boolean>
export interface NativeSqlite {
    prepare(sql: string): { all(...params: NativeValue[]): unknown[] }
    exec(sql: string): unknown
}

const values = (params: DatabaseValue[] = []): NativeValue[] =>
    params.map((value) => (typeof value === 'boolean' ? Number(value) : value))

/** Synchronous execution keeps validation and every dependent write inside the transaction. */
export function createNativeSqliteDatabase(native: NativeSqlite) {
    native.exec('PRAGMA foreign_keys = ON')
    return createSqliteDatabase({
        async query(sql, params) {
            return native.prepare(sql).all(...values(params))
        },
        async atomic(statements, mode = 'write') {
            if (!statements.length) return []
            native.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE')
            try {
                const results = statements.map(({ sql, params }) => ({
                    rows: native.prepare(sql).all(...values(params)),
                }))
                assertAtomicResults(statements, results)
                native.exec('COMMIT')
                return results
            } catch (error) {
                native.exec('ROLLBACK')
                throw error
            }
        },
    })
}
