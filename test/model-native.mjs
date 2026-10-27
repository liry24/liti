import assert from 'node:assert/strict'
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
    realpathSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consumerTemporaryRoot } from './consumer-packages.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const integrated = process.argv.includes('--nuxt')
const temporary = resolve(root, '.tmp')
mkdirSync(temporary, { recursive: true })
const consumer = process.env.LITI_MODEL_CONSUMER
    ? realpathSync.native(resolve(process.env.LITI_MODEL_CONSUMER))
    : mkdtempSync(resolve(consumerTemporaryRoot, 'liti-model-consumer-'))
assert.ok(
    (consumer.startsWith(temporary + sep) && consumer.includes('model-consumer-')) ||
        consumer.startsWith(resolve(consumerTemporaryRoot, 'liti-model-consumer-')),
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
const readArchive = (file, member) => {
    const result = spawnSync('tar', ['-xOf', file, `package/${member}`], { encoding: 'utf8', windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
}
const provided = process.env.LITI_TARBALLS ? new Map() : null
if (provided) {
    for (const file of JSON.parse(process.env.LITI_TARBALLS)) {
        const path = resolve(file),
            entry = JSON.parse(readArchive(path, 'package.json'))
        assert.ok(!provided.has(entry.name), `Duplicate artifact ${entry.name}`)
        provided.set(entry.name, path)
    }
    assert.deepEqual(
        [...provided.keys()].sort((left, right) => left.localeCompare(right)),
        ['@litijs/blog', '@litijs/model', 'liti'],
    )
}
const pack = (folder, name) => {
    let packed = provided?.get(name)
    if (!packed) {
        assert.ok(!provided, `Missing artifact ${name}`)
        const directory = resolve(root, `packages/${folder}`)
        run('bun', ['run', 'typecheck'], directory)
        run('bun', ['run', 'build'], directory)
        run('bun', ['pm', 'pack', '--destination', consumer, '--ignore-scripts'], directory)
        const { version } = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
        packed = resolve(consumer, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)
    }
    const archive = `${folder}-${createHash('sha256').update(readFileSync(packed)).digest('hex').slice(0, 16)}.tgz`
    if (provided) copy(packed, resolve(consumer, archive))
    else renameSync(packed, resolve(consumer, archive))
    return archive
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
const archive = pack('model', '@litijs/model')
const manifest = JSON.parse(readFileSync(resolve(base, 'package.json'), 'utf8'))
manifest.name = 'liti-model-packed-consumer'
manifest.dependencies['@litijs/model'] = `file:./${archive}`
if (integrated) {
    const litiArchive = pack('liti', 'liti')
    assert.ok(
        readArchive(resolve(consumer, litiArchive), 'dist/runtime/server/manage.post.js').includes(
            'from "#liti/runtime"',
        ),
        'Keep the generated server module virtual in the package.',
    )
    manifest.dependencies.liti = `file:./${litiArchive}`
    manifest.overrides = { ...manifest.overrides, '@litijs/model': `file:./${archive}` }
    const blogArchive = pack('blog', '@litijs/blog')
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
if (integrated) run(process.execPath, ['verify-dev.mjs'])
run(process.execPath, ['node_modules/nuxt/bin/nuxt.mjs', 'build'], consumer, {
    ...process.env,
    LITI_PROBE_PRESET: 'cloudflare',
})
run(process.execPath, ['verify-cloudflare.mjs'])
