import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'

export async function pendingReleaseFiles(
    artifacts: readonly { name: string; version: string; file: string; integrity: string }[],
) {
    const files = []
    for (const artifact of artifacts) {
        const response = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(artifact.name)}/${artifact.version}`,
        )
        if (response.status === 404) files.push(artifact.file)
        else {
            assert.ok(response.ok, `Cannot verify ${artifact.name}: HTTP ${response.status}`)
            const published = await response.json()
            assert.equal(published.dist?.integrity, artifact.integrity, `Published bytes differ: ${artifact.name}`)
        }
    }
    return files
}

if (import.meta.main) {
    const { artifacts } = JSON.parse(await readFile('release-manifest.json', 'utf8'))
    const files = await pendingReleaseFiles(artifacts)
    assert.ok(process.env.GITHUB_OUTPUT, 'Expected a GitHub Actions output destination')
    await appendFile(process.env.GITHUB_OUTPUT, `files=${JSON.stringify(files)}\n`)
    console.log(`${files.length} verified artifacts remain unpublished`)
}
