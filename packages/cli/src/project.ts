import { readFile, writeFile, rename, rm, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { installDependencies, type PackageManagerName } from 'nypm'
import { parseDocument } from 'yaml'
import type { LitiPluginManifest } from '../../liti/src/plugins'

export interface PackageManifest {
    name?: string
    version?: string
    private?: boolean
    packageManager?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
    workspaces?:
        | string[]
        | { packages?: string[]; catalog?: Record<string, string>; catalogs?: Record<string, Record<string, string>> }
    catalog?: Record<string, string>
    catalogs?: Record<string, Record<string, string>>
    liti?: LitiPluginManifest & { kind?: 'plugin' | 'adapter'; managedPeers?: string[] }
}

export type FileChange = { path: string; before?: string | undefined; after: string }
export type Project = Awaited<ReturnType<typeof project>>
export const sections = ['dependencies', 'devDependencies'] as const

export function inside(root: string, filename: string) {
    const path = resolve(root, filename)
    const child = relative(root, path)
    if (isAbsolute(child) || child === '..' || child.startsWith('..\\') || child.startsWith('../') || !child)
        throw new Error(`The file must be inside the project: ${filename}`)
    return path
}

export async function readOptional(path: string) {
    try {
        return await readFile(path, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
    }
}

export function json(source: string | undefined, value: unknown) {
    const newline = source?.includes('\r\n') ? '\r\n' : '\n'
    return JSON.stringify(value, null, source?.match(/\n([ \t]+)"/u)?.[1] ?? '  ').replaceAll('\n', newline) + newline
}

export async function project(cwd: string, requestedManager?: string) {
    const root = resolve(cwd)
    const path = resolve(root, 'package.json')
    const source = await readOptional(path)
    const manifest: PackageManifest = source ? JSON.parse(source) : { private: true }
    let workspace = root
    let manager = requestedManager
    const locks = new Map<string, PackageManagerName>([
        ['bun.lock', 'bun'],
        ['bun.lockb', 'bun'],
        ['package-lock.json', 'npm'],
        ['npm-shrinkwrap.json', 'npm'],
        ['pnpm-lock.yaml', 'pnpm'],
        ['yarn.lock', 'yarn'],
    ])
    for (let directory = root; ; directory = dirname(directory)) {
        const data =
            directory === root
                ? manifest
                : (JSON.parse((await readOptional(resolve(directory, 'package.json'))) ?? '{}') as PackageManifest)
        const isWorkspace =
            directory === root || !!data.workspaces || existsSync(resolve(directory, 'pnpm-workspace.yaml'))
        if (isWorkspace) {
            if (directory !== root && (data.workspaces || existsSync(resolve(directory, 'pnpm-workspace.yaml'))))
                workspace = directory
            const found = new Set(
                [...locks].filter(([file]) => existsSync(resolve(directory, file))).map(([, name]) => name),
            )
            if (found.size > 1)
                throw new Error(
                    `Conflicting lockfiles in ${directory}; select one project package manager before changing dependencies.`,
                )
            const declared = data.packageManager?.split('@')[0]
            const lock = [...found][0]
            if (declared && lock && declared !== lock)
                throw new Error(`packageManager and lockfile disagree in ${directory}.`)
            manager ??= declared ?? lock
        }
        if (dirname(directory) === directory) break
    }
    manager ??= 'npm'
    if (!['npm', 'pnpm', 'bun', 'yarn'].includes(manager)) throw new Error(`Unsupported package manager: ${manager}`)
    return { root, workspace, path, source, manifest, manager: manager as PackageManagerName }
}

export async function installed(projectRoot: string, name: string): Promise<PackageManifest | undefined> {
    const require = createRequire(resolve(projectRoot, 'package.json'))
    const path = require.resolve
        .paths(name)
        ?.map((directory) => resolve(directory, name, 'package.json'))
        .find(existsSync)
    return path ? (JSON.parse(await readFile(path, 'utf8')) as PackageManifest) : undefined
}

export async function writeChanges(changes: FileChange[], written: string[] = []) {
    for (const change of changes) {
        if (change.before === change.after) continue
        if ((await readOptional(change.path)) !== change.before)
            throw new Error(`File changed while planning: ${change.path}. Rerun the command.`)
        await mkdir(dirname(change.path), { recursive: true })
        const temporary = `${change.path}.${process.pid}.tmp`
        try {
            await writeFile(temporary, change.after)
            await rename(temporary, change.path)
            written.push(change.path)
        } catch (error) {
            throw new Error(
                `Could not write ${change.path}. Files written before failure: ${written.join(', ') || 'none'}.`,
                { cause: error },
            )
        } finally {
            await rm(temporary, { force: true })
        }
    }
    return written
}

export async function install(context: Project, silent: boolean) {
    await installDependencies({ cwd: context.workspace, packageManager: context.manager, silent })
}

export async function hasReferences(root: string, packageName: string, configPath: string, configSource: string) {
    const pattern = new RegExp(`['"]${packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:/[^'"]*)?['"]`, 'u')
    if (pattern.test(configSource)) return true
    async function visit(directory: string): Promise<boolean> {
        for (const item of await readdir(directory, { withFileTypes: true })) {
            if (
                item.isSymbolicLink() ||
                item.name.startsWith('.') ||
                ['node_modules', 'dist', 'coverage'].includes(item.name)
            )
                continue
            const path = resolve(directory, item.name)
            if (item.isDirectory()) {
                if (await visit(path)) return true
            } else if (
                path !== configPath &&
                /\.(?:[cm]?[jt]sx?|vue)$/u.test(item.name) &&
                pattern.test(await readFile(path, 'utf8'))
            )
                return true
        }
        return false
    }
    return visit(root)
}

/** Catalog definitions are edited at their owner; consumers keep catalog: references. */
export async function catalog(context: Project, name: string, specifier: string) {
    const catalogName = specifier.slice('catalog:'.length)
    const yamlPath = resolve(context.workspace, 'pnpm-workspace.yaml')
    const yamlSource = await readOptional(yamlPath)
    if (yamlSource !== undefined) {
        const document = parseDocument(yamlSource)
        if (document.errors.length) throw new Error(`Invalid ${yamlPath}`)
        const keys = catalogName ? ['catalogs', catalogName, name] : ['catalog', name]
        const value = document.getIn(keys)
        if (typeof value !== 'string') throw new Error(`Missing ${specifier} definition for ${name}.`)
        return {
            value,
            path: yamlPath,
            source: yamlSource,
            update(source: string, replacement: string) {
                const next = parseDocument(source)
                next.setIn(keys, replacement)
                return next.toString()
            },
        }
    }
    const path = resolve(context.workspace, 'package.json')
    const source = (await readOptional(path))!
    const data = JSON.parse(source) as PackageManifest
    const owner = typeof data.workspaces === 'object' && !Array.isArray(data.workspaces) ? data.workspaces : data
    const value = catalogName ? owner.catalogs?.[catalogName]?.[name] : owner.catalog?.[name]
    if (typeof value !== 'string') throw new Error(`Missing ${specifier} definition for ${name}.`)
    return {
        value,
        path,
        source,
        update(current: string, replacement: string) {
            const next = JSON.parse(current) as PackageManifest
            const target =
                typeof next.workspaces === 'object' && !Array.isArray(next.workspaces) ? next.workspaces : next
            if (catalogName) target.catalogs![catalogName]![name] = replacement
            else target.catalog![name] = replacement
            return json(current, next)
        },
    }
}
