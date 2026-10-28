import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const commit = process.argv[2]
assert.match(commit, /^[a-f0-9]{40}$/u)
const root = process.cwd(),
    directory = resolve(root, '.tmp', 'preview-' + commit)
await mkdir(directory, { recursive: true })
const native = JSON.parse(await readFile('patches/manifest.json', 'utf8')).vitehubCommit
const required = JSON.parse(await readFile('package.json', 'utf8')).patchedDependencies
const names = ['@litijs/model', 'liti', '@litijs/blog']
const member = (file, path) => {
    const result = spawnSync('tar', ['-xOf', file, 'package/' + path], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
}
const results = await Promise.all(
    names.map(async (name) => {
        const url = `https://pkg.pr.new/liry24/liti/${name}@${commit}`
        const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
        assert.ok(response.ok, `${response.status} ${url}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        const path = join(directory, name.split('/').at(-1) + '.tgz')
        await writeFile(path, bytes)
        const manifest = JSON.parse(member(path, 'package.json'))
        assert.equal(manifest.name, name)
        assert.equal(manifest.version, `0.0.0-preview-${commit.slice(0, 7)}`)
        assert.ok(member(path, 'LICENSE').includes('MIT License'))
        assert.doesNotMatch(
            JSON.stringify(manifest),
            /workspace:|@litijs\/(?:ai|void|sqlite|drizzle|test-utils)(?:["/])/u,
        )
        assert.equal(manifest.scripts.postinstall, undefined)
        for (const [dependency, spec] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
            if (names.includes(dependency)) assert.equal(spec, `https://pkg.pr.new/liry24/liti/${dependency}@${commit}`)
            if (dependency === 'vite-hub' || dependency.startsWith('@vite-hub/'))
                assert.equal(spec, `https://pkg.pr.new/vite-hub/vitehub/${dependency}@${native}`)
        }
        if (name === 'liti') {
            assert.deepEqual(JSON.parse(member(path, 'dist/patches/required.json')), required)
            for (const patch of Object.values(required))
                assert.equal(
                    member(path, 'dist/patches/' + patch.split('/').at(-1)),
                    await readFile(resolve(patch), 'utf8'),
                )
            assert.match(member(path, 'dist/nuxt/index.d.ts'), /from "nuxt\/schema"/u)
            assert.doesNotMatch(member(path, 'dist/nuxt/index.d.ts'), /@nuxt\/schema/u)
        }
        return {
            name,
            url,
            path,
            version: manifest.version,
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            dependencies: manifest.dependencies,
            peerDependencies: manifest.peerDependencies,
        }
    }),
)
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ commit, native, artifacts: results }, null, 2))
await writeFile(join(directory, 'tarballs.json'), JSON.stringify(results.map((item) => item.path)))
if (process.env.GITHUB_ENV)
    await appendFile(process.env.GITHUB_ENV, `LITI_TARBALLS=${JSON.stringify(results.map((item) => item.path))}\n`)
console.log(
    JSON.stringify(
        {
            commit,
            native,
            manifest: join(directory, 'manifest.json'),
            artifacts: results.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
        },
        null,
        2,
    ),
)
