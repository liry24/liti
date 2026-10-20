import semver from 'semver'
import type { LitiPluginManifest } from '../../liti/src/plugins'
import { catalog, installed, json, sections, type FileChange, type PackageManifest, type Project } from './project'

export const aliases: Record<string, string> = { blog: '@litijs/blog', ai: '@litijs/ai' }
type Metadata = { versions: Record<string, PackageManifest>; 'dist-tags'?: Record<string, string> }
export type Registry = (name: string) => Promise<Metadata>
const registryCache = new Map<string, Promise<Metadata>>()

export const registry: Registry = (name) => {
    if (!registryCache.has(name))
        registryCache.set(
            name,
            (async () => {
                const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
                    signal: AbortSignal.timeout(30_000),
                })
                if (!response.ok)
                    throw new Error(
                        `Cannot read ${name} registry metadata (${response.status}). No package commands ran.`,
                    )
                const data = (await response.json()) as Metadata
                if (!data.versions || typeof data.versions !== 'object')
                    throw new Error(`Invalid registry metadata for ${name}.`)
                return data
            })(),
        )
    return registryCache.get(name)!
}

export function pluginName(value: string) {
    const name = aliases[value] ?? value
    if (
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) ||
        (!aliases[value] && !name.startsWith('@') && !name.includes('-'))
    )
        throw new Error(
            `Unknown plugin alias "${value}". Use blog, ai, or a complete plugin package name with a liti manifest.`,
        )
    return name
}

export function pluginManifest(pkg: PackageManifest, name: string): LitiPluginManifest {
    const manifest = pkg.liti
    if (
        !manifest ||
        manifest.apiVersion !== 1 ||
        typeof manifest.id !== 'string' ||
        !manifest.id ||
        manifest.kind === 'adapter' ||
        typeof manifest.factory !== 'string' ||
        !/^[A-Za-z_$][\w$]*$/u.test(manifest.factory) ||
        typeof manifest.config !== 'string' ||
        !(manifest.config === name || manifest.config.startsWith(name + '/')) ||
        manifest.config
            .slice(name.length)
            .split('/')
            .some((part) => part === '.' || part === '..') ||
        typeof manifest.liti !== 'string' ||
        !semver.validRange(manifest.liti)
    )
        throw new Error(`${name} does not declare a compatible data-only liti plugin manifest.`)
    return manifest
}

function latest(metadata: Metadata, range: string, compatible: (pkg: PackageManifest) => boolean = () => true) {
    const version = Object.keys(metadata.versions)
        .filter(
            (value) => semver.valid(value) && semver.satisfies(value, range) && compatible(metadata.versions[value]!),
        )
        .sort(semver.rcompare)[0]
    if (!version) throw new Error(`No compatible package version satisfies ${range}.`)
    return { ...metadata.versions[version]!, version }
}

export async function pluginPackage(project: Project, name: string, core: string, load: Registry = registry) {
    const current = await installed(project.root, name)
    const entry = dependency(project.manifest, name)
    const value = entry?.value.startsWith('catalog:') ? (await catalog(project, name, entry.value)).value : entry?.value
    const range = value ? specifier(value, name).range : '*'
    if (
        current &&
        semver.satisfies(core, pluginManifest(current, name).liti) &&
        (!semver.validRange(range) || (!!current.version && semver.satisfies(current.version, range)))
    )
        return current
    if (!semver.validRange(range)) throw new Error(`Install the declared ${name}@${range} before adding its plugin.`)
    return latest(await load(name), range, (pkg) => !!pkg.liti && semver.satisfies(core, pkg.liti.liti))
}

export async function coreVersion(project: Project, fallback: string) {
    return (await installed(project.root, 'liti'))?.version ?? fallback
}

export function dependency(manifest: PackageManifest, name: string) {
    const section = sections.find((key) => manifest[key]?.[name] !== undefined)
    return section ? { section, value: manifest[section]![name]! } : undefined
}

function specifier(value: string, name: string) {
    if (value.startsWith('npm:')) {
        const split = value.lastIndexOf('@')
        if (split <= 4) throw new Error(`Unsupported npm alias ${value}.`)
        return { name: value.slice(4, split), range: value.slice(split + 1), prefix: value.slice(0, split + 1) }
    }
    return { name, range: value, prefix: '' }
}

function replacement(range: string, version: string) {
    if (!/^[~^]?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(range))
        throw new Error(
            `Cannot preserve version policy "${range}". Pin it or use a caret/tilde range before upgrading.`,
        )
    return (range.startsWith('^') || range.startsWith('~') ? range[0] : '') + version
}

