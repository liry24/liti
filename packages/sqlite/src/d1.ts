import { assertAtomicResults } from './statements'
import type { AtomicResult, AtomicStatement, DatabaseValue, SqliteConnection } from './statements'

interface D1Result {
    error?: string
    meta?: { changes?: number }
    results?: unknown[]
    success?: boolean
}

export interface D1Statement {
    bind(...params: DatabaseValue[]): D1Statement
    all(): Promise<D1Result>
}

export interface D1Binding {
    prepare(sql: string): D1Statement
    batch(statements: D1Statement[]): Promise<D1Result[]>
}

const result = (value: D1Result): AtomicResult => {
    if (value.success === false || value.error) throw new Error(value.error ?? 'D1 statement failed.')
    return { rows: value.results ?? [], ...(value.meta?.changes === undefined ? {} : { changes: value.meta.changes }) }
}

/** The SQL compiler guards every dependent write; D1 executes the entire batch atomically. */
export const createD1Connection = (binding: D1Binding): SqliteConnection => ({
    query: async (sql, params = []) =>
        result(
            await binding
                .prepare(sql)
                .bind(...params)
                .all(),
        ).rows,
    async atomic(statements: AtomicStatement[]) {
        if (!statements.length) return []
        // D1 owns the transaction; never await another request's I/O through a shared JS queue.
        const results = (
            await binding.batch(statements.map(({ sql, params = [] }) => binding.prepare(sql).bind(...params)))
        ).map(result)
        assertAtomicResults(statements, results)
        return results
    },
})
