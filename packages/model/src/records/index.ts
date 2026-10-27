import { and, eq, asc, count, isNull, getTableColumns } from 'drizzle-orm'
import { databases } from '@vite-hub/database/drizzle'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { RecordModel, ContentModel } from '../definition/model'
import { assertIdentity, ModelError } from '../definition/errors'
import { validateData, queryFilter } from '../definition/validation'
import { authorize } from '../authorization/index'
import type { RecordTables } from './schema'
import { sqlCommit } from './errors'

export type { RecordTable, RecordTables } from './schema'
import type { RecordEntry, RecordOperation } from '../definition/entries'
export type { RecordEntry, RecordOperation } from '../definition/entries'

export function createModelRecords(options: {
    models: readonly RecordModel[]
    tables: RecordTables
    database: string
    contentModels?: readonly ContentModel[]
}) {
    const models = new Map(options.models.map((model) => [model.name, model]))
    const native = () => {
        const entry = databases[options.database]
        if (!entry) throw new ModelError('LITI_INVALID_MODEL', 'The native ViteHub Database is not registered.')
        return entry.db
    }
    const modelOf = (name: string) => {
        const model = models.get(name),
            table = options.tables[name]
        if (!model || !table) throw new ModelError('LITI_INVALID_MODEL', `Unknown record model: ${name}`)
        return { model, table }
    }
    const project = async (
        model: RecordModel,
        row: Record<string, unknown>,
        management = false,
    ): Promise<RecordEntry> => {
        const { id, version, createdAt, updatedAt, ...data } = row
        for (const [key, definition] of Object.entries(model.fields))
            if (
                data[key] === null &&
                (await definition.schema['~standard'].validate(null)).issues &&
                !(await definition.schema['~standard'].validate(undefined)).issues
            )
                delete data[key]
        const validated = await validateData(model.fields, data)
        return {
            id: String(id),
            version: Number(version),
            createdAt: String(createdAt),
            updatedAt: String(updatedAt),
            data: Object.fromEntries(
                Object.entries(validated).filter(([key]) => management || model.fields[key]?.public !== false),
            ),
        }
    }
    const read = async (name: string, id: string) => {
        const { model, table } = modelOf(name)
        const [row] = await native()
            .select()
            .from(table)
            .where(eq(table.id, assertIdentity(id)))
        return row ? await project(model, row) : null
    }
    const query = async (
        name: string,
        page: { limit?: number; offset?: number; filter?: Record<string, unknown> } = {},
    ) => {
        const { model, table } = modelOf(name),
            limit = page.limit ?? 50,
            offset = page.offset ?? 0
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0)
            throw new ModelError('LITI_INVALID_INPUT', 'Invalid record page.')
        const db = native()
        const columns: Record<string, AnySQLiteColumn> = getTableColumns(table)
        const conditions = Object.entries(await queryFilter(model.fields, page.filter)).map(([key, value]) => {
            const column = columns[key]
            if (!column) throw new ModelError('LITI_INVALID_MODEL', 'The native record column is missing.')
            return value === null ? isNull(column) : eq(column, value)
        })
        const [rows, totals] = await db.batch([
            db
                .select()
                .from(table)
                .where(and(...conditions))
                .orderBy(asc(table.id))
                .limit(limit)
                .offset(offset),
            db
                .select({ value: count() })
                .from(table)
                .where(and(...conditions)),
        ])
        return { items: await Promise.all(rows.map((row) => project(model, row))), total: totals[0]!.value }
    }
    const save = async (
        name: string,
        id: string,
        input: Record<string, unknown>,
        operation: RecordOperation & { ifVersion: number | null },
    ) => {
        const { model, table } = modelOf(name)
        await authorize(model, { ...operation, action: 'save', id: assertIdentity(id) })
        if (!Object.hasOwn(operation, 'ifVersion'))
            throw new ModelError('LITI_INVALID_INPUT', 'A reviewed record version is required.')
        if (operation.ifVersion !== null && (!Number.isSafeInteger(operation.ifVersion) || operation.ifVersion < 1))
            throw new ModelError('LITI_INVALID_INPUT', 'Invalid record version.')
        const [previousRow] =
            operation.ifVersion === null ? [] : await native().select().from(table).where(eq(table.id, id))
        const previous = previousRow ? await project(model, previousRow, true) : null
        if (operation.ifVersion !== null && previous?.version !== operation.ifVersion)
            throw new ModelError('LITI_CONFLICT', 'The record changed before validation.')
        const context = { ...operation, action: 'save' as const, id, locale: 'und', previous: previous?.data ?? null }
        const prepared = model.prepare ? await model.prepare({ data: input }, context) : { data: input }
        if ('body' in prepared && prepared.body)
            throw new ModelError('LITI_INVALID_INPUT', 'Records have no Markdown body.')
        const data = await validateData(model.fields, prepared.data)
        await model.validate?.(data, context)
        const now = new Date().toISOString()
        const columns = Object.fromEntries(Object.keys(model.fields).map((key) => [key, data[key] ?? null]))
        const rows = await sqlCommit(async () =>
            operation.ifVersion === null
                ? await native()
                      .insert(table)
                      .values({ ...columns, id, version: 1, createdAt: now, updatedAt: now })
                      .returning()
                : await native()
                      .update(table)
                      .set({ ...columns, version: operation.ifVersion + 1, updatedAt: now })
                      .where(and(eq(table.id, id), eq(table.version, operation.ifVersion)))
                      .returning(),
        )
        if (!rows[0]) throw new ModelError('LITI_CONFLICT', 'The record changed before commit.')
        return { id, version: rows[0].version, updatedAt: now }
    }
    const remove = async (name: string, id: string, operation: RecordOperation & { ifVersion: number }) => {
        const { model, table } = modelOf(name)
        await authorize(model, { ...operation, action: 'remove', id: assertIdentity(id) })
        if (!Number.isSafeInteger(operation.ifVersion) || operation.ifVersion < 1)
            throw new ModelError('LITI_INVALID_INPUT', 'Invalid record version.')
        if (
            options.contentModels?.some(
                (source) =>
                    Object.values(source.fields).some((field) => field.reference === name) ||
                    source.references?.some((reference) => reference.model === name),
            )
        )
            throw new ModelError(
                'LITI_CROSS_STORE_ATOMICITY',
                'Records targeted by Content references cannot be physically deleted. Archive them explicitly in the application.',
            )
        const deleted = await sqlCommit(
            async () =>
                await native()
                    .delete(table)
                    .where(and(eq(table.id, id), eq(table.version, operation.ifVersion)))
                    .returning(),
        )
        if (!deleted[0]) throw new ModelError('LITI_CONFLICT', 'The record changed before deletion.')
        return { id, removed: true as const }
    }
    const readDraft = async (name: string, id: string, operation: RecordOperation) => {
        const { model, table } = modelOf(name)
        await authorize(model, { ...operation, action: 'readDraft', id: assertIdentity(id) })
        const [row] = await native().select().from(table).where(eq(table.id, id))
        return row ? await project(model, row, true) : null
    }
    return {
        read,
        readDraft,
        query,
        save,
        remove,
        exists: async (model: string, id: string) => Boolean(await read(model, id)),
    }
}
