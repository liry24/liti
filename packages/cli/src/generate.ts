import { readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { parse } from '@babel/parser'
import { createJiti } from 'jiti'
import type { LitiConfig, LitiConfigInput } from '../../liti/src/config'
import type { GenerationPlan } from '../../liti/src/plugins'
import { resolveLitiConfig } from '../../liti/src/config-resolution'
import { generateLitiDescriptor, generateLitiTypes } from '../../liti/src/tooling'
import { generationRuntime, resolveGenerationCommand } from './command'
import { inside, readOptional, writeChanges } from './project'
import type { CliOptions } from './commands'

export async function runGenerate(values: CliOptions) {
    const projectRoot = resolve(values.cwd ?? process.cwd())
    const configPath = inside(projectRoot, values.config ?? 'liti.config.ts')
    const environments = [process.env.NODE_ENV ?? 'development', ...(values.env ?? [])]
    const nuxt = ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'].some((extension) =>
        existsSync(resolve(projectRoot, `nuxt.config.${extension}`)),
    )
    if (values['dry-run']) {
        const ast = parse(await readFile(configPath, 'utf8'), { sourceType: 'module', plugins: ['typescript'] })
        return {
            status: 'planned',
            files: [
                ...(!nuxt ? [{ path: resolve(projectRoot, 'liti.generated.ts') }] : []),
                { path: resolve(projectRoot, '.liti/descriptor.json') },
            ],
            imports: ast.program.body
                .filter((node) => node.type === 'ImportDeclaration')
                .map((node) => node.source.value),
            environment: environments,
            schema: 'unevaluated',
            migrations: 'unevaluated',
            messages: [
                'Configuration and plugins were not evaluated. Database owner, physical schema, migration changes and generator command remain unevaluated.',
            ],
        }
    }
    const jiti = createJiti(configPath, { fsCache: false, moduleCache: false })
    const loadModule = (specifier: string) => jiti.import<Record<string, unknown>>(specifier)
    const loaded = (await loadModule(configPath)).default as LitiConfigInput
    const config = resolveLitiConfig(loaded, environments)
    const needsDatabase = Object.keys(config.models).length > 0 || !!config.assets
    const tooling = config.adapter?.database?.tooling
    if (needsDatabase && !config.adapter?.database)
        throw new Error('Persistent models/assets require adapter.database before generation.')
    if (!tooling && needsDatabase && !values['schema-only'])
        throw new Error(
            'The selected database has no migration tooling. Configure its tooling or use --schema-only for types and descriptor generation.',
        )
    if (!tooling && values.out) throw new Error('--out requires a selected database schema generator.')
    const plan: GenerationPlan = tooling
        ? await tooling.generate(config as LitiConfig, {
              projectRoot,
              environment: environments,
              schemaOnly: !!values['schema-only'],
              ...(values.out ? { output: values.out } : {}),
              loadModule,
          })
        : { files: [] }
    if (!values['schema-only'] && (needsDatabase || tooling) && !plan.command)
        throw new Error('The selected database did not provide migration generation. Use --schema-only explicitly.')
    if (values['schema-only'] && plan.command)
        throw new Error('Schema-only tooling must not request an external command.')
    if (!nuxt) {
        const configImport =
            './' +
            relative(projectRoot, configPath)
                .replaceAll('\\', '/')
                .replace(/\.(?:ts|mts|js|mjs)$/u, '')
        plan.files.push({ path: 'liti.generated.ts', source: generateLitiTypes(configImport, environments) })
    }
    plan.files.push({ path: '.liti/descriptor.json', source: generateLitiDescriptor(config) })
    const files = plan.files.map((file) => ({ ...file, path: inside(projectRoot, file.path) }))
    if (
        new Set(files.map(({ path }) => (process.platform === 'win32' ? path.toLowerCase() : path))).size !==
        files.length
    )
        throw new Error('The selected tooling produced conflicting output paths.')
    const commandArgs = plan.command ? await resolveGenerationCommand(plan.command, projectRoot) : undefined
    const executable = commandArgs ? await generationRuntime() : undefined
    const changes = await Promise.all(
        files
            .filter((file) => !file.createOnly || !existsSync(file.path))
            .map(async (file) => ({ path: file.path, before: await readOptional(file.path), after: file.source })),
    )
    await writeChanges(changes)
    if (commandArgs) {
        const status = await new Promise<number | null>((accept, reject) => {
            const child = spawn(executable!, commandArgs, {
                cwd: projectRoot,
                stdio: values.json ? ['inherit', 'pipe', 'pipe'] : 'inherit',
                shell: false,
            })
            child.stdout?.pipe(process.stderr)
            child.stderr?.pipe(process.stderr)
            const interrupt = () => {
                child.kill('SIGINT')
            }
            process.once('SIGINT', interrupt)
            child.once('error', (error) => {
                process.removeListener('SIGINT', interrupt)
                reject(error)
            })
            child.once('exit', (code) => {
                process.removeListener('SIGINT', interrupt)
                accept(code)
            })
        })
        if (status !== 0)
            throw new Error(
                `Files were generated; migration generation failed (${status ?? 'interrupted'}). Fix the reported error and rerun liti generate.`,
            )
    }
    return {
        status: 'completed',
        files,
        messages: [
            values['schema-only']
                ? 'Schema-only generation completed; migrations were not generated and no application database was modified.'
                : commandArgs
                  ? 'Schema and migrations generated; no application database migrations were applied.'
                  : 'Generation completed. Database generation is not applicable; no application database was modified.',
            ...(nuxt ? ['Nuxt generates client types in its build directory during prepare, dev and build.'] : []),
        ],
    }
}
