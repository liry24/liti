import type { SqliteDatabase } from '../packages/sqlite/src/connection'
import type { DatabaseValue, AtomicStatement } from '../packages/sqlite/src/statements'

/** Adapter-specific inspection for tests; Core never receives SQL. */
export const runAtomic = (database: SqliteDatabase, statements: AtomicStatement[]) => database.atomic(statements)
export const queryRows = async <Row extends object>(
    database: SqliteDatabase,
    sql: string,
    params: DatabaseValue[] = [],
): Promise<Row[]> => (await database.query(sql, params)) as Row[]
export const queryRow = async <Row extends object>(
    database: SqliteDatabase,
    sql: string,
    params: DatabaseValue[] = [],
): Promise<Row | undefined> => (await queryRows<Row>(database, sql, params))[0]
