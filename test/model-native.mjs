import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = resolve(root, '.tmp')
mkdirSync(temporary, { recursive: true })
const consumer = process.env.LITI_MODEL_CONSUMER
    ? resolve(process.env.LITI_MODEL_CONSUMER)
    : mkdtempSync(resolve(temporary, 'model-consumer-'))
assert.ok(
    consumer.startsWith(temporary + sep) && consumer.includes('model-consumer-'),
    'Reuse only an isolated test consumer.',
)
const run = (command, args, cwd = consumer, env = process.env) => {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
}
const copy = (source, target) => {
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true })
}
const base = resolve(root, 'test/fixtures/vitehub')
for (const name of [
    'bun.lock',
    'nuxt.config.ts',
    'tsconfig.json',
    'workarounds',
    'patches',
    'app',
    'verify-node.mjs',
    'verify-cloudflare.mjs',
    'server/auth.ts',
    'server/console-authorize.ts',
    'server/database/auth-schema.ts',
    'server/databases/config.ts',
]) {
    if (name === 'bun.lock' && existsSync(resolve(consumer, name))) continue
    copy(resolve(base, name), resolve(consumer, name))
}
copy(resolve(root, 'test/fixtures/model'), consumer)
const nuxtConfig = resolve(consumer, 'nuxt.config.ts')
writeFileSync(
    nuxtConfig,
    readFileSync(nuxtConfig, 'utf8').replace(
        'export default defineNuxtConfig({',
        "export default defineNuxtConfig({\n    nitro: { externals: { inline: ['@litijs/model'] } },",
    ),
)
run('bun', ['run', 'build'], resolve(root, 'packages/model'))
run('bun', ['pm', 'pack', '--destination', consumer, '--ignore-scripts'], resolve(root, 'packages/model'))
const version = JSON.parse(readFileSync(resolve(root, 'packages/model/package.json'), 'utf8')).version
const packed = resolve(consumer, `litijs-model-${version}.tgz`)
const archive = `model-${createHash('sha256').update(readFileSync(packed)).digest('hex').slice(0, 16)}.tgz`
renameSync(packed, resolve(consumer, archive))
const manifest = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'))
manifest.name = 'liti-model-packed-consumer'
manifest.dependencies['@litijs/model'] = `file:./${archive}`
writeFileSync(resolve(consumer, 'package.json'), JSON.stringify(manifest, null, 2))
console.log(`Packed Model consumer: ${consumer}`)
run('bun', ['install'])
run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'typecheck'])
run(process.execPath, ['node_modules/vite-hub/dist/bin.js', 'db', 'generate'])
run(process.execPath, ['node_modules/vite-hub/dist/bin.js', 'db', 'migrate'])
run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'])
run(process.execPath, ['verify-node.mjs'])
run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'], consumer, {
    ...process.env,
    LITI_PROBE_PRESET: 'cloudflare',
})
run(process.execPath, ['verify-cloudflare.mjs'])
