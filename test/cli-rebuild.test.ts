import { expect, it, vi } from 'vite-plus/test'
import * as nypm from 'nypm'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { editModules } from '../packages/liti/src/cli/config'
import { runCommand } from '../packages/liti/src/cli/run'

vi.mock('nypm', async (importOriginal) => {
    const actual = await importOriginal<typeof import('nypm')>()
    return { ...actual, addDependency: vi.fn(actual.addDependency) }
})

const manifest = {
    version: '0.0.3',
    dependencies: {
        '@litijs/model': 'https://pkg.pr.new/liry24/liti/@litijs/model@0123456789012345678901234567890123456789',
        'vite-hub': 'https://pkg.pr.new/vite-hub/vitehub/vite-hub@24ddab7ff9885d1b5ea176b8824f6e3f1a0e3ca9',
    },
}
async function project() {
    await mkdir('.tmp', { recursive: true })
    const cwd = await mkdtemp(resolve('.tmp/cli-rebuild-'))
    await writeFile(
        resolve(cwd, 'package.json'),
        JSON.stringify({ name: 'cli-synthetic', packageManager: 'bun@1.4.4' }),
    )
    await writeFile(
        resolve(cwd, 'nuxt.config.ts'),
        "// Keep this comment\nexport default defineNuxtConfig({modules: ['existing'], app: {head: {title:'Keep me'}}})\n",
    )
    const patch = resolve(cwd, 'distribution-patches')
    await mkdir(patch)
    await writeFile(resolve(patch, 'required.json'), JSON.stringify({ 'native@1.0.0': 'patches/native.patch' }))
    await writeFile(resolve(patch, 'native.patch'), 'native patch\n')
    return { cwd, patchDirectory: pathToFileURL(patch + '/') }
}
it('reports dependency installation changes when the package manager fails after scaffolding', async () => {
    const { cwd, patchDirectory } = await project()
    const install = vi.mocked(nypm.addDependency).mockRejectedValueOnce(new Error('Synthetic install failure'))
    try {
        await expect(runCommand(['init'], { cwd }, manifest, patchDirectory)).rejects.toThrow(
            'Dependency installation started; package.json, the lockfile and node_modules may have changed.',
        )
        expect(await readFile(resolve(cwd, 'server/content.ts'), 'utf8')).toContain('extends:cms')
        expect(install).toHaveBeenCalledOnce()
    } finally {
        install.mockClear()
    }
})
it('edits literal Nuxt modules idempotently while preserving comments/settings and refuses dynamic configuration', () => {
    const original =
        "// Preserve\nexport default defineNuxtConfig({modules: [['existing', {enabled:true}]], app:{head:{title:'Keep'}}})"
    const added = editModules(original, ['vite-hub/nuxt', 'liti/nuxt'], 'add')
    expect(added).toContain('// Preserve')
    expect(added).toMatch(/title:\s*'Keep'/u)
    expect(editModules(added, ['liti/nuxt'], 'add')).toBe(added)
    expect(editModules(added, ['liti/nuxt'], 'remove')).not.toContain("'liti/nuxt'")
    for (const source of [
        'export default await unsafe()',
        'export default defineNuxtConfig({...dynamic})',
        'export default defineNuxtConfig({modules:dynamic})',
        'export default defineNuxtConfig({modules:[...dynamic]})',
    ])
        expect(() => editModules(source, ['liti/nuxt'], 'add')).toThrow(/manual/)
})
it('plans explicit root patches/definitions without evaluating configuration, creating files or choosing an alpha update', async () => {
    const { cwd, patchDirectory } = await project()
    const original = await readFile(resolve(cwd, 'nuxt.config.ts'), 'utf8'),
        files = await readdir(cwd)
    const plan = await runCommand(['init'], { cwd, 'dry-run': true }, manifest, patchDirectory)
    expect(plan.join('\n')).toContain(resolve(cwd, 'server/content.ts'))
    expect(plan.join('\n')).toContain(resolve(cwd, 'patches/native.patch'))
    expect(await readdir(cwd)).toEqual(files)
    expect(await readFile(resolve(cwd, 'nuxt.config.ts'), 'utf8')).toBe(original)
    await expect(runCommand(['upgrade'], { cwd, 'dry-run': true }, manifest, patchDirectory)).rejects.toThrow('exact')
    await expect(
        runCommand(['upgrade'], { cwd, 'dry-run': true, to: 'latest' }, manifest, patchDirectory),
    ).rejects.toThrow('exact')
    const upgrade = await runCommand(
        ['upgrade'],
        { cwd, 'dry-run': true, to: '0123456789012345678901234567890123456789' },
        manifest,
        patchDirectory,
    )
    expect(upgrade.join('\n')).toContain(
        'liti@https://pkg.pr.new/liry24/liti/liti@0123456789012345678901234567890123456789',
    )
    expect(upgrade.join('\n')).not.toContain('Install vite-hub')
    await expect(runCommand(['init'], { cwd, 'package-manager': 'npm' }, manifest, patchDirectory)).rejects.toThrow(
        'Bun root patches',
    )
})
it('delegates generation to installed official tools with no migration command and propagates failure', async () => {
    const { cwd, patchDirectory } = await project()
    for (const [name, bin, expected] of [
        ['nuxt', 'nuxt', ['prepare']],
        ['vite-hub', 'vitehub', ['db', 'generate']],
    ] as const) {
        const directory = resolve(cwd, 'node_modules', name)
        await mkdir(directory, { recursive: true })
        await writeFile(
            resolve(directory, 'package.json'),
            JSON.stringify({
                name,
                type: 'module',
                bin: { [bin]: 'cli.js' },
                exports: { './package.json': './package.json' },
            }),
        )
        await writeFile(
            resolve(directory, 'cli.js'),
            `import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';assert.deepEqual(process.argv.slice(2),${JSON.stringify(expected)});writeFileSync('${bin}.generated','generated');`,
        )
    }
    await runCommand(['generate'], { cwd }, manifest, patchDirectory)
    expect(await readFile(resolve(cwd, 'vitehub.generated'), 'utf8')).toBe('generated')
    expect((await readdir(cwd)).some((path) => /\.db$/u.test(path))).toBe(false)
    await writeFile(resolve(cwd, 'node_modules/vite-hub/cli.js'), 'process.exitCode=1')
    await expect(runCommand(['generate'], { cwd }, manifest, patchDirectory)).rejects.toThrow(
        'No migration was requested',
    )
})
