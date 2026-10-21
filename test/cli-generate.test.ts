import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const cli = resolve('packages/cli/src/index.ts')
const jiti = resolve('node_modules/jiti/lib/jiti-cli.mjs')
const fields = resolve('packages/liti/src/fields.ts')
const voidEntry = resolve('packages/void/src/index.ts')

describe('environment-resolved schema CLI', () => {
    it.each(['ts', 'mjs'])('leaves Nuxt types to its lifecycle with nuxt.config.%s', async (extension) => {
        await mkdir(resolve('.tmp'), { recursive: true })
        const path = await mkdtemp(resolve('.tmp/cli-nuxt-types-'))
        try {
            await writeFile(resolve(path, 'liti.config.ts'), 'export default { models: {} }')
            await writeFile(resolve(path, `nuxt.config.${extension}`), 'throw new Error("Nuxt must not be loaded")')
            const run = (args: string[] = []) =>
                JSON.parse(
                    execFileSync(process.execPath, [jiti, cli, 'generate', '--json', ...args], {
                        cwd: path,
                        encoding: 'utf8',
                    }),
                )
            const before = await readdir(path)
            const planned = run(['--dry-run'])
            expect(planned.files.map((file: { path: string }) => file.path)).toEqual([
                resolve(path, '.liti/descriptor.json'),
            ])
            expect(await readdir(path)).toEqual(before)
            const generated = run()
            expect(generated.files.map((file: { path: string }) => file.path)).toEqual([
                resolve(path, '.liti/descriptor.json'),
            ])
            expect(generated.messages.join('\n')).toContain('Nuxt generates client types')
            expect(JSON.parse(await readFile(resolve(path, '.liti/descriptor.json'), 'utf8'))).toHaveProperty('models')
            expect(await readdir(path)).not.toContain('liti.generated.ts')
            expect(await readdir(path)).not.toContain('.nuxt')
        } finally {
            await rm(path, { recursive: true, force: true })
        }
    })

    it('resolves domain environments and explicit output without invoking the application database', async () => {
        await mkdir(resolve('.tmp'), { recursive: true })
        const path = await mkdtemp(resolve('.tmp/cli-generate-'))
        try {
            await writeFile(
                resolve(path, 'liti.config.ts'),
                `import { text } from ${JSON.stringify(fields)}
import { voidAdapter } from ${JSON.stringify(voidEntry)}
import { getProvider } from 'files-sdk/providers'
if (!getProvider('memory')) throw new Error('CLI native Files alias failed')
export default {
  adapter: voidAdapter(),
  models: { posts: { fields: { title: text() } } },
  $production: {
    models: { posts: { fields: { title: text({ required: true }) } } },
  },
  $env: { preview: {
    models: { previews: { fields: { note: text() } } },
  } },
  $prerender: { models: { prerenders: { fields: { note: text() } } } },
}
`,
            )
            const run = (environment: string, args: string[] = []) =>
                execFileSync(process.execPath, [jiti, cli, 'generate', '--schema-only', ...args], {
                    cwd: path,
                    env: { ...process.env, NODE_ENV: environment },
                    encoding: 'utf8',
                })
            expect(run('development')).toContain('no application database was modified')
            expect(await readFile(resolve(path, 'db/schema.ts'), 'utf8')).not.toContain('text("field_title").notNull()')
            run('production', ['--out', 'schema-production.ts'])
            expect(await readFile(resolve(path, 'schema-production.ts'), 'utf8')).toContain(
                'text("field_title").notNull()',
            )
            run('production', ['--env', 'preview', '--out', 'schema-preview.ts'])
            const preview = await readFile(resolve(path, 'schema-preview.ts'), 'utf8')
            expect(preview).toContain('liti_content_previews')
            expect(preview).toContain('text("field_title").notNull()')
            run('production', ['--env', 'preview', '--env', 'prerender', '--out', 'schema-prerender.ts'])
            expect(await readFile(resolve(path, 'schema-prerender.ts'), 'utf8')).toContain('liti_content_prerenders')
            run('production', ['--out', 'explicit/schema.ts'])
            expect(await readFile(resolve(path, 'explicit/schema.ts'), 'utf8')).toContain(
                'text("field_title").notNull()',
            )
            await mkdir(resolve(path, 'server'))
            await writeFile(resolve(path, 'server/auth.config.ts'), 'export default {}')
            run('production', ['--out', 'schema-auth.ts'])
            expect(await readFile(resolve(path, 'schema-auth.ts'), 'utf8')).toContain('export const user = sqliteTable')
            await writeFile(
                resolve(path, 'nuxt.config.ts'),
                "export default { auth: { schema: { usePlural: true, casing: 'snake_case' } } }",
            )
            run('production', ['--out', 'schema-auth-plural.ts'])
            expect(await readFile(resolve(path, 'schema-auth-plural.ts'), 'utf8')).toContain(
                'export const users = sqliteTable',
            )
            expect(await readdir(path)).not.toContain('never-open.sqlite')
            expect(await readdir(path)).not.toContain('migrations')
        } finally {
            await rm(path, { recursive: true, force: true })
        }
    })

    it('plans selected tooling without writes, executes it once and reports partial failures', async () => {
        const path = await mkdtemp(resolve('.tmp/生成 CLI space-'))
        try {
            const toolPath = resolve(path, 'node_modules/schema-tool')
            await mkdir(toolPath, { recursive: true })
            await writeFile(
                resolve(toolPath, 'package.json'),
                JSON.stringify({
                    name: 'schema-tool',
                    version: '1.0.0',
                    type: 'module',
                    bin: { 'schema-tool': './run.mjs' },
                }),
            )
            await writeFile(
                resolve(toolPath, 'run.mjs'),
                `
import { appendFileSync } from 'node:fs'
appendFileSync('calls.txt', process.argv[2] + '\\n')
if (process.argv[2] === 'fail') process.exit(7)
`,
            )
            const configSource = (args: string[], version = '1.0.0') => `export default {
models: {},
adapter: { database: {
 id: 'test', role: 'database',
 connect() { throw new Error('generation must never connect') },
 tooling: { generate(_config, context) { return {
  files: [{ path: 'schema.ts', source: '// generated\\n' }],
  ...(context.schemaOnly ? {} : { command: { package: 'schema-tool', bin: 'schema-tool', version: ${JSON.stringify(version)}, args: ${JSON.stringify(args)} } })
 } } }
} }
}`
            await writeFile(resolve(path, 'liti.config.ts'), configSource(['success']))
            const run = (args: string[] = []) =>
                execFileSync(process.execPath, [jiti, cli, 'generate', ...args], {
                    cwd: path,
                    encoding: 'utf8',
                    stdio: 'pipe',
                })
            const before = await readdir(path)
            expect(run(['--dry-run'])).toContain('Dry run complete')
            expect(await readdir(path)).toEqual(before)
            expect(run()).toContain('migrations generated')
            expect(await readFile(resolve(path, 'calls.txt'), 'utf8')).toBe('success\n')
            execFileSync('bun', [cli, 'generate', '--cwd', path], { encoding: 'utf8', stdio: 'pipe' })
            expect(await readFile(resolve(path, 'calls.txt'), 'utf8')).toBe('success\nsuccess\n')
            expect(await readFile(resolve(path, 'liti.generated.ts'), 'utf8')).toContain("declare module 'liti/client'")
            await writeFile(resolve(path, 'liti.config.ts'), configSource(['fail']))
            expect(() => run()).toThrow('migration generation failed (7)')
            expect(await readFile(resolve(path, 'schema.ts'), 'utf8')).toBe('// generated\n')
            expect(await readFile(resolve(path, 'calls.txt'), 'utf8')).toBe('success\nsuccess\nfail\n')
            await writeFile(resolve(path, 'liti.config.ts'), configSource(['never'], '2.0.0'))
            expect(() => run()).toThrow('the project resolves 1.0.0')
            expect(await readFile(resolve(path, 'calls.txt'), 'utf8')).toBe('success\nsuccess\nfail\n')
            expect(run(['--schema-only'])).toContain('Schema-only generation completed')
        } finally {
            await rm(path, { recursive: true, force: true })
        }
    })

    it('requires explicit schema-only mode when the database has no migration tooling', async () => {
        const path = await mkdtemp(resolve('.tmp/cli-no-tooling-'))
        try {
            await writeFile(
                resolve(path, 'liti.config.ts'),
                `export default {
                models: { posts: { fields: {} } },
                adapter: { database: { id: 'custom', role: 'database', connect() { throw new Error('must never connect') } } }
            }`,
            )
            const run = (args: string[] = []) =>
                execFileSync(process.execPath, [jiti, cli, 'generate', ...args], {
                    cwd: path,
                    encoding: 'utf8',
                    stdio: 'pipe',
                })
            expect(() => run()).toThrow('has no migration tooling')
            expect(await readdir(path)).toEqual(['liti.config.ts'])
            expect(run(['--schema-only'])).toContain('Schema-only generation completed')
        } finally {
            await rm(path, { recursive: true, force: true })
        }
    })

    it('does not evaluate config in dry runs and treats empty/AI-only configs as database-free', async () => {
        const path = await mkdtemp(resolve('.tmp/cli-empty-'))
        try {
            const run = (args: string[] = []) =>
                execFileSync(process.execPath, [jiti, cli, 'generate', '--cwd', path, ...args], {
                    encoding: 'utf8',
                    stdio: 'pipe',
                })
            await writeFile(resolve(path, 'liti.config.ts'), 'throw new Error("config evaluated"); export default {}')
            const planned = JSON.parse(run(['--dry-run', '--json']))
            expect(planned.schema).toBe('unevaluated')
            expect(await readdir(path)).toEqual(['liti.config.ts'])
            await writeFile(resolve(path, 'liti.config.ts'), 'export default { models: {} }')
            expect(run()).toContain('Database generation is not applicable')
            await writeFile(
                resolve(path, 'liti.config.ts'),
                `export default { models: {}, plugins: [{
                id: 'actions', apiVersion: 1, actions: { check: {
                    input: { '~standard': { version: 1, vendor: 'test', validate(value) { return { value } } } },
                    output: { '~standard': { version: 1, vendor: 'test', validate(value) { return { value } } } },
                    execute() { throw new Error('never infer during generation') }
                } }
            }] }`,
            )
            expect(run()).toContain('Database generation is not applicable')
            expect(await readdir(path)).not.toContain('migrations')
        } finally {
            await rm(path, { recursive: true, force: true })
        }
    })
})
