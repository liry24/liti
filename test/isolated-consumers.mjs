import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { consumerDependencies, stableVue } from './consumer-dependencies.mjs'
import { verifyIsolatedVue } from './isolated-vue.mjs'
import { archiveDependencies, archiveOverrides, consumerPackages } from './consumer-packages.mjs'

import { installDependencies } from 'nypm'
const manager = process.env.LITI_PACKAGE_MANAGER || 'npm'
const root = await mkdtemp(join(tmpdir(), 'liti-isolated-'))
const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, shell: false })
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
}
try {
    const archives = await consumerPackages(root, run)
    const packages = archiveDependencies(archives, Object.keys(archives))
    const profiles = [
        {
            name: 'core',
            dependencies: {},
            absent: ['vue', 'nuxt', 'void', 'drizzle-orm', 'ai', '@litijs/blog', '@litijs/ai'],
        },
        {
            name: 'blog',
            dependencies: { '@litijs/blog': packages['@litijs/blog'] },
            absent: ['vue', 'nuxt', 'void', 'drizzle-orm', 'ai', '@litijs/ai'],
        },
        {
            name: 'ai',
            dependencies: { '@litijs/ai': packages['@litijs/ai'] },
            absent: ['vue', 'nuxt', 'void', 'drizzle-orm', 'ai', '@litijs/blog'],
        },
        {
            name: 'vue',
            dependencies: consumerDependencies(['vue']),
            absent: ['nuxt', 'void', 'drizzle-orm', 'ai', '@tanstack/vue-form'],
        },
        {
            name: 'vue-stable',
            dependencies: { vue: stableVue },
            absent: ['nuxt', 'void', 'drizzle-orm', 'ai', '@tanstack/vue-form'],
        },
        {
            name: 'sqlite',
            dependencies: { '@litijs/sqlite': packages['@litijs/sqlite'] },
            absent: ['vue', 'nuxt', 'void', 'drizzle-orm', 'ai'],
        },
        {
            name: 'drizzle',
            dependencies: {
                ...archiveDependencies(archives, ['@litijs/sqlite', '@litijs/drizzle']),
                'drizzle-orm': '1.0.0-rc.5',
                'drizzle-kit': '1.0.0-rc.5',
                ...consumerDependencies(['@types/node']),
            },
            absent: ['vue', 'nuxt', 'void', 'ai'],
        },
        {
            name: 'mixed',
            dependencies: {
                ...archiveDependencies(archives, ['@litijs/sqlite', '@litijs/drizzle', '@litijs/void']),
                'drizzle-orm': '1.0.0-rc.5',
                'drizzle-kit': '1.0.0-rc.5',
                ...consumerDependencies(['void', '@types/node']),
            },
            absent: ['vue', 'nuxt', 'ai'],
        },
    ]
    for (const profile of profiles) {
        if (process.env.LITI_CONSUMER_PROFILE && !process.env.LITI_CONSUMER_PROFILE.split(',').includes(profile.name))
            continue
        const cwd = join(root, profile.name + '-consumer')
        const nativeDrizzle = ['drizzle', 'mixed'].includes(profile.name)
        await mkdir(cwd)
        await writeFile(
            join(cwd, 'package.json'),
            JSON.stringify({
                private: true,
                type: 'module',
                ...archiveOverrides(archives, manager, [
                    'liti',
                    ...Object.keys(profile.dependencies).filter((name) => name in archives),
                ]),
                dependencies: {
                    liti: packages.liti,
                    ...profile.dependencies,
                    ...consumerDependencies(['typescript']),
                },
            }),
        )
        console.log(`${manager}: installing isolated ${profile.name} consumer`)
        await installDependencies({ cwd, packageManager: manager, silent: true, corepack: false })
        const source = [
            "import { defineLitiConfig, resolveLitiConfig, text, type InferLitiSchema } from 'liti'",
            "import { createLitiClient } from 'liti/client'",
            "import { createLiti, executeAction } from 'liti/server'",
            'const config = defineLitiConfig({ models: { posts: { fields: { title: text({ required: true }) } } } })',
            'const client = createLitiClient<InferLitiSchema<typeof config>>()',
            "const rows = client.query('posts')",
            'type Title = Awaited<typeof rows>[number]["data"]["title"]',
            'const title: Title = "typed"',
            '// @ts-expect-error No legacy/singular inference from an ID in many mode.',
            "client.query('posts', { id: 'one' })",
            'void [title, createLiti, executeAction]',
        ]
        if (profile.name === 'blog')
            source.push(
                "import { blog } from '@litijs/blog'",
                'const articles = resolveLitiConfig(defineLitiConfig({ plugins: [blog({ models: { articles: {} } })] }), [])',
                'type Article = InferLitiSchema<typeof articles>["publicModels"]["articles"]',
                'declare const article: Article',
                'const date: string | null = article.meta.blog.date; void date',
            )
        if (profile.name === 'ai')
            source.push(
                "import { ai, createTextAction, createSlugGenerator, type AiProvider } from '@litijs/ai'",
                'const plugin = ai(); void [plugin, createTextAction, createSlugGenerator]',
                'const provider: AiProvider = { id: "test" }; void provider',
            )
        if (profile.name === 'sqlite')
            source.push(
                "import { sqlite } from '@litijs/sqlite'",
                "defineLitiConfig({ adapter: { database: sqlite({ driver: 'bun', filename: ':memory:' }) } })",
            )
        if (profile.name === 'drizzle' || profile.name === 'mixed')
            source.push(
                "import { drizzle } from '@litijs/drizzle'",
                "import { drizzleKit } from '@litijs/drizzle/tooling'",
                "import { sqliteTable, text as sqliteText } from '@litijs/drizzle/schema'",
                "const database = drizzle({ connection: { driver: 'bun', filename: 'content.sqlite' } })",
                "const table = sqliteTable('custom', { title: sqliteText('title') }); void [database, table, drizzleKit]",
            )
        if (profile.name === 'mixed')
            source.push(
                "import { voidAdapter } from '@litijs/void'",
                'const native = voidAdapter()',
                "const replaced = resolveLitiConfig(defineLitiConfig({ adapter: native, $production: { adapter: { database } } }), ['production'])",
                'void replaced',
            )
        if (profile.name.startsWith('vue'))
            source.push(
                "import { createLitiVue, useForm, Subscribe, createValidator, type DeepKeys } from 'liti/vue'",
                'const field: DeepKeys<{ title: string }> = "title"; void [field, createLitiVue, Subscribe]',
                'const form = useForm({ defaultValues: { title: "" } })',
                'form.setFieldValue("title", "new"); form.reset()',
                '// @ts-expect-error Native field value inference is preserved.',
                'form.setFieldValue("title", 12)',
                'void [form.Field, form.Subscribe, createValidator]',
            )
        await writeFile(join(cwd, 'types.ts'), source.join('\n') + '\n')
        await writeFile(
            join(cwd, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2024',
                    module: 'Preserve',
                    moduleResolution: 'Bundler',
                    noEmit: true,
                    strict: true,
                    skipLibCheck: false,
                    types: nativeDrizzle ? ['node'] : [],
                    lib: ['ES2024', 'DOM', 'DOM.Iterable'],
                },
                include: ['types.ts'],
            }),
        )
        const local = createRequire(join(cwd, 'package.json'))
        const tsc = join(dirname(local.resolve('typescript/package.json')), 'bin/tsc')
        const checkTypes = async (args) => {
            const checked = spawnSync(process.execPath, [tsc, '--noEmit', ...args], { cwd, encoding: 'utf8' })
            if (checked.status === 0) return
            if (!nativeDrizzle) throw new Error(checked.stdout + checked.stderr)
            // shortcut: Drizzle rc.4 has 44 native declaration errors; remove the baseline when upstream fixes them.
            await writeFile(
                join(cwd, 'native-types.ts'),
                "export { sql } from 'drizzle-orm'; export { sqliteTable, text } from 'drizzle-orm/sqlite-core'\n",
            )
            await writeFile(
                join(cwd, 'tsconfig.native.json'),
                JSON.stringify({ extends: './tsconfig.json', include: ['native-types.ts'] }),
            )
            const baseline = spawnSync(process.execPath, [tsc, '--noEmit', ...args, '-p', 'tsconfig.native.json'], {
                cwd,
                encoding: 'utf8',
            })
            assert.equal(baseline.status, 1)
            assert.equal(
                checked.stdout + checked.stderr,
                baseline.stdout + baseline.stderr,
                'SDK declarations must add no errors to the native Drizzle baseline',
            )
            console.warn(
                `${manager}: ${profile.name} strict declarations have ${(baseline.stdout.match(/error TS/gu) ?? []).length} upstream Drizzle diagnostics; SDK adds none`,
            )
        }
        await checkTypes([])
        if (!profile.name.startsWith('vue')) {
            await checkTypes(['--module', 'NodeNext', '--moduleResolution', 'NodeNext'])
        }
        await writeFile(
            join(cwd, 'browser.mjs'),
            "export * from 'liti'; export { createLitiClient } from 'liti/client'\n",
        )
        run('bun', ['build', 'browser.mjs', '--target=browser', '--outfile=browser.js'], cwd)
        await writeFile(join(cwd, 'worker.mjs'), "export * from 'liti/server'\n")
        run('bun', ['build', 'worker.mjs', '--target=browser', '--outfile=worker.js'], cwd)
        await writeFile(
            join(cwd, 'probe.mjs'),
            [
                "import assert from 'node:assert/strict'",
                "import { createRequire } from 'node:module'",
                "import { defineLitiConfig, text } from 'liti'",
                "import { createLitiClient } from 'liti/client'",
                "import { createLiti, executeAction } from 'liti/server'",
                'const require = createRequire(import.meta.url)',
                `for (const name of ${JSON.stringify(profile.absent)}) assert.throws(() => require.resolve(name + '/package.json'), { code: 'MODULE_NOT_FOUND' }, name + ' must remain absent')`,
                "assert.equal(typeof createLiti, 'function'); assert.equal(typeof executeAction, 'function')",
                'const client = createLitiClient({ fetch: async () => Response.json([]) })',
                "assert.deepEqual(await client.query('posts'), [])",
                'assert.ok(defineLitiConfig({ models: { posts: { fields: { title: text() } } } }).models.posts)',
                ...(profile.name === 'blog'
                    ? [
                          "const { blog } = await import('@litijs/blog'); assert.ok(blog({ models: { posts: {} } }).models.posts)",
                      ]
                    : []),
                ...(profile.name === 'ai'
                    ? ["const { ai } = await import('@litijs/ai'); assert.equal(ai().id, '@litijs/ai')"]
                    : []),
                ...(profile.name === 'sqlite'
                    ? [
                          "const { sqlite } = await import('@litijs/sqlite'); assert.equal(sqlite({ driver: 'bun', filename: ':memory:' }).role, 'database')",
                      ]
                    : []),
                ...(profile.name.startsWith('vue')
                    ? [
                          "const { useForm, createFormHook, Subscribe } = await import('liti/vue')",
                          "assert.equal(typeof useForm, 'function'); assert.equal(typeof createFormHook, 'function'); assert.ok(Subscribe)",
                      ]
                    : []),
            ].join('\n'),
        )
        run(process.execPath, ['probe.mjs'], cwd)
        if (profile.name.startsWith('vue')) await verifyIsolatedVue(cwd, run)
        const cli = join(dirname(local.resolve('liti/package.json')), 'dist/cli.mjs')
        await writeFile(join(cwd, 'liti.config.ts'), 'throw new Error("Configuration must not run")')
        assert.match(run(process.execPath, [cli, '--help'], cwd), /liti <command>/u)
        assert.match(run(process.execPath, [cli, '--version'], cwd), /^\d+\.\d+\.\d+/u)
        if (profile.name === 'core') {
            const empty = join(root, 'init-consumer')
            await mkdir(empty)
            const args = [cli, 'init', '--no-install', '--json', '--package-manager', manager]
            assert.equal(JSON.parse(run(process.execPath, [...args, '--dry-run'], empty)).status, 'planned')
            assert.deepEqual(await readdir(empty), [], 'Dry-run must not create a project')
            assert.equal(JSON.parse(run(process.execPath, args, empty)).status, 'installation-pending')
            const manifest = JSON.parse(await readFile(join(empty, 'package.json'), 'utf8'))
            assert.deepEqual(Object.keys(manifest.dependencies), ['liti'])
            assert.match(await readFile(join(empty, 'liti.config.ts'), 'utf8'), /defineLitiConfig\(\{\}\)/u)
            assert.deepEqual((await readdir(empty)).sort(), ['liti.config.ts', 'package.json'])
        }
        const before = await readFile(join(cwd, 'package.json'), 'utf8')
        const preview = JSON.parse(run(process.execPath, [cli, 'generate', '--dry-run', '--json'], cwd))
        assert.equal(preview.schema, 'unevaluated')
        assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), before)
        if (profile.name === 'drizzle' || profile.name === 'mixed') {
            await writeFile(
                join(cwd, 'liti.config.ts'),
                [
                    "import { defineLitiConfig, text } from 'liti'",
                    "import { drizzle } from '@litijs/drizzle'",
                    "export default defineLitiConfig({ adapter: { database: drizzle({ connection: { driver: 'bun', filename: 'content.sqlite' } }) }, models: { posts: { fields: { title: text({ required: true }), slug: text() }, route: '/:slug' } } })",
                ].join('\n'),
            )
            run(process.execPath, [cli, 'generate'], cwd)
            run(process.execPath, [cli, 'generate'], cwd)
            await writeFile(
                join(cwd, 'database.mjs'),
                [
                    "import assert from 'node:assert/strict'",
                    "import { readFile, readdir, access } from 'node:fs/promises'",
                    "import { createRequire } from 'node:module'",
                    "import { Database } from 'bun:sqlite'",
                    "import { createLiti } from 'liti/server'",
                    "import { resolveLitiConfig } from 'liti'",
                    "import config from './liti.config.ts'",
                    "import * as schema from './liti-db/liti.ts'",
                    "await assert.rejects(access('content.sqlite'), { code: 'ENOENT' })",
                    "const sql = (await readdir('liti-db/migrations', { recursive: true })).filter((name) => name.endsWith('.sql'))",
                    "assert.equal(sql.length, 1, 'Regeneration must not create a second baseline')",
                    "const database = new Database('content.sqlite')",
                    "for (const name of sql) database.exec(await readFile('liti-db/migrations/' + name, 'utf8'))",
                    'database.close()',
                    "let now = new Date('2026-01-01T00:00:00Z')",
                    'const app = await createLiti(config, { projectRoot: process.cwd(), loadModule: async () => schema, now: () => now })',
                    "const service = await app.service({ actor: { id: 'test', roles: ['admin'] } })",
                    "let entry = await service.createEntry('posts', { data: { title: 'Packed', slug: 'packed' } })",
                    'assert.equal(entry.firstPublishedAt, null)',
                    'entry = await service.publishEntry(entry.id, { expectedVersion: entry.version })',
                    'assert.equal(entry.firstPublishedAt, now.toISOString())',
                    'const first = entry.firstPublishedAt',
                    "now = new Date('2026-01-02T00:00:00Z')",
                    'entry = await service.unpublishEntry(entry.id, { expectedVersion: entry.version })',
                    "entry = await service.updateEntry(entry.id, { expectedVersion: entry.version, data: { title: 'Updated' } })",
                    'entry = await service.publishEntry(entry.id, { expectedVersion: entry.version })',
                    'assert.equal(entry.firstPublishedAt, first)',
                    "assert.equal(entry.data.title, 'Updated')",
                    'await app.close()',
                    "const independent = createRequire(import.meta.resolve('@litijs/drizzle'))",
                    "assert.equal(independent('drizzle-orm/version').npmVersion, '1.0.0-rc.5')",
                    ...(profile.name === 'mixed'
                        ? [
                              "const native = createRequire(import.meta.resolve('@litijs/void'))",
                              "assert.equal(native('drizzle-orm/version').npmVersion, '0.45.4')",
                              "const { voidAdapter } = await import('@litijs/void')",
                              'const preset = voidAdapter()',
                              "const selected = resolveLitiConfig({ adapter: preset, $production: { adapter: { database: config.adapter.database } } }, ['production'])",
                              'assert.equal(selected.adapter.database, config.adapter.database)',
                              'assert.equal(selected.adapter.runtime, preset.runtime)',
                              'const nativePlan = await preset.database.tooling.generate(selected, { projectRoot: process.cwd(), environment: [], schemaOnly: true })',
                              "assert.ok(nativePlan.files.some((file) => file.source.includes('@litijs/void/schema')))",
                          ]
                        : []),
                ].join('\n'),
            )
            run('bun', ['database.mjs'], cwd)
        }
        console.log(
            `${manager}: isolated ${profile.name} imports, ${nativeDrizzle ? 'declaration baseline comparison' : 'strict declarations'} and packed CLI passed`,
        )
    }
} catch (error) {
    console.error(`Failed consumer retained at ${root}`)
    throw error
}
if (!process.env.LITI_KEEP_CONSUMER) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
