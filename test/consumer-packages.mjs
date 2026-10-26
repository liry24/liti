import assert from 'node:assert/strict'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('../', import.meta.url))
export const publicPackages = (
    await Promise.all(
        (await readdir(join(workspace, 'packages'))).map(async (directory) => {
            const manifest = JSON.parse(await readFile(join(workspace, 'packages', directory, 'package.json'), 'utf8'))
            return manifest.private ? [] : [directory]
        }),
    )
).flat()

/** All consumers install the same public archives, including uppt's exact release artifacts. */
export const consumerPackages = async (directory, run) => {
    let files = process.env.LITI_TARBALLS ? JSON.parse(process.env.LITI_TARBALLS) : undefined
    if (!files) {
        files = []
        for (const folder of publicPackages) {
            const output = join(directory, folder)
            await mkdir(output, { recursive: true })
            run('bun', ['pm', 'pack', '--destination', output, '--ignore-scripts'], join(workspace, 'packages', folder))
            const filename = (await readdir(output)).find((name) => name.endsWith('.tgz'))
            assert.ok(filename, `Missing archive for ${folder}`)
            files.push(join(output, filename))
        }
    }
    assert.ok(Array.isArray(files))
    const packages = {}
    for (const file of files) {
        const path = resolve(file)
        const manifest = JSON.parse(run('tar', ['-xOf', path, 'package/package.json'], directory))
        assert.equal(packages[manifest.name], undefined, `Duplicate archive: ${manifest.name}`)
        assert.doesNotMatch(JSON.stringify(manifest.dependencies ?? {}), /workspace:/u)
        assert.ok(run('tar', ['-xOf', path, 'package/LICENSE'], directory).includes('MIT License'))
        packages[manifest.name] = path
    }
    assert.deepEqual(
        Object.keys(packages).sort(),
        publicPackages.map((name) => (name === 'liti' ? name : `@litijs/${name}`)).sort(),
    )
    return packages
}

export const archiveDependencies = (packages, names) =>
    Object.fromEntries(names.map((name) => [name, 'file:' + packages[name].replaceAll('\\', '/')]))

// Registry versions do not exist before the first release; all first-party edges must use the candidate archives.
export const archiveOverrides = (packages, manager, names = ['liti', '@litijs/sqlite']) => {
    const dependency = archiveDependencies(packages, names)
    return manager === 'pnpm'
        ? { pnpm: { overrides: dependency } }
        : { overrides: manager === 'npm' ? Object.fromEntries(names.map((name) => [name, '$' + name])) : dependency }
}
