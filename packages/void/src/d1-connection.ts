import type { DrizzleConnection as Database } from './database'
import type { AtomicStatement, AtomicResult, DatabaseValue as Primitive } from '@litijs/sqlite/storage'
import { assertAtomicResults } from '@litijs/sqlite/storage'

interface D1Result {
    error?: string
    meta?: { changes?: number }
    results?: unknown[]
    success?: boolean
}

interface D1Statement {
    bind(...params: Primitive[]): D1Statement
}

interface D1Database {
    batch(statements: D1Statement[]): Promise<D1Result[]>
    prepare(sql: string): D1Statement
}

const runD1Batch = async (instance: D1Database, statements: AtomicStatement[]): Promise<AtomicResult[]> => {
    const prepared = statements.map((statement) => instance.prepare(statement.sql).bind(...(statement.params ?? [])))
    const raw = await instance.batch(prepared)
    const results = raw.map((result) => {
        if (result.success === false || result.error) throw new Error(result.error ?? 'D1 batch statement failed.')
        return {
            ...(result.meta?.changes === undefined ? {} : { changes: result.meta.changes }),
            rows: result.results ?? [],
        }
    })
    assertAtomicResults(statements, results)
    return results
}

export const runAtomic = async (database: Database, statements: AtomicStatement[]): Promise<AtomicResult[]> => {
    if (statements.length === 0) return []
    // D1 owns the atomic batch; a shared JS queue can retain I/O from a canceled Worker request.
    const instance = await database.getInstance()
    return runD1Batch(instance, statements)
}

export const queryRows = async <Row extends object>(
    database: Database,
    sql: string,
    params: Primitive[] = [],
): Promise<Row[]> => (await database.prepare(sql).all(...params)) as Row[]
