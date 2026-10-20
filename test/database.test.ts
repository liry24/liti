import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database, type Primitive } from 'db0'
import cloudflareD1 from 'db0/connectors/cloudflare-d1'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DrizzleLitiDatabase } from '../packages/void/src/database'
const queryRows = (database: DrizzleLitiDatabase, sql: string) => database.query(sql)
const runAtomic = (database: DrizzleLitiDatabase, statements: Parameters<DrizzleLitiDatabase['atomic']>[0]) =>
    database.atomic(statements)
import { testAdapter } from './migrate'
import { defineLitiConfig, text } from '../packages/liti/src'
import { createD1Database, type DrizzleConnection } from '../packages/void/src/database'
import { createNativeSqliteDatabase } from '../packages/sqlite/src/native'
import { createRuntime } from '../packages/liti/src/server'
import { migrateTestDatabase } from './migrate'
import { queryRows as nativeQueryRows, runAtomic as nativeRunAtomic } from '../packages/void/src/d1-connection'

const databases: Database[] = []
const temporaryFiles: string[] = []

afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.dispose()))
    await Promise.all(temporaryFiles.splice(0).map((path) => unlink(path)))
})

describe('atomic database execution', () => {
    it.each(['d1', 'native'] as const)(
        'reads %s list/count/search snapshots while a separate connection holds a reserved writer lock',
        async (driver) => {
            const path = join(tmpdir(), `liti-reader-${crypto.randomUUID()}.sqlite`)
            temporaryFiles.push(path)
            const reader = createDatabase(nodeSqlite({ path })),
                writer = createDatabase(nodeSqlite({ path }))
            databases.push(reader, writer)
            const config = defineLitiConfig({ models: { posts: { fields: { slug: text(), title: text() } } } })
            await migrateTestDatabase(reader, config)
            const adapter =
                driver === 'native'
                    ? createNativeSqliteDatabase((await reader.getInstance()) as import('node:sqlite').DatabaseSync)
                    : await testAdapter(reader, config)
            const core = createRuntime({ config, database: adapter })
            const entry = await core.createEntry('posts', {
                data: { slug: 'reader-snapshot', title: 'Reader snapshot' },
            })
            await core.createEntry('posts', { data: { slug: 'other', title: 'Other' } })
            const storage = adapter.bind(config)
            await storage.pageEntries({ q: 'reader' }, { limit: 1, offset: 0 })
            const nativeReader = (await reader.getInstance()) as import('node:sqlite').DatabaseSync
            const nativeWriter = (await writer.getInstance()) as import('node:sqlite').DatabaseSync
            expect(nativeReader).not.toBe(nativeWriter)
            nativeWriter.exec('BEGIN IMMEDIATE')
            try {
                nativeWriter.prepare('UPDATE liti_entries SET version=version+1 WHERE id=?').run(entry.id)
                expect(await storage.entries()).toHaveLength(2)
                expect(await storage.pageEntries({}, { limit: 1, offset: 1 })).toMatchObject({
                    total: 2,
                    items: [{ version: 1 }],
                })
                expect(await storage.pageEntries({ q: 'reader' }, { limit: 1, offset: 0 })).toMatchObject({
                    total: 1,
                    items: [{ id: entry.id, version: 1 }],
                })
            } finally {
                nativeWriter.exec('ROLLBACK')
            }
        },
    )

    it('rolls back native writes when a later RETURNING guard rejects the transaction', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(database)
        await database.exec('CREATE TABLE candidates (value TEXT PRIMARY KEY)')
        const adapter = createNativeSqliteDatabase((await database.getInstance()) as import('node:sqlite').DatabaseSync)
        await expect(
            adapter.atomic([
                { sql: "INSERT INTO candidates VALUES ('discarded')" },
                {
                    sql: "UPDATE candidates SET value='changed' WHERE value='missing' RETURNING value",
                    query: true,
                    expectRow: true,
                },
            ]),
        ).rejects.toMatchObject({ code: 'LITI_CONFLICT' })
        expect(await adapter.query('SELECT * FROM candidates')).toEqual([])
    })

    it('retains write mode for query statements with INSERT/UPDATE RETURNING', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(database)
        await database.exec('CREATE TABLE values_table (value TEXT PRIMARY KEY)')
        const adapter = await testAdapter(database, { models: {} })
        const native = (await database.getInstance()) as import('node:sqlite').DatabaseSync
        const statements: string[] = [],
            exec = native.exec.bind(native)
        native.exec = (sql) => {
            statements.push(sql)
            exec(sql)
        }
        const results = await adapter.atomic([
            { query: true, expectRow: true, sql: "INSERT INTO values_table VALUES ('one') RETURNING value" },
            { query: true, expectRow: true, sql: "UPDATE values_table SET value='two' RETURNING value" },
        ])
        expect(results.map(({ rows }) => rows)).toEqual([[{ value: 'one' }], [{ value: 'two' }]])
        expect(statements).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    })
    it('rejects connections without an atomic native client', () => {
        expect(() => createD1Database({} as Parameters<typeof createD1Database>[0], {})).toThrow('Void D1')
    })

    it('serializes reads behind a transaction on the same Database instance', async () => {
        const order: string[] = []
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        const fake = {
            lockKey: {},
            dialect: 'sqlite',
            getInstance: () => ({
                prepare: () => ({
                    bind() {
                        return this
                    },
                }),
                batch: async () => {
                    order.push('batch')
                    await gate
                    order.push('commit')
                    return [{ results: [] }]
                },
            }),
            prepare: (sql: string) => ({
                all: async () => {
                    order.push(`all:${sql}`)
                    return []
                },
                get: async () => undefined,
                run: async () => ({ changes: 1 }),
            }),
        } as unknown as DrizzleConnection
        const mutation = nativeRunAtomic(fake, [{ query: true, sql: 'SELECT mutation' }])
        await Promise.resolve()
        const read = nativeQueryRows(fake, 'SELECT read')
        await Promise.resolve()
        expect(order).toEqual(['batch'])
        release()
        await Promise.all([mutation, read])
        expect(order).toEqual(['batch', 'commit', 'all:SELECT read'])
    })

    it('rolls back a failed SQLite mutation', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(database)
        await database.exec('CREATE TABLE values_table (value TEXT PRIMARY KEY)')

        await expect(
            runAtomic(await testAdapter(database, { models: {} }), [
                { params: ['kept-out'], sql: 'INSERT INTO values_table(value) VALUES (?)' },
                { params: ['kept-out'], sql: 'INSERT INTO values_table(value) VALUES (?)' },
            ]),
        ).rejects.toThrow()
        expect(await queryRows(await testAdapter(database, { models: {} }), 'SELECT * FROM values_table')).toEqual([])
    })

    it('uses one native D1 batch and checks RETURNING guards', async () => {
        class Statement {
            readonly params: Primitive[] = []

            constructor(readonly sql: string) {}

            bind(...params: Primitive[]): Statement {
                this.params.push(...params)
                return this
            }
        }

        const batches: Statement[][] = []
        const binding = {
            batch: async (statements: Statement[]) => {
                batches.push(statements)
                return statements.map(() => ({ results: [], success: true }))
            },
            exec: async () => ({ count: 0, duration: 0 }),
            prepare: (sql: string) => new Statement(sql),
        }
        Object.assign(globalThis, { __env__: { LITI_TEST_DB: binding } })
        const database = createDatabase(cloudflareD1({ bindingName: 'LITI_TEST_DB' }))
        databases.push(database)

        await expect(
            runAtomic(await testAdapter(database, { models: {} }), [
                { params: ['a'], sql: 'INSERT INTO example(value) VALUES (?)' },
                { expectRow: true, query: true, sql: 'UPDATE example SET value = value RETURNING value' },
            ]),
        ).rejects.toMatchObject({ code: 'LITI_CONFLICT' })
        expect(batches).toHaveLength(1)
        expect(batches[0]?.map((statement) => statement.sql)).toEqual([
            'INSERT INTO example(value) VALUES (?)',
            'UPDATE example SET value = value RETURNING value',
        ])
    })

    it('does not roll back unrelated application work on the shared SQLite connection', async () => {
        const database = createDatabase(nodeSqlite({ name: ':memory:' }))
        databases.push(database)
        const adapter = await testAdapter(database, { models: {} })
        const native = (await database.getInstance()) as import('node:sqlite').DatabaseSync
        native.exec('CREATE TABLE values_table (value TEXT PRIMARY KEY)')
        const exec = native.exec.bind(native)
        native.exec = (sql) => {
            exec(sql)
            if (sql === 'BEGIN IMMEDIATE')
                queueMicrotask(() => native.prepare("INSERT INTO values_table VALUES ('application')").run())
        }
        await expect(
            runAtomic(adapter, [
                { sql: "INSERT INTO values_table VALUES ('content')" },
                { sql: "INSERT INTO values_table VALUES ('content')" },
            ]),
        ).rejects.toThrow()
        expect(await queryRows(adapter, 'SELECT value FROM values_table')).toEqual([{ value: 'application' }])
    })
})
