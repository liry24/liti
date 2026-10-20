import type { AdapterContext } from 'liti/adapter'
import type { SqliteOptions } from './index'
import { createNativeSqliteDatabase } from './native'

export async function connectSqlite(options: SqliteOptions, context: AdapterContext) {
    const { resolve } = await import('node:path')
    const { Database } = await import('bun:sqlite')
    const filename = options.filename === ':memory:' ? options.filename : resolve(context.projectRoot, options.filename)
    const native = new Database(filename, { create: true, strict: true })
    return { ...createNativeSqliteDatabase(native), close: () => native.close() }
}
