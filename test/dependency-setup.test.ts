import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Nuxt } from 'nuxt/schema'

const installed = vi.hoisted(() => new Set<string>())
vi.mock('nuxt/kit', async (importOriginal) => ({
    ...(await importOriginal<typeof import('nuxt/kit')>()),
    tryResolveModule: async (name: string) => (installed.has(name) ? `/installed/${name}` : undefined),
}))
const { ensureLitiDependencies } = await import('../packages/nuxt/src/nuxt/dependencies')
const roots: string[] = []
const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'liti-dependency-test-'))
    roots.push(root)
    const project = JSON.stringify({
        private: true,
        dependencies: { comark: 'workspace:*' },
        overrides: { auth: '1.7.9' },
        patchedDependencies: { existing: 'existing.patch' },
    })
    await writeFile(join(root, 'package.json'), project)
    await writeFile(join(root, 'bun.lock'), 'existing lockfile')
    return { root, project, nuxt: { options: { rootDir: root, modulesDir: [] } } as unknown as Nuxt }
}
beforeEach(() => {
    installed.clear()
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['', 'true'])('reports absent peers without modifying manifest or lockfile (CI=%s)', async (ci) => {
    vi.stubEnv('CI', ci)
    const { root, project, nuxt } = await fixture()
    await expect(ensureLitiDependencies(nuxt, ['comark'])).rejects.toThrow('Missing dependencies: comark')
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(project)
    expect(await readFile(join(root, 'bun.lock'), 'utf8')).toBe('existing lockfile')
    installed.add('comark')
    await expect(ensureLitiDependencies(nuxt, ['comark'])).resolves.toBeUndefined()
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(project)
})
