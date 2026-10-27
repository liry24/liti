import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { addDependency, detectPackageManager, installDependencies } from 'nypm'
import { editModules } from './config'

interface Manifest {
    version: string
    dependencies: Record<string, string>
}
interface Options {
    cwd?: string
    'dry-run'?: boolean
    json?: boolean
    'package-manager'?: string
    to?: string
}
interface Change {
    path: string
    before: string | null
    source: string
}
const read = async (path: string) => (existsSync(path) ? await readFile(path, 'utf8') : null)
const cohort = (name: string, specifier: string) =>
    /^[a-f0-9]{40}$/u.test(specifier)
        ? `https://pkg.pr.new/liry24/liti/${name}@${specifier}`
        : /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(specifier)
          ? specifier
          : null

export async function runCommand(commands: string[], options: Options, manifest: Manifest, patchDirectory: URL) {
    const [command, feature] = commands
    if (
        !command ||
        !['init', 'add', 'remove', 'generate', 'upgrade'].includes(command) ||
        (command === 'add' || command === 'remove'
            ? feature !== 'blog' || commands.length !== 2
            : commands.length !== 1)
    )
        throw new Error('Invalid command. Run liti --help.')
    if (options.to !== undefined && command !== 'upgrade') throw new Error('--to applies only to upgrade.')
    const cwd = resolve(options.cwd ?? process.cwd())
    const projectFile = resolve(cwd, 'package.json'),
        source = await read(projectFile)
    if (!source) throw new Error('Run this command inside a Nuxt project with package.json.')
    const project = JSON.parse(source) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        patchedDependencies?: Record<string, string>
    }
    const dependencies = { ...project.devDependencies, ...project.dependencies }
    const manager = options['package-manager'] ?? (await detectPackageManager(cwd, { ignoreArgv: true }))?.name ?? 'bun'
    if (manager !== 'bun' && manager !== 'npm' && manager !== 'pnpm') throw new Error('Choose bun, npm or pnpm.')
    const changes: Change[] = [],
        messages: string[] = [],
        packages: string[] = []
    const change = async (path: string, content: string, create = false) => {
        const absolute = resolve(cwd, path),
            before = await read(absolute)
        if (create && before !== null) {
            messages.push(`Keep existing ${path}`)
            return
        }
        if (before !== content) changes.push({ path: absolute, before, source: content })
    }
    if (command === 'init' || command === 'add' || command === 'remove') {
        const nuxtPath = resolve(cwd, 'nuxt.config.ts'),
            nuxt = await read(nuxtPath)
        if (nuxt === null) throw new Error('Create nuxt.config.ts before registering modules.')
        await change(
            'nuxt.config.ts',
            editModules(
                nuxt,
                command === 'init' ? ['vite-hub/nuxt', 'liti/nuxt'] : ['@litijs/blog/nuxt'],
                command === 'remove' ? 'remove' : 'add',
            ),
        )
    }
    if (command === 'init') {
        if (manager !== 'bun')
            throw new Error(
                'This pinned ViteHub alpha requires explicit Bun root patches. Use Bun for the CMS runtime; bare Model/Blog imports support other package managers.',
            )
        for (const name of ['@litijs/model', 'vite-hub']) {
            const spec = manifest.dependencies[name]
            if (!spec || spec.startsWith('workspace:'))
                throw new Error('Run init from a packed commit-specific Liti distribution.')
            if (name === 'vite-hub' && dependencies[name] && dependencies[name] !== spec)
                throw new Error(
                    'The project selects a different ViteHub distribution. Verify that alpha cohort separately before changing it. No files changed.',
                )
            if (!dependencies[name]) packages.push(`${name}@${spec}`)
        }
        if (!dependencies.zod) packages.push('zod@4.6.7')
        if (!dependencies.liti) {
            const model = manifest.dependencies['@litijs/model']!
            packages.unshift(
                `liti@${model.startsWith('https://pkg.pr.new/') ? model.replace('/@litijs/model@', '/liti@') : manifest.version}`,
            )
        }
        const required = JSON.parse(await readFile(new URL('required.json', patchDirectory), 'utf8')) as Record<
            string,
            string
        >
        const rootPatches = { ...project.patchedDependencies }
        for (const [target, path] of Object.entries(required)) {
            const patch = await readFile(new URL(path.split('/').at(-1)!, patchDirectory), 'utf8')
            const existing = await read(resolve(cwd, path))
            if (existing !== null && existing !== patch)
                throw new Error(`Existing ${path} differs from the pinned patch. No files changed.`)
            if (rootPatches[target] && rootPatches[target] !== path)
                throw new Error(`Existing root patch for ${target} requires review. No files changed.`)
            await change(path, patch)
            rootPatches[target] = path
        }
        project.patchedDependencies = rootPatches
        await change('package.json', JSON.stringify(project, null, 2) + '\n')
        if ((await read(resolve(cwd, 'server/content.ts'))) !== null)
            messages.push(
                'Keep existing Content/model definitions; connect any additional model explicitly in server/content.ts.',
            )
        else {
            if ((await read(resolve(cwd, 'server/models/posts.ts'))) !== null)
                throw new Error('Connect the existing posts model in server/content.ts manually. No files changed.')
            await change(
                'server/models/posts.ts',
                `import {defineContentModel, field} from '@litijs/model'\nimport {z} from 'zod'\nexport const posts = defineContentModel({\n    name:'posts', title:'title', fields:{title:field(z.string().min(1)), slug:field(z.string().min(1))},\n    url:({data})=>'/posts/'+data.slug,\n    authorize:()=>false, // Configure an explicit native Auth policy before enabling management.\n})\n`,
                true,
            )
        }
        await change(
            'server/content.ts',
            `import {defineContent} from 'vite-hub/content'\nimport {cms} from 'vite-hub/content/presets/cms'\nimport {contentCollection} from '@litijs/model/content'\nimport {posts} from './models/posts'\nexport const content = defineContent({extends:cms, collections:{posts:contentCollection(posts)}, authorize:()=>false})\n`,
            true,
        )
        messages.push(
            'Configure durable native Auth and explicit Model/Content policies before management. No authentication engine or database is scaffolded implicitly.',
        )
    }
    if (command === 'add') {
        const model = manifest.dependencies['@litijs/model']
        if (!model || model.startsWith('workspace:')) throw new Error('Use a packed Liti distribution.')
        const spec = model.startsWith('https://pkg.pr.new/')
            ? model.replace('/@litijs/model@', '/@litijs/blog@')
            : manifest.version
        packages.push(`@litijs/blog@${spec}`)
    }
    if (command === 'remove')
        messages.push(
            'Existing article models and content are retained. Remove the package manually after its remaining application imports have been migrated.',
        )
    if (command === 'upgrade') {
        if (!options.to)
            throw new Error(
                'Choose an exact version or full commit SHA with --to; alpha updates are never selected automatically.',
            )
        for (const name of ['liti', '@litijs/model', ...(dependencies['@litijs/blog'] ? ['@litijs/blog'] : [])]) {
            const spec = cohort(name, options.to)
            if (!spec) throw new Error('--to requires an exact version or full commit SHA.')
            packages.push(`${name}@${spec}`)
        }
    }
    const tools =
        command === 'generate'
            ? ([
                  ['nuxt', 'nuxt', ['prepare']],
                  ['vite-hub', 'vitehub', ['db', 'generate']],
              ] as const)
            : []
    const plannedTools = tools.map(([name, bin, args]) => {
        const require = createRequire(projectFile),
            path = require.resolve(`${name}/package.json`)
        const pkg = require(path) as { bin: Record<string, string> }
        if (!pkg.bin[bin]) throw new Error(`Missing official ${bin} executable.`)
        return [resolve(dirname(path), pkg.bin[bin]), ...args]
    })
    const plan = [
        ...changes.map((file) => `File ${file.path}`),
        ...packages.map((name) => `Install ${name}`),
        ...plannedTools.map((args) => `Run node ${args.join(' ')}`),
        ...messages,
    ]
    if (options['dry-run'])
        return ['Dry run: no files, dependencies, configuration evaluation or database changes.', ...plan]
    const changed: string[] = []
    try {
        for (const file of changes) {
            if ((await read(file.path)) !== file.before) throw new Error(`File changed after planning: ${file.path}`)
            await mkdir(dirname(file.path), { recursive: true })
            await writeFile(file.path, file.source)
            changed.push(file.path)
        }
        if (packages.length) await addDependency(packages, { cwd, packageManager: manager })
        else if (command === 'init') await installDependencies({ cwd, packageManager: manager })
        if (command === 'upgrade') {
            const require = createRequire(projectFile),
                installed = JSON.parse(await readFile(require.resolve('liti/package.json'), 'utf8')) as Manifest
            if (installed.dependencies['vite-hub'] !== manifest.dependencies['vite-hub'])
                throw new Error(
                    'The selected cohort changes ViteHub alpha. Review its contract tests and root patches as a separate change before using it.',
                )
            const directory = resolve(dirname(require.resolve('liti/package.json')), 'dist/patches')
            const required = JSON.parse(await readFile(resolve(directory, 'required.json'), 'utf8')) as Record<
                string,
                string
            >
            const current = JSON.parse((await read(projectFile))!) as typeof project
            for (const [target, path] of Object.entries(required))
                if (
                    current.patchedDependencies?.[target] !== path ||
                    (await read(resolve(cwd, path))) !== (await read(resolve(directory, path.split('/').at(-1)!)))
                )
                    throw new Error(
                        `The selected cohort requires reviewed root patch ${target}. Run its explicit init after reviewing the patch difference; this upgrade has not passed acceptance.`,
                    )
        }
        for (const args of plannedTools) {
            const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true })
            if (result.error) throw result.error
            if (result.status !== 0)
                throw new Error(
                    `Official generator failed (${result.status}); inspect its diagnostics. No migration was requested.`,
                )
        }
    } catch (error) {
        throw new Error(
            `Command incomplete. Written files: ${changed.join(', ') || 'none'}. ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        )
    }
    return ['Complete. No database migration was requested.', ...plan]
}
