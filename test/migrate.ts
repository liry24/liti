import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Database } from 'db0'
import type { LitiConfig } from '../packages/liti/src/config'
import { generateLitiSchema } from '../packages/void/src/tooling'
import { createRuntime } from '../packages/liti/src/server'
import { createJiti } from 'jiti'
import { createD1Database } from '../packages/void/src/database'
import { sqliteD1 } from './d1'
import { drizzleKit } from '../packages/drizzle/src/tooling'
import { resolveGenerationCommand } from '../packages/cli/src/command'

const schemaDirectory = (source: string) =>
    resolve('.tmp/test-schema', `${createHash('sha256').update(source).digest('hex')}-${process.pid}`)

export async function testAdapter(database: Database, config: LitiConfig) {
    const source = generateLitiSchema(config)
    const directory = schemaDirectory(source)
    mkdirSync(directory, { recursive: true })
    const path = resolve(directory, 'schema.ts')
    writeFileSync(path, source)
    const schema = await createJiti(import.meta.url, { fsCache: false }).import<Record<string, unknown>>(path)
    const client = (await database.getInstance()) as
        | import('node:sqlite').DatabaseSync
        | Parameters<typeof createD1Database>[0]
    return createD1Database('batch' in client ? client : sqliteD1(client as import('node:sqlite').DatabaseSync), schema)
}

/** Tests explicitly apply real Drizzle Kit SQL; the runtime never creates tables. */
export async function migrateTestDatabase(
    database: Database,
    config: LitiConfig,
    profile: 'void' | 'drizzle' = 'void',
): Promise<Record<string, unknown>> {
    const source =
        profile === 'void'
            ? generateLitiSchema(config)
            : (await drizzleKit().generate(config, { projectRoot: process.cwd(), environment: [], schemaOnly: true }))
                  .files[0]!.source
    const directory = schemaDirectory(source)
    mkdirSync(directory, { recursive: true })
    const schema = resolve(directory, 'schema.ts').replaceAll('\\', '/')
    const output = resolve(directory, 'migrations').replaceAll('\\', '/')
    writeFileSync(schema, source)
    const migrations = () =>
        existsSync(output)
            ? readdirSync(output, { recursive: true })
                  .filter((name): name is string => typeof name === 'string' && name.endsWith('.sql'))
                  .sort()
            : []
    if (!migrations().length) {
        const args = ['generate', '--dialect=sqlite', `--schema=${schema}`, `--out=${output}`]
        execFileSync(
            process.versions.bun && profile === 'drizzle' ? 'node' : process.execPath,
            profile === 'void'
                ? [resolve('node_modules/drizzle-kit/bin.cjs'), ...args]
                : await resolveGenerationCommand(
                      {
                          package: 'drizzle-kit',
                          bin: 'drizzle-kit',
                          version: '1.0.0-rc.5',
                          peers: { 'drizzle-orm': '1.0.0-rc.5' },
                          args,
                      },
                      resolve('packages/drizzle'),
                  ),
            { stdio: 'pipe' },
        )
    }
    const existing = await database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='liti_entries'")
        .all()
    if (!existing.length)
        for (const migration of migrations()) await database.exec(readFileSync(resolve(output, migration), 'utf8'))
    return createJiti(import.meta.url, { fsCache: false }).import<Record<string, unknown>>(schema)
}

export async function createMigratedTestAdmin(
    options: Omit<Parameters<typeof createRuntime>[0], 'database'> & { database: Database },
) {
    await migrateTestDatabase(options.database, options.config)
    return createRuntime({ ...options, database: await testAdapter(options.database, options.config) })
}