export async function checkPeers(
    project: Project,
    packages: Record<string, PackageManifest>,
    addRequired: boolean,
    load: Registry = registry,
) {
    const additions: Record<string, string> = {}
    const selected: Record<string, PackageManifest> = { ...packages }
    for (const [name, pkg] of Object.entries(packages)) {
        for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
            let actual = selected[peer] ?? (await installed(project.root, peer))
            if (!actual) {
                if (pkg.peerDependenciesMeta?.[peer]?.optional) continue
                if (!addRequired)
                    throw new Error(`${name} requires ${peer}@${range}; install it explicitly before upgrading.`)
                actual = latest(await load(peer), range)
                additions[peer] = actual.version!
                selected[peer] = actual
            }
            if (!actual.version || !semver.satisfies(actual.version, range))
                throw new Error(
                    `${name} requires ${peer}@${range}, but the plan resolves ${actual.version ?? 'an unknown version'}.`,
                )
        }
    }
    return additions
}

export async function upgradePlan(
    project: Project,
    options: { to?: string; major?: boolean },
    load: Registry = registry,
) {
    const current = await installed(project.root, 'liti')
    if (!current?.version || !semver.valid(current.version))
        throw new Error('Install this project’s liti version before upgrading.')
    const parsed = semver.parse(current.version)!
    const target = options.to ?? (options.major ? '*' : `~${parsed.major}.${parsed.minor}.0`)
    if (!semver.validRange(target)) throw new Error(`Invalid --to version range: ${target}`)
    const core = latest(await load('liti'), target)
    if (!options.major && semver.major(core.version) !== parsed.major)
        throw new Error('A major version update requires --major.')
    const selected: Record<string, PackageManifest> = { liti: core }
    const entries = Object.fromEntries(sections.flatMap((key) => Object.entries(project.manifest[key] ?? {})))
    const managed = new Map<string, string>([['liti', 'liti']])
    for (const [key, value] of Object.entries(entries)) {
        const info = specifier(value, key)
        const existing = await installed(project.root, key)
        if (info.name !== 'liti' && !existing?.liti) continue
        if (info.name !== 'liti') {
            const pkg = latest(
                await load(info.name),
                '*',
                (candidate) => candidate.liti?.apiVersion === 1 && semver.satisfies(core.version, candidate.liti.liti),
            )
            selected[info.name] = pkg
            managed.set(key, info.name)
        }
    }
    // Only peers explicitly owned by an installed extension are managed; transitive ORM copies remain private to their owner.
    for (const pkg of Object.values(selected)) {
        for (const peer of pkg.liti?.managedPeers ?? []) {
            if (!(peer in entries)) continue
            const range = pkg.peerDependencies?.[peer]
            if (!range) throw new Error(`Missing declared compatibility range for managed peer ${peer}.`)
            selected[peer] = latest(await load(peer), range)
            managed.set(peer, peer)
        }
    }
    await checkPeers(project, selected, false, load)
    const manifest = structuredClone(project.manifest)
    const changes = new Map<string, FileChange>()
    const updates: Array<{ name: string; from: string; to: string; owner: string }> = []
    for (const [key, name] of managed) {
        const entry = dependency(manifest, key)
        if (!entry) continue
        const version = selected[name]!.version!
        if (entry.value.startsWith('workspace:')) {
            const local = await installed(project.root, key)
            if (local?.version !== version)
                throw new Error(
                    `${key} is a local workspace at ${local?.version}; update that workspace to ${version} first. Its workspace: link will be preserved.`,
                )
            continue
        }
        const owner = entry.value.startsWith('catalog:') ? await catalog(project, key, entry.value) : undefined
        const info = specifier(owner?.value ?? entry.value, key)
        const next = info.prefix + replacement(info.range, version)
        if (next === (owner?.value ?? entry.value)) continue
        if (owner) {
            const previous = changes.get(owner.path)
            changes.set(owner.path, {
                path: owner.path,
                before: owner.source,
                after: owner.update(previous?.after ?? owner.source, next),
            })
        } else manifest[entry.section]![key] = next
        updates.push({ name: key, from: owner?.value ?? entry.value, to: next, owner: owner?.path ?? project.path })
    }
    const before = changes.get(project.path)?.after ?? project.source
    if (before !== project.source) {
        const owned = JSON.parse(before!) as PackageManifest
        if (owned.catalog) manifest.catalog = owned.catalog
        if (owned.catalogs) manifest.catalogs = owned.catalogs
        if (owned.workspaces) manifest.workspaces = owned.workspaces
    }
    const after = json(project.source, manifest)
    if (after !== project.source) changes.set(project.path, { path: project.path, before: project.source, after })
    const installationRequired = (
        await Promise.all(
            [...managed].map(
                async ([key, name]) => (await installed(project.root, key))?.version !== selected[name]!.version,
            ),
        )
    ).some(Boolean)
    return {
        changes: [...changes.values()].filter((change) => change.before !== change.after),
        updates,
        core: core.version,
        installationRequired,
    }
}
