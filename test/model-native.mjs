import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const integrated = process.argv.includes('--nuxt')
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
run('bun', ['run', 'typecheck'], resolve(root, 'packages/model'))
run('bun', ['run', 'build'], resolve(root, 'packages/model'))
run('bun', ['pm', 'pack', '--destination', consumer, '--ignore-scripts'], resolve(root, 'packages/model'))
const version = JSON.parse(readFileSync(resolve(root, 'packages/model/package.json'), 'utf8')).version
const packed = resolve(consumer, `litijs-model-${version}.tgz`)
const archive = `model-${createHash('sha256').update(readFileSync(packed)).digest('hex').slice(0, 16)}.tgz`
renameSync(packed, resolve(consumer, archive))
const manifest = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'))
manifest.name = 'liti-model-packed-consumer'
manifest.dependencies['@litijs/model'] = `file:./${archive}`
if (integrated) {
    run('bun', ['run', 'typecheck'], resolve(root, 'packages/liti'))
    run('bun', ['run', 'build'], resolve(root, 'packages/liti'))
    assert.ok(
        readFileSync(resolve(root, 'packages/liti/dist/runtime/server/manage.post.js'), 'utf8').includes(
            'from "#liti/runtime"',
        ),
        'Keep the generated server module virtual in the package.',
    )
    run('bun', ['pm', 'pack', '--destination', consumer, '--ignore-scripts'], resolve(root, 'packages/liti'))
    const litiVersion = JSON.parse(readFileSync(resolve(root, 'packages/liti/package.json'), 'utf8')).version
    const litiPacked = resolve(consumer, `liti-${litiVersion}.tgz`)
    const litiArchive = `liti-${createHash('sha256').update(readFileSync(litiPacked)).digest('hex').slice(0, 16)}.tgz`
    renameSync(litiPacked, resolve(consumer, litiArchive))
    manifest.dependencies.liti = `file:./${litiArchive}`
    manifest.overrides = { ...manifest.overrides, '@litijs/model': `file:./${archive}` }
    run('bun', ['run', 'typecheck'], resolve(root, 'packages/blog'))
    run('bun', ['run', 'build'], resolve(root, 'packages/blog'))
    run('bun', ['pm', 'pack', '--destination', consumer, '--ignore-scripts'], resolve(root, 'packages/blog'))
    const blogVersion = JSON.parse(readFileSync(resolve(root, 'packages/blog/package.json'), 'utf8')).version
    const blogPacked = resolve(consumer, `litijs-blog-${blogVersion}.tgz`)
    const blogArchive = `blog-${createHash('sha256').update(readFileSync(blogPacked)).digest('hex').slice(0, 16)}.tgz`
    renameSync(blogPacked, resolve(consumer, blogArchive))
    manifest.dependencies['@litijs/blog'] = `file:./${blogArchive}`
    copy(resolve(consumer, 'verify-http.mjs'), resolve(consumer, 'verify-model-http.mjs'))
    copy(resolve(root, 'test/fixtures/integration'), consumer)
    copy(resolve(root, 'test/chromium.mjs'), resolve(consumer, 'verify-browser.mjs'))
    copy(resolve(root, 'test/stop-process.ts'), resolve(consumer, 'stop-process.ts'))
    process.env.CHROMIUM_PATH ??=
        process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome'
    rmSync(resolve(consumer, 'server/plugins/model.ts'), { force: true })
}
writeFileSync(resolve(consumer, 'package.json'), JSON.stringify(manifest, null, 2))
console.log(`Packed Model consumer: ${consumer}`)
run('bun', ['install'])
run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'typecheck'])
run(
    process.execPath,
    integrated
        ? ['node_modules/liti/dist/cli/index.js', 'generate']
        : ['node_modules/vite-hub/dist/bin.js', 'db', 'generate'],
)
run(process.execPath, ['node_modules/vite-hub/dist/bin.js', 'db', 'migrate'])
run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'])
run(process.execPath, ['verify-node.mjs'])
run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'], consumer, {
    ...process.env,
    LITI_PROBE_PRESET: 'cloudflare',
})
run(process.execPath, ['verify-cloudflare.mjs'])
