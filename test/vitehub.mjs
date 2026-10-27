import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fixtures/vitehub/', import.meta.url))
const cloudflare = process.argv.includes('--cloudflare')
const run = (command, args, cwd = fixture, env = process.env) => {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
}
const manifest = JSON.parse(readFileSync(new URL('./fixtures/vitehub/package.json', import.meta.url), 'utf8'))
assert.equal(
    manifest.dependencies['vite-hub'],
    'https://pkg.pr.new/vite-hub/vitehub/vite-hub@24ddab7ff9885d1b5ea176b8824f6e3f1a0e3ca9',
)
for (const patch of Object.values(manifest.patchedDependencies)) {
    const installedCopy = readFileSync(new URL(`./fixtures/vitehub/${patch}`, import.meta.url))
    const repositoryCopy = readFileSync(new URL(`../patches/${patch.split('/').at(-1)}`, import.meta.url))
    assert.deepEqual(installedCopy, repositoryCopy, `Patch copies differ: ${patch}`)
}
run('bun', ['install', '--frozen-lockfile'])
run(process.execPath, [
    '--test',
    fileURLToPath(new URL('./upstream-regressions/vitehub-generated-paths.test.mjs', import.meta.url)),
])
if (cloudflare) {
    // This must fail while the recorded Nitro 3 / H3 integration blocker remains.
    run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'], fixture, {
        ...process.env,
        LITI_PROBE_PRESET: 'cloudflare',
    })
} else {
    run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'typecheck'])
    run(process.execPath, ['node_modules/vite-hub/dist/bin.js', 'db', 'generate'])
    run(process.execPath, ['node_modules/vite-hub/dist/bin.js', 'db', 'migrate'])
    run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'])
    run(process.execPath, ['verify-node.mjs'])
}
