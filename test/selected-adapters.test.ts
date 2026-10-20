import { expect, it } from 'vitest'
import { voidAdapter } from '../packages/void/src'
import { drizzle } from '../packages/drizzle/src'
import { sqlite } from '../packages/sqlite/src'
import { resolveLitiConfig, defineLitiConfig } from '../packages/liti/src'
import { connectDrizzle } from '../packages/drizzle/src/runtime'
import { drizzleKit } from '../packages/drizzle/src/tooling'

it('replaces the complete database bundle and its generation owner', async () => {
    const database = drizzle({ connection: { driver: 'd1', binding: 'CONTENT_DB' } })
    const config = resolveLitiConfig(
        defineLitiConfig({
            adapter: voidAdapter(),
            $production: { adapter: { database } },
        }),
        ['production'],
    )
    expect(config.adapter.database).toBe(database)
    expect(config.adapter.runtime?.id).toBe('@litijs/void/runtime')
    const plan = await config.adapter.database.tooling!.generate(config, {
        projectRoot: process.cwd(),
        environment: ['production'],
        schemaOnly: false,
    })
    expect(plan.command).toEqual({
        package: 'drizzle-kit',
        bin: 'drizzle-kit',
        version: '1.0.0-rc.4',
        args: ['generate', '--config=.liti/drizzle.config.json'],
        peers: { 'drizzle-orm': '1.0.0-rc.4' },
    })
    expect(plan.files[0]?.source).toContain('@litijs/drizzle/schema')
    expect(plan.files[0]?.source).not.toContain('@litijs/void')
    expect(plan.files[0]?.path).toBe('liti-db/liti.ts')
})

it('keeps native runtime independent of optional migration tooling', async () => {
    expect(sqlite({ driver: 'bun', filename: ':memory:' }).tooling).toBeUndefined()
    const native = sqlite({ driver: 'bun', filename: ':memory:', tooling: drizzleKit() })
    expect(
        (
            await native.tooling!.generate(
                { models: {} },
                {
                    projectRoot: process.cwd(),
                    environment: [],
                    schemaOnly: true,
                },
            )
        ).command,
    ).toBeUndefined()
})

it('rejects unsupported drivers and aliased independent D1 targets before running SQL', async () => {
    expect(() => drizzle({ connection: { driver: 'postgres' } } as never)).toThrow('supports D1 and Bun')
    const binding = {
        prepare() {
            throw new Error('must not prepare')
        },
        batch() {
            throw new Error('must not batch')
        },
    }
    await expect(
        connectDrizzle(
            { connection: { driver: 'd1', binding: 'CONTENT_DB' } },
            {
                projectRoot: process.cwd(),
                environment: [],
                loadModule: async () => ({}),
                platformContext: { env: { DB: binding, CONTENT_DB: binding } },
            },
        ),
    ).rejects.toThrow('distinct physical databases')
})
