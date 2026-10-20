import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { createJiti } from 'jiti'
import type { LitiConfig, LitiConfigInput } from '../../liti/src/config'
import type { GenerationPlan } from '../../liti/src/plugins'
import { resolveLitiConfig } from '../../liti/src/config-resolution'
import { generateLitiDescriptor, generateLitiTypes } from '../../liti/src/tooling'
import { resolveGenerationCommand } from './command'

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        config: { type: 'string', default: 'liti.config.ts' },
        out: { type: 'string' },
        env: { type: 'string', multiple: true },
        prerender: { type: 'boolean', default: false },
        'schema-only': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
    },
})
if (positionals.length !== 1 || positionals[0] !== 'generate')
    throw new Error('Usage: liti generate [--config liti.config.ts] [--env production] [--schema-only] [--dry-run]')

const projectRoot = process.cwd()
const configPath = resolve(projectRoot, values.config)
const jiti = createJiti(configPath, { fsCache: false, moduleCache: false })
const loadModule = (specifier: string) => jiti.import<Record<string, unknown>>(specifier)
const loaded = (await loadModule(configPath)).default as LitiConfigInput
const environments = [
    process.env.NODE_ENV ?? 'development',
    ...(values.env ?? []),
    ...(values.prerender ? ['prerender'] : []),
]
const config = resolveLitiConfig(loaded, environments)
const tooling = config.adapter?.database?.tooling
if (!tooling && !values['schema-only'])
    throw new Error(
        'The selected database has no migration tooling. Configure its tooling or use --schema-only for types and descriptor generation.',
    )
const plan: GenerationPlan = tooling
    ? await tooling.generate(config as LitiConfig, {
          projectRoot,
          environment: environments,
          schemaOnly: values['schema-only'],
          ...(values.out ? { output: values.out } : {}),
          loadModule,
      })
    : { files: [] }
if (!values['schema-only'] && !plan.command)
    throw new Error('The selected database did not provide migration generation. Use --schema-only explicitly.')
if (values['schema-only'] && plan.command) throw new Error('Schema-only tooling must not request an external command.')
const configImport =
    './' +
    relative(projectRoot, configPath)
        .replaceAll('\\', '/')
        .replace(/\.(?:ts|mts|js|mjs)$/u, '')
plan.files.push(
    { path: 'liti.generated.ts', source: generateLitiTypes(configImport, environments) },
    { path: '.liti/descriptor.json', source: generateLitiDescriptor(config) },
)

const files = plan.files.map((file) => {
    const path = resolve(projectRoot, file.path)
    const child = relative(projectRoot, path)
    if (isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\') || !child)
        throw new Error(`Generated files must stay inside the project: ${file.path}`)
    return { ...file, path }
})
if (new Set(files.map(({ path }) => (process.platform === 'win32' ? path.toLowerCase() : path))).size !== files.length)
    throw new Error('The selected tooling produced conflicting output paths.')
const commandArgs = plan.command ? await resolveGenerationCommand(plan.command, projectRoot) : undefined
for (const file of files)
    console.log(`${file.createOnly && existsSync(file.path) ? 'Keep' : 'Generate'} ${relative(projectRoot, file.path)}`)
if (plan.command)
    console.log(
        `Run installed ${plan.command.package}@${plan.command.version}: ${plan.command.bin} ${plan.command.args.join(' ')}`,
    )
if (values['dry-run']) {
    console.log('Dry run complete; no files or dependencies changed and no command was executed.')
} else {
    for (const file of files) {
        if (file.createOnly && existsSync(file.path)) continue
        await mkdir(dirname(file.path), { recursive: true })
        const temporary = `${file.path}.${process.pid}.tmp`
        try {
            await writeFile(temporary, file.source)
            await rename(temporary, file.path)
        } finally {
            await rm(temporary, { force: true })
        }
    }
    if (commandArgs) {
        const status = await new Promise<number | null>((accept, reject) => {
            const child = spawn(process.execPath, commandArgs, {
                cwd: projectRoot,
                stdio: 'inherit',
                shell: false,
            })
            child.once('error', reject)
            child.once('exit', accept)
        })
        if (status !== 0)
            throw new Error(
                `Schema, types and descriptor were generated; migration generation failed (${status ?? 'interrupted'}). Fix the reported error and rerun liti generate.`,
            )
    }
    console.log(
        values['schema-only']
            ? 'Schema-only generation completed; migrations were not generated and no application database was modified.'
            : 'Schema, types, descriptor and migrations generated; no application database migrations were applied.',
    )
}
