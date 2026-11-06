import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const manager = process.env.LITI_PACKAGE_MANAGER ?? 'bun'
assert.ok(['bun', 'npm', 'pnpm'].includes(manager))
if (manager !== 'bun') {
    console.log(
        `${manager}: bare Model/Blog/Vue contracts are verified by isolated-consumers. Content writes require the documented identical Bun root patches; unpatched npm/pnpm CMS runtime is unsupported.`,
    )
} else {
    const cli = spawnSync(process.execPath, ['test/cli-consumer.mjs'], {
        stdio: 'inherit',
        env: process.env,
        windowsHide: true,
    })
    if (cli.error) throw cli.error
    if (cli.status !== 0) process.exit(cli.status ?? 1)
    const standalone = spawnSync(process.execPath, ['test/model-vite.mjs'], {
        stdio: 'inherit',
        env: process.env,
        windowsHide: true,
    })
    if (standalone.error) throw standalone.error
    if (standalone.status !== 0) process.exit(standalone.status ?? 1)
    const result = spawnSync(process.execPath, ['test/model-native.mjs', '--nuxt'], {
        stdio: 'inherit',
        env: process.env,
        windowsHide: true,
    })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
}
