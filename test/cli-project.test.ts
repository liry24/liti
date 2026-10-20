import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as projectTools from '../packages/cli/src/project'
import { runCommand } from '../packages/cli/src/commands'
import { upgradePlan, pluginName, type Registry } from '../packages/cli/src/packages'
import type { PackageManifest } from '../packages/cli/src/project'

const directories: string[] = []
afterEach(async () => {
    vi.restoreAllMocks()
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function fixture(manifest: PackageManifest = { private: true, packageManager: 'bun@1.4.3' }) {
    const root = await mkdtemp(join(tmpdir(), 'liti CLI 日本語 '))
    directories.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    return root
}
async function packageAt(root: string, name: string, manifest: PackageManifest) {
    const path = join(root, 'node_modules', name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, ...manifest }))
}
const blog = (version = '0.1.0'): PackageManifest => ({
    version,
    liti: {
        id: 'blog',
        apiVersion: 1,
        kind: 'plugin',
        liti: '^0.1.0',
        factory: 'blog',
        config: '@litijs/blog',
        options: { models: { posts: {} } },
    },
    peerDependencies: { liti: '^0.1.0', '@litijs/ai': '^0.1.0' },
    peerDependenciesMeta: { '@litijs/ai': { optional: true } },
})
const registry =
    (packages: Record<string, PackageManifest[]>): Registry =>
    async (name) => {
        if (!packages[name]) throw new Error(`Unexpected registry lookup: ${name}`)
        return { versions: Object.fromEntries(packages[name].map((pkg) => [pkg.version!, { name, ...pkg }])) }
    }

describe('CLI project changes', () => {
    it('initializes a minimal pinned config without optional platforms; no-install and retry are explicit', async () => {
        const root = await fixture()
        const install = vi.spyOn(projectTools, 'install').mockResolvedValue()
        const preview = await runCommand(['init'], { cwd: root, 'dry-run': true }, '0.1.0')
        expect(preview.status).toBe('planned')
        expect(await readdir(root)).toEqual(['package.json'])
        const result = await runCommand(['init'], { cwd: root, 'no-install': true }, '0.1.0')
        expect(result.status).toBe('installation-pending')
        expect(await readFile(join(root, 'liti.config.ts'), 'utf8')).toBe(
            "import { defineLitiConfig } from 'liti'\n\nexport default defineLitiConfig({})\n",
        )
        const data = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
        expect(data.dependencies).toEqual({ liti: '0.1.0' })
        expect(install).not.toHaveBeenCalled()
        await packageAt(root, 'liti', { version: '0.1.0' })
        expect((await runCommand(['init'], { cwd: root }, '0.1.0')).status).toBe('unchanged')
        expect(install).not.toHaveBeenCalled()
    })

    it('activates only after install, reuses options on retry, and removes before uninstall', async () => {
        const root = await fixture({ dependencies: { liti: '0.1.0' }, packageManager: 'bun@1.4.3' })
        await packageAt(root, 'liti', { version: '0.1.0' })
        await packageAt(root, '@litijs/blog', blog())
        const source = "import { defineLitiConfig } from 'liti'\nexport default defineLitiConfig({})\n"
        await writeFile(join(root, 'liti.config.ts'), source)
        const install = vi.spyOn(projectTools, 'install').mockImplementation(async () => {
            expect(await readFile(join(root, 'liti.config.ts'), 'utf8')).toBe(source)
        })
        await runCommand(['plugin', 'add', 'blog'], { cwd: root }, '0.1.0')
        expect(install).toHaveBeenCalledTimes(1)
        const activated = await readFile(join(root, 'liti.config.ts'), 'utf8')
        expect(activated).toContain('plugins: [blog(')
        expect(activated).not.toContain('@litijs/ai')
        expect((await runCommand(['plugin', 'add', 'blog'], { cwd: root }, '0.1.0')).status).toBe('unchanged')
        expect(install).toHaveBeenCalledTimes(1)
        install.mockImplementation(async () => {
            expect(await readFile(join(root, 'liti.config.ts'), 'utf8')).not.toContain('blog(')
        })
        await runCommand(['plugin', 'remove', 'blog'], { cwd: root }, '0.1.0')
        expect(install).toHaveBeenCalledTimes(2)
        expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies).toEqual({ liti: '0.1.0' })
    })

    it('reports partial installation failure without enabling the plugin and refuses dynamic config before install', async () => {
        const root = await fixture({ dependencies: { liti: '0.1.0' } })
        await packageAt(root, 'liti', { version: '0.1.0' })
        await packageAt(root, '@litijs/blog', blog())
        const path = join(root, 'liti.config.ts')
        await writeFile(path, 'export default { plugins: compute() }')
        const install = vi.spyOn(projectTools, 'install').mockRejectedValue(new Error('installer stopped'))
        await expect(runCommand(['plugin', 'add', 'blog'], { cwd: root, yes: true }, '0.1.0')).rejects.toThrow(
            'No configuration was changed',
        )
        expect(install).not.toHaveBeenCalled()
        await writeFile(path, 'export default {}')
        await expect(runCommand(['plugin', 'add', 'blog'], { cwd: root }, '0.1.0')).rejects.toThrow(
            'Partial completion',
        )
        expect(await readFile(path, 'utf8')).toBe('export default {}')
        expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies['@litijs/blog']).toBe(
            '0.1.0',
        )
        install.mockResolvedValue()
        await runCommand(['plugin', 'add', 'blog'], { cwd: root }, '0.1.0')
        expect(install).toHaveBeenCalledTimes(2)
        expect(await readFile(path, 'utf8')).toContain('blog(')
    })

    it('rejects unknown aliases, conflicting locks and incompatible hosts without mutation', async () => {
        expect(() => pluginName('unknown')).toThrow('Unknown plugin alias')
        const root = await fixture()
        await writeFile(join(root, 'bun.lock'), '')
        await writeFile(join(root, 'package-lock.json'), '{}')
        await expect(projectTools.project(root)).rejects.toThrow('Conflicting lockfiles')
        await rm(join(root, 'package-lock.json'))
        await expect(runCommand(['init'], { cwd: root, nuxt: true }, '0.1.0')).rejects.toThrow('installed Nuxt host')
        expect(await readdir(root)).toEqual(['bun.lock', 'package.json'])
    })
})

