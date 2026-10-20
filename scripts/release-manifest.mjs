import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { consumerPackages } from '../test/consumer-packages.mjs'

assert.ok(process.env.LITI_TARBALLS, 'Use the existing uppt artifacts; this command never builds or packs')
const packages = await consumerPackages(process.cwd(), (command, args) =>
    execFileSync(command, args, { encoding: 'utf8' }),
)
const artifacts = []
for (const [name, file] of Object.entries(packages)) {
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }))
    assert.ok(!manifest.private, `Private artifact: ${name}`)
    assert.doesNotMatch(JSON.stringify(manifest), /workspace:/u)
    assert.equal(manifest.publishConfig?.access, 'public')
    if (process.env.GITHUB_REF_NAME?.startsWith('v'))
        assert.equal(manifest.version, process.env.GITHUB_REF_NAME.slice(1), 'Artifact must match the release tag')
    const bytes = await readFile(file)
    artifacts.push({
        name,
        version: manifest.version,
        file: basename(file),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
        exports: manifest.exports,
        dependencies: manifest.dependencies ?? {},
        peerDependencies: manifest.peerDependencies ?? {},
        peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
    })
}
assert.equal(new Set(artifacts.map(({ version }) => version)).size, 1, 'Official packages release in lockstep')
for (const artifact of artifacts)
    for (const [name, range] of Object.entries({ ...artifact.dependencies, ...artifact.peerDependencies })) {
        const sibling = artifacts.find((candidate) => candidate.name === name)
        if (sibling)
            assert.ok(
                range === sibling.version || range === `^${sibling.version}` || range === `~${sibling.version}`,
                `${artifact.name} must depend on this release of ${name}: ${range}`,
            )
    }
await writeFile(process.argv[2] ?? 'release-manifest.json', JSON.stringify({ artifacts }, null, 2) + '\n')
console.log(`Verified ${artifacts.length} release artifacts and recorded their SHA-256 digests`)
