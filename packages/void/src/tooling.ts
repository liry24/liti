import type { LitiConfig, GenerationContext, GenerationPlan } from 'liti/adapter'
import { emitDrizzleSchema } from '@litijs/sqlite/tooling'
import type { BetterAuthOptions } from 'better-auth'

type NativeAuthConfig =
    | BetterAuthOptions
    | ((context: { db: unknown; requestOrigin?: string; runtimeConfig: Record<string, unknown> }) => BetterAuthOptions)

export async function generate(
    config: LitiConfig,
    context: GenerationContext,
    schema: { generated: string; entry: string },
): Promise<GenerationPlan> {
    const [{ existsSync }, { resolve, relative, dirname }] = await Promise.all([import('node:fs'), import('node:path')])
    const output = context.output ?? schema.generated
    let auth: NativeAuthConfig | undefined
    let authSchema: Parameters<typeof generateCombinedSchema>[2]
    if (config.adapter?.auth?.id === '@litijs/void/auth') {
        const nuxtFile = resolve(context.projectRoot, 'nuxt.config.ts')
        const kit = existsSync(nuxtFile) ? await context.loadModule?.('nuxt/kit') : undefined
        const nuxtOptions = kit
            ? await (
                  kit.loadNuxtConfig as (options: {
                      cwd: string
                      dotenv: false
                  }) => Promise<{ auth?: { serverConfig?: string; schema?: typeof authSchema } }>
              )({ cwd: context.projectRoot, dotenv: false })
            : undefined
        const authFile = resolve(context.projectRoot, nuxtOptions?.auth?.serverConfig ?? 'server/auth.config.ts')
        if (existsSync(authFile)) auth = (await context.loadModule?.(authFile))?.default as NativeAuthConfig | undefined
        authSchema = nuxtOptions?.auth?.schema
    }
    const source = auth ? await generateCombinedSchema(config, auth, authSchema) : generateLitiSchema(config)
    const importPath = relative(dirname(schema.entry), output).replaceAll('\\', '/').replace(/\.ts$/u, '')
    return {
        files: [
            { path: output, source },
            ...(schema.entry === output
                ? []
                : [
                      {
                          path: schema.entry,
                          source: `export * from ${JSON.stringify(importPath.startsWith('.') ? importPath : `./${importPath}`)}\n`,
                          createOnly: true,
                      },
                  ]),
        ],
        ...(!context.schemaOnly
            ? {
                  command: { package: 'void', bin: 'void', version: '1.2.1', args: ['db', 'generate'] },
              }
            : {}),
    }
}

/** Uses Better Auth's schema generator without initializing auth or connecting to a database. */
export async function generateCombinedSchema(
    config: LitiConfig,
    auth: NativeAuthConfig,
    schema: { usePlural?: boolean; casing?: 'camelCase' | 'snake_case' } = {},
): Promise<string> {
    const resolved = typeof auth === 'function' ? auth({ db: undefined, runtimeConfig: {} }) : auth
    const { drizzleAdapter } = await import('@better-auth/drizzle-adapter')
    const { admin } = await import('better-auth/plugins')
    const plugins = [...(resolved.plugins ?? [])]
    if (!plugins.some((plugin) => plugin.id === 'admin')) plugins.push(admin())
    const authOptions: BetterAuthOptions = {
        ...resolved,
        plugins,
    }
    const adapter = drizzleAdapter(
        {},
        {
            provider: 'sqlite',
            transaction: false,
            usePlural: schema.usePlural ?? false,
            camelCase: schema.casing !== 'snake_case',
        },
    )(authOptions)
    const { generateDrizzleSchema } = await import('auth/api')
    const generated = await generateDrizzleSchema({ adapter, options: authOptions, file: 'schema.ts' })
    if (!generated?.code) throw new Error('Better Auth returned no schema source.')
    // The CMS relation table already exports `relations`; preserve its schema identity.
    const source = generated.code
        .replace(
            /import\s*\{([^}]+)\}\s*from\s*(['"])drizzle-orm\2/gu,
            (_match, names: string) =>
                `import { ${names.replace(/\brelations\b/gu, 'relations as authRelations')} } from 'drizzle-orm'`,
        )
        .replace(/\brelations\(/gu, 'authRelations(')
    return mergeSchemaSources(generateLitiSchema(config), source)
}

// Both generators emit named imports. Reject unsupported syntax rather than silently producing a broken schema.
function mergeSchemaSources(...sources: string[]): string {
    const imports = new Map<string, Set<string>>()
    const exports = new Set<string>()
    const tables = new Set<string>()
    const bodies = sources.map((source) => {
        for (const match of source.matchAll(/sqliteTable\(\s*['"]([^'"]+)['"]/g)) {
            const name = match[1]!.toLowerCase()
            if (tables.has(name)) throw new Error(`Duplicate schema table: ${name}`)
            tables.add(name)
        }
        for (const match of source.matchAll(/export const (\w+)/g)) {
            if (exports.has(match[1]!)) throw new Error(`Duplicate schema export: ${match[1]}`)
            exports.add(match[1]!)
        }
        const body = source.replace(
            /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g,
            (_, names: string, module: string) => {
                if (
                    ![
                        'drizzle-orm',
                        'drizzle-orm/sqlite-core',
                        'void/db',
                        'void/schema-d1',
                        '@litijs/void/schema',
                    ].includes(module)
                )
                    throw new Error('Combined schema generation supports Drizzle SQLite only.')
                for (const name of names
                    .split(',')
                    .map((binding) => binding.trim())
                    .filter(Boolean)) {
                    const target = ['drizzle-orm', 'drizzle-orm/sqlite-core', 'void/db', 'void/schema-d1'].includes(
                        module,
                    )
                        ? '@litijs/void/schema'
                        : module
                    const bindings = imports.get(target) ?? new Set<string>()
                    bindings.add(name)
                    imports.set(target, bindings)
                }
                return ''
            },
        )
        if (/^\s*import\s/m.test(body)) throw new Error('Unsupported schema import syntax.')
        return body.trim()
    })
    return (
        [...imports]
            .map(([module, names]) => `import { ${[...names].join(', ')} } from ${JSON.stringify(module)}`)
            .join('\n') +
        '\n\n' +
        bodies.join('\n\n') +
        '\n'
    )
}

/** Pure code generation: no database connection or migration application. */
export const generateLitiSchema = (config: LitiConfig): string => {
    return mergeSchemaSources(
        emitDrizzleSchema(config, { builders: '@litijs/void/schema', sql: '@litijs/void/schema' }),
    )
}