describe('CLI compatible upgrade planning', () => {
    it('updates only managed direct dependencies, keeping pin styles and separate Drizzle owners', async () => {
        const root = await fixture({
            dependencies: {
                liti: '^0.1.0',
                '@litijs/blog': '~0.1.0',
                '@litijs/void': '0.1.0',
                '@litijs/drizzle': '^0.1.0',
                'drizzle-orm': '1.0.0-rc.4',
                void: '1.1.12',
                unrelated: '^3.0.0',
            },
            devDependencies: { 'drizzle-kit': '1.0.0-rc.4' },
        })
        const adapter = (name: string, version: string, peers: Record<string, string>): PackageManifest => ({
            version,
            liti: {
                id: name,
                apiVersion: 1,
                kind: 'adapter',
                liti: '^0.1.0',
                factory: name,
                config: `@litijs/${name}`,
                managedPeers: Object.keys(peers),
            },
            peerDependencies: { liti: '^0.1.0', ...peers },
            dependencies: name === 'void' ? { 'drizzle-orm': '0.45.4' } : {},
        })
        await packageAt(root, 'liti', { version: '0.1.0' })
        await packageAt(root, '@litijs/blog', blog())
        await packageAt(root, '@litijs/void', adapter('void', '0.1.0', { void: '1.1.12' }))
        await packageAt(
            root,
            '@litijs/drizzle',
            adapter('drizzle', '0.1.0', { 'drizzle-orm': '1.0.0-rc.4', 'drizzle-kit': '1.0.0-rc.4' }),
        )
        const load = registry({
            liti: [{ version: '0.1.1' }, { version: '0.2.0' }],
            '@litijs/blog': [blog('0.1.1')],
            '@litijs/void': [adapter('void', '0.1.1', { void: '1.1.12' })],
            '@litijs/drizzle': [
                adapter('drizzle', '0.1.1', { 'drizzle-orm': '1.0.0-rc.5', 'drizzle-kit': '1.0.0-rc.5' }),
            ],
            void: [{ version: '1.1.12' }],
            'drizzle-orm': [{ version: '1.0.0-rc.5' }],
            'drizzle-kit': [{ version: '1.0.0-rc.5' }],
        })
        const plan = await upgradePlan(await projectTools.project(root), {}, load)
        const output = JSON.parse(plan.changes[0]!.after)
        expect(output.dependencies).toMatchObject({
            liti: '^0.1.1',
            '@litijs/blog': '~0.1.1',
            '@litijs/void': '0.1.1',
            void: '1.1.12',
            'drizzle-orm': '1.0.0-rc.5',
            unrelated: '^3.0.0',
        })
        expect(output.devDependencies['drizzle-kit']).toBe('1.0.0-rc.5')
        expect(output.overrides).toBeUndefined()
        expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies.liti).toBe('^0.1.0')
    })

    it('updates the Bun catalog owner and npm alias while retaining workspace links', async () => {
        const root = await fixture({
            workspaces: { packages: ['app'], catalog: { liti: '^0.1.0' } },
            packageManager: 'bun@1.4.3',
        })
        const app = join(root, 'app')
        await mkdir(app)
        await writeFile(
            join(app, 'package.json'),
            JSON.stringify({
                dependencies: {
                    liti: 'catalog:',
                    '@litijs/blog': 'npm:@litijs/blog@~0.1.0',
                    '@litijs/ai': 'workspace:*',
                },
            }),
        )
        await packageAt(app, 'liti', { version: '0.1.0' })
        await packageAt(app, '@litijs/blog', blog())
        await packageAt(app, '@litijs/ai', {
            version: '0.1.1',
            liti: { id: 'ai', apiVersion: 1, kind: 'plugin', liti: '^0.1.0', factory: 'ai', config: '@litijs/ai' },
        })
        const plan = await upgradePlan(
            await projectTools.project(app),
            {},
            registry({
                liti: [{ version: '0.1.1' }],
                '@litijs/blog': [blog('0.1.1')],
                '@litijs/ai': [
                    {
                        version: '0.1.1',
                        liti: { id: 'ai', apiVersion: 1, liti: '^0.1.0', factory: 'ai', config: '@litijs/ai' },
                    },
                ],
            }),
        )
        expect(
            JSON.parse(plan.changes.find((change) => change.path === join(root, 'package.json'))!.after).workspaces
                .catalog.liti,
        ).toBe('^0.1.1')
        const output = JSON.parse(plan.changes.find((change) => change.path === join(app, 'package.json'))!.after)
        expect(output.dependencies).toEqual({
            liti: 'catalog:',
            '@litijs/blog': 'npm:@litijs/blog@~0.1.1',
            '@litijs/ai': 'workspace:*',
        })
    })

    it('rejects host peer conflicts and unsupported version expressions before changing files', async () => {
        const root = await fixture({ dependencies: { liti: '^0.1.0', '@litijs/blog': '>=0.1.0', vue: '3.5.0' } })
        await packageAt(root, 'liti', { version: '0.1.0' })
        await packageAt(root, '@litijs/blog', blog())
        await packageAt(root, 'vue', { version: '3.5.0' })
        const load = registry({
            liti: [{ version: '0.1.1' }],
            '@litijs/blog': [{ ...blog('0.1.1'), peerDependencies: { vue: '^3.6.0' } }],
        })
        await expect(upgradePlan(await projectTools.project(root), {}, load)).rejects.toThrow('requires vue@')
        await expect(
            upgradePlan(
                await projectTools.project(root),
                {},
                registry({ liti: [{ version: '0.1.1' }], '@litijs/blog': [blog('0.1.1')] }),
            ),
        ).rejects.toThrow('Cannot preserve version policy')
    })

    it('updates a named pnpm catalog while preserving YAML comments and consumer references', async () => {
        const root = await fixture({ dependencies: { liti: 'catalog:sdk' }, packageManager: 'pnpm@10.0.0' })
        await packageAt(root, 'liti', { version: '0.1.0' })
        await writeFile(
            join(root, 'pnpm-workspace.yaml'),
            'packages:\n  - app\ncatalogs:\n  sdk:\n    liti: ^0.1.0 # shared SDK\n',
        )
        const plan = await upgradePlan(await projectTools.project(root), {}, registry({ liti: [{ version: '0.1.1' }] }))
        expect(plan.changes).toHaveLength(1)
        expect(plan.changes[0]!.path).toBe(join(root, 'pnpm-workspace.yaml'))
        expect(plan.changes[0]!.after).toContain('liti: ^0.1.1 # shared SDK')
        expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies.liti).toBe('catalog:sdk')
    })
})
