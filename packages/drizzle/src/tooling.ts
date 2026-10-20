import type { DatabaseTooling } from 'liti/adapter'
import { LitiError } from 'liti/adapter'
import { emitDrizzleSchema } from '@litijs/sqlite/tooling'

export const drizzleVersion = '1.0.0-rc.4'

export interface DrizzleToolingOptions {
    schema?: { generated?: string; entry?: string }
    migrations?: { out?: string }
}

/** Explicit tooling can also generate migrations for the ORM-free native SQLite store. */
export function drizzleKit(options: DrizzleToolingOptions = {}): DatabaseTooling {
    return {
        generate(config, context) {
            const generated = context.output ?? options.schema?.generated ?? 'liti-db/liti.ts'
            const entry = options.schema?.entry ?? generated
            const out = options.migrations?.out ?? 'liti-db/migrations'
            if (![generated, entry, out].every((path) => typeof path === 'string' && path.trim()))
                throw new LitiError('LITI_INVALID_INPUT', 'Drizzle schema and migration paths must be non-empty.')
            if (generated === out || entry === out)
                throw new LitiError('LITI_INVALID_INPUT', 'Schema files and migration directories must be distinct.')
            const source =
                emitDrizzleSchema(config, { builders: '@litijs/drizzle/schema', sql: '@litijs/drizzle/schema' }) +
                `\nexport const litiSchemaOwner = ${JSON.stringify(`@litijs/drizzle:${drizzleVersion}`)}\n`
            const configPath = '.liti/drizzle.config.mjs'
            return {
                files: [
                    { path: generated, source },
                    ...(entry === generated
                        ? []
                        : [
                              {
                                  path: entry,
                                  source: `export * from ${JSON.stringify(relativeImport(entry, generated))}\n`,
                                  createOnly: true,
                              },
                          ]),
                    ...(!context.schemaOnly
                        ? [
                              {
                                  path: configPath,
                                  source:
                                      'export default ' +
                                      JSON.stringify(
                                          { dialect: 'sqlite', schema: entry, out, breakpoints: true },
                                          null,
                                          2,
                                      ) +
                                      '\n',
                              },
                          ]
                        : []),
                ],
                ...(!context.schemaOnly
                    ? {
                          command: {
                              package: 'drizzle-kit',
                              bin: 'drizzle-kit',
                              version: drizzleVersion,
                              peers: { 'drizzle-orm': drizzleVersion },
                              args: ['generate', `--config=${configPath}`],
                          },
                      }
                    : {}),
            }
        },
    }
}

function relativeImport(from: string, to: string): string {
    const source = from.replaceAll('\\', '/').split('/').slice(0, -1)
    const target = to.replaceAll('\\', '/').split('/')
    while (source.length && target.length && source[0] === target[0]) {
        source.shift()
        target.shift()
    }
    const path = [...source.map(() => '..'), ...target].join('/').replace(/\.ts$/u, '')
    return path.startsWith('.') ? path : `./${path}`
}
