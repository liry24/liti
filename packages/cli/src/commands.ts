import semver from 'semver'
import { resolve } from 'node:path'
import { editNuxt, editPlugin } from './edit'
import { coreVersion, pluginName, pluginPackage, pluginManifest, dependency, checkPeers, upgradePlan } from './packages'
import {
    project,
    readOptional,
    inside,
    installed,
    json,
    writeChanges,
    install,
    hasReferences,
    type FileChange,
} from './project'

export interface CliOptions {
    cwd?: string
    config?: string
    'package-manager'?: string
    'dry-run'?: boolean
    json?: boolean
    'no-interactive'?: boolean
    'no-install'?: boolean
    nuxt?: boolean
    'keep-package'?: boolean
    yes?: boolean
    to?: string
    major?: boolean
    env?: string[]
    out?: string
    'schema-only'?: boolean
}

export async function runCommand(command: string[], options: CliOptions, version: string) {
    const context = await project(options.cwd ?? process.cwd(), options['package-manager'])
    const configPath = inside(context.root, options.config ?? 'liti.config.ts')
    const original = await readOptional(configPath)
    const core = await coreVersion(context, version)
    if (
        semver.valid(core) &&
        semver.valid(version) &&
        `${semver.major(core)}.${semver.minor(core)}` !== `${semver.major(version)}.${semver.minor(version)}`
    )
        throw new Error(`This CLI is ${version}; the project uses liti ${core}. Run the project’s installed liti CLI.`)
    const manifest = structuredClone(context.manifest)
    let configuration: FileChange[] = []
    let dependencies: FileChange[] = []
    let updates: unknown[] = []
    const messages: string[] = []
    const mode = command[0]
    let installationRequired = false
    if (mode === 'init') {
        if (original === undefined)
            configuration.push({
                path: configPath,
                after: "import { defineLitiConfig } from 'liti'\n\nexport default defineLitiConfig({})\n",
            })
        if (!dependency(manifest, 'liti')) (manifest.dependencies ??= {}).liti = core
        installationRequired = !(await installed(context.root, 'liti'))
        if (options.nuxt) {
            const host = await installed(context.root, 'nuxt')
            const sdk = await installed(context.root, 'liti')
            const range = sdk?.peerDependencies?.nuxt ?? '^4.6.1'
            if (!host?.version || !semver.satisfies(host.version, range))
                throw new Error(`init --nuxt requires an installed Nuxt host compatible with ${range}.`)
            const path = resolve(context.root, 'nuxt.config.ts')
            const source = await readOptional(path)
            configuration.push({
                path,
                before: source,
                after:
                    source === undefined
                        ? "export default defineNuxtConfig({ modules: ['liti/nuxt'] })\n"
                        : editNuxt(source),
            })
        }
        if (original !== undefined) messages.push(`Existing ${configPath} retained.`)
    } else if (mode === 'plugin') {
        const action = command[1] as 'add' | 'remove'
        const name = pluginName(command[2]!)
        if (original === undefined) throw new Error(`Missing ${configPath}; run liti init first.`)
        const pkg = action === 'remove' ? await installed(context.root, name) : await pluginPackage(context, name, core)
        if (
            !pkg &&
            action === 'remove' &&
            !dependency(manifest, name) &&
            !(await hasReferences(context.workspace, name, configPath, original))
        )
            return {
                command: command.join(' '),
                status: options['dry-run'] ? 'planned' : 'unchanged',
                files: [],
                messages: [`${name} is already removed.`],
            }
        if (!pkg)
            throw new Error(
                `${name} is not installed; keep its package declaration until its manifest can be inspected.`,
            )
        const metadata = pluginManifest(pkg, name)
        if (!semver.satisfies(core, metadata.liti))
            throw new Error(`${name} requires liti ${metadata.liti}; the project has ${core}.`)
        const edited = editPlugin(original, configPath, name, metadata, action)
        configuration.push({ path: configPath, before: original, after: edited.source })
        if (action === 'add') {
            installationRequired =
                edited.source !== original || (await installed(context.root, name))?.version !== pkg.version
            const peers = await checkPeers(context, { liti: { version: core }, [name]: pkg }, true)
            for (const [peer, pinned] of Object.entries(peers))
                if (!dependency(manifest, peer)) (manifest.dependencies ??= {})[peer] = pinned
            if (!dependency(manifest, name)) (manifest.dependencies ??= {})[name] = pkg.version!
            messages.push(
                'Plugin activation follows successful dependency installation. Run liti generate when model schema changes are needed.',
            )
        } else {
            const keep =
                options['keep-package'] ||
                edited.keepPackage ||
                (await hasReferences(context.workspace, name, configPath, edited.source))
            if (keep)
                messages.push(
                    `${name} retained because ${options['keep-package'] ? '--keep-package was selected' : 'other configuration or source references remain'}.`,
                )
            else
                for (const key of ['dependencies', 'devDependencies'] as const)
                    if (manifest[key]) delete manifest[key]![name]
            messages.push(
                'Plugin registration removed; content, tables and history are retained. Run liti generate separately if needed.',
            )
        }
    } else if (mode === 'upgrade') {
        const plan = await upgradePlan(context, options)
        dependencies = plan.changes
        updates = plan.updates
        installationRequired = plan.installationRequired
        messages.push(
            'Only installed managed packages and declared direct tooling peers are updated. Run liti generate separately.',
        )
    }
    if (mode !== 'upgrade' && JSON.stringify(manifest) !== JSON.stringify(context.manifest))
        dependencies.push({ path: context.path, before: context.source, after: json(context.source, manifest) })
    configuration = configuration.filter((change) => change.before !== change.after)
    installationRequired ||= dependencies.length > 0
    const plan = {
        command: command.join(' '),
        cwd: context.root,
        packageManager: context.manager,
        dryRun: !!options['dry-run'],
        files: [...dependencies, ...configuration].map((change) => ({
            path: change.path,
            before: change.before ?? null,
            after: change.after,
        })),
        updates,
        commands:
            installationRequired && !options['no-install']
                ? [{ cwd: context.workspace, command: context.manager, args: ['install'] }]
                : [],
        messages,
    }
    if (options['dry-run']) return { ...plan, status: 'planned' }
    const changed: string[] = []
    try {
        if (mode === 'plugin' && command[1] === 'remove') {
            await writeChanges(configuration, changed)
        }
        await writeChanges(dependencies, changed)
        if (installationRequired && !options['no-install']) await install(context, !!options.json)
        if (!(mode === 'plugin' && command[1] === 'remove')) {
            await writeChanges(configuration, changed)
        }
    } catch (error) {
        throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nPartial completion: ${changed.join(', ') || 'no planned files changed'}. Package manager scripts/lockfiles may also have changed. Fix the error, complete ${context.manager} install, then rerun liti ${command.join(' ')}.`,
            { cause: error },
        )
    }
    if (options['no-install'])
        messages.push(
            `Dependencies were declared but not installed: ${Object.keys(manifest.dependencies ?? {}).join(', ')}. Run ${context.manager} install.`,
        )
    return {
        ...plan,
        status: options['no-install']
            ? 'installation-pending'
            : changed.length || installationRequired
              ? 'completed'
              : 'unchanged',
        changed,
    }
}
