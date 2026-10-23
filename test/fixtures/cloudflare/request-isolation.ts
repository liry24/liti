import type { AnyD1Database } from 'drizzle-orm/d1'
import { createD1Connection } from '../../../packages/sqlite/src/d1'
import { createD1Database } from '../../../packages/void/src/database'

const schema = {}
const bindings = new WeakMap<object, ReturnType<typeof stalledBinding>>()

function stalledBinding(native: AnyD1Database) {
    let stalled = false
    class Statement {
        params: unknown[] = []
        constructor(readonly sql: string) {}
        bind(...params: unknown[]) {
            this.params = params
            return this
        }
        all() {
            // Simulate request I/O that Workerd cancels without resuming JS cleanup.
            if (this.sql === 'SELECT 1 AS stalled') {
                stalled = true
                return new Promise<never>(() => {})
            }
            return native
                .prepare(this.sql)
                .bind(...this.params)
                .all()
        }
        run() {
            return this.all()
        }
    }
    return {
        get stalled() {
            return stalled
        },
        prepare: (sql: string) => new Statement(sql),
        batch: (statements: unknown[]) =>
            native.batch(
                statements.map((statement) => {
                    if (!(statement instanceof Statement)) throw new Error('Unknown D1 statement.')
                    return native.prepare(statement.sql).bind(...statement.params)
                }),
            ),
    }
}

export async function requestIsolationProbe(request: Request, native: AnyD1Database): Promise<Response> {
    let binding = bindings.get(native)
    if (!binding) bindings.set(native, (binding = stalledBinding(native)))
    const url = new URL(request.url)
    const database =
        url.searchParams.get('driver') === 'sqlite' ? createD1Connection(binding) : createD1Database(binding, schema)
    if (url.pathname.endsWith('/stall')) await database.query('SELECT 1 AS stalled')
    return Response.json({
        stalled: binding.stalled,
        read: await database.query('SELECT 1 AS value'),
        batch: await database.atomic([{ sql: 'SELECT 2 AS value', expectRow: true }]),
    })
}
