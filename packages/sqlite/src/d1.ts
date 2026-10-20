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

const locks = new WeakMap<object, Promise<void>>()

const withLock = async <Value>(key: object, operation: () => Promise<Value>): Promise<Value> => {
    const previous = locks.get(key) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>((resolve) => (release = resolve))
    const queued = previous.then(() => current)
    locks.set(key, queued)
    await previous
    try {
        return await operation()
    } finally {
        release()
        if (locks.get(key) === queued) locks.delete(key)
    }
}

const result = (value: D1Result): AtomicResult => {
    if (value.success === false || value.error) throw new Error(value.error ?? 'D1 statement failed.')
    return { rows: value.results ?? [], ...(value.meta?.changes === undefined ? {} : { changes: value.meta.changes }) }
}

/** The SQL compiler guards every dependent write; D1 executes the entire batch atomically. */
export const createD1Connection = (binding: D1Binding): SqliteConnection => ({
    query: (sql, params = []) =>
        withLock(
            binding,
            async () =>
                result(
                    await binding
                        .prepare(sql)
                        .bind(...params)
                        .all(),
                ).rows,
        ),
    atomic: (statements: AtomicStatement[]) =>
        withLock(binding, async () => {
            if (!statements.length) return []
            const results = (
                await binding.batch(statements.map(({ sql, params = [] }) => binding.prepare(sql).bind(...params)))
            ).map(result)
            assertAtomicResults(statements, results)
            return results
        }),
})
