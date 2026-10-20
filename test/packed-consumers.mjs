// Nuxt's #app types must resolve in the consumer to retain its hook/plugin augmentations.
// This suite checks that context-bound internal entrypoint in real Nuxt apps; attw checks standalone entries.
import { spawn, spawnSync } from 'node:child_process'
import { stopProcess as stop } from './stop-process.ts'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

import { verifyPeerDependencies } from './owned-dependency-consumer.mjs'
import { verifyPublicDataConsumer } from './public-data-consumer.mjs'
import { assertAiOmitted } from './assert-ai-omitted.mjs'
import { consumerDependencies, stableVue } from './consumer-dependencies.mjs'
import { archiveDependencies, archiveOverrides, consumerPackages } from './consumer-packages.mjs'

import { addDependency, installDependencies } from 'nypm'
const packageManager = process.env.LITI_PACKAGE_MANAGER || 'bun'
if (!['bun', 'npm', 'pnpm'].includes(packageManager)) throw new Error('Unknown LITI_PACKAGE_MANAGER.')
const integrations = !process.env.LITI_PACKAGE_MANAGER || packageManager === 'pnpm'
const ogImage = JSON.parse(
    await readFile(new URL('../node_modules/nuxt-og-image/package.json', import.meta.url), 'utf8'),
)
const renderers = Object.fromEntries(
    ['@takumi-rs/core', '@takumi-rs/wasm', 'satori', '@resvg/resvg-js'].map((name) => {
        if (!ogImage.peerDependencies[name]) throw new Error(`OG renderer peer missing: ${name}`)
        return [name, ogImage.peerDependencies[name]]
    }),
)
const temporary = await mkdtemp(join(tmpdir(), 'liti-consumers-'))
const run = (command, args, cwd = temporary, env = process.env) => {
    console.log(`Consumer: ${command} ${args[0] ?? ''} (${cwd})`)
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env,
        shell: process.platform === 'win32' && ['npm', 'pnpm'].includes(command),
        maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.\n${result.stdout}\n${result.stderr}`)
    return result.stdout.trim()
}
const install = async (cwd = temporary, production = false) => {
    // npm cannot reify Nitro's traced links; its production manifest contains no development dependencies.
    if (packageManager === 'npm' && production) await rm(join(cwd, 'node_modules'), { force: true, recursive: true })
    await installDependencies({ cwd, packageManager, silent: true, corepack: false })
}
const exec = ([name, ...args], cwd = temporary) => {
    const local = createRequire(join(temporary, 'package.json'))
    const packageName = name === 'tsc' ? 'typescript' : name
    const path = local.resolve(`${packageName}/package.json`)
    const manifest = local(path)
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name]
    return run(process.execPath, [join(dirname(path), bin), ...args], cwd)
}
const reservePort = () =>
    new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') return reject(new Error('Unable to reserve a test port.'))
            server.close((error) => (error ? reject(error) : resolve(address.port)))
        })
    })
const startNuxt = async (directory, worker = false) => {
    const port = await reservePort()
    const output = []
    const args = worker
        ? [
              join(temporary, 'node_modules/wrangler/bin/wrangler.js'),
              'dev',
              '--local',
              '--config',
              '.data/wrangler.json',
              '--persist-to',
              '.data/state',
              '--port',
              String(port),
          ]
        : [join(directory, '.output/server/index.mjs')]
    const child = spawn(process.execPath, args, {
        cwd: directory,
        env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            NUXT_BETTER_AUTH_SECRET: 'packed-consumer-test-secret-000000000000000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => output.push(String(chunk)))
    child.stderr.on('data', (chunk) => output.push(String(chunk)))
    for (let attempt = 0; attempt < 400; attempt += 1) {
        if (child.exitCode !== null) break
        try {
            await fetch(`http://127.0.0.1:${port}/`)
            return { child, origin: `http://127.0.0.1:${port}`, output }
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }
    await stop(child)
    throw new Error(`Packed Nuxt consumer did not start.\n${output.join('')}`)
}
const filesUnder = async (directory) => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

try {
    const packages = await consumerPackages(temporary, run)
    const tarball = packages.liti
    console.log(`Testing ${tarball} with ${packageManager}`)
    if (packageManager === 'npm') {
        await verifyPublicDataConsumer(tarball)
    }
    await verifyPeerDependencies(tarball, packageManager)
    await Promise.all(['server', 'remote'].map((name) => mkdir(join(temporary, name), { recursive: true })))
    await writeFile(
        join(temporary, 'package.json'),
        JSON.stringify({
            ...archiveOverrides(packages, packageManager),
            dependencies: {
                ...archiveDependencies(packages, ['liti', '@litijs/sqlite', '@litijs/void']),
                ...consumerDependencies([
                    'better-auth',
                    'comark',
                    'nuxt-files-sdk',
                    'files-sdk',
                    'nuxt-site-config',
                    '@nuxtjs/i18n',
                    '@nuxtjs/robots',
                    '@nuxtjs/sitemap',
                    'nuxt-llms',
                    'nuxt-og-image',
                    'nuxt-schema-org',
                    'nuxt-seo-utils',
                    '@better-auth/drizzle-adapter',
                    '@nuxtjs/better-auth',
                    'void',
                    'wrangler',
                    'nuxt',
                    'nitropack',
                    'typescript',
                    '@types/node',
                ]),
                // Vite 8's optional peer must not resolve to Drizzle Kit's older esbuild.
                esbuild: '^0.28.0',
                vue: stableVue,
                ...(!integrations ? renderers : {}),
            },
            private: true,
            type: 'module',
        }),
    )
    await writeFile(
        join(temporary, 'core.ts'),
        `import { defineLitiConfig, image, text, type InferLitiPublicModels } from 'liti'
import { createLitiClient } from 'liti/client'
import { createLiti } from 'liti/server'
const config = defineLitiConfig({ models: { posts: { fields: { cover: image(), title: text({ required: true }) } } } })
const data = { title: 'Public', cover: { id: 'asset', url: '/api/content/_assets/asset' } } satisfies InferLitiPublicModels<typeof config>['posts']['data']
if (!data.cover || !config.models.posts || typeof createLiti !== 'function' || typeof createLitiClient !== 'function') throw new Error('core exports missing')
`,
    )
    await writeFile(
        join(temporary, 'form.ts'),
        `import { useForm } from 'liti/vue'
if (typeof useForm !== 'function') throw new Error('form export missing')
`,
    )
    await writeFile(
        join(temporary, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                module: 'Preserve',
                moduleResolution: 'Bundler',
                noEmit: true,
                skipLibCheck: false,
                strict: true,
                target: 'ES2024',
            },
            include: ['core.ts', 'form.ts'],
        }),
    )
    const disabled = `auth: false, i18n: false, llms: false, ogImage: false, robots: false, schemaOrg: false, seo: false, sitemap: false`
    await writeFile(
        join(temporary, 'server/nuxt.config.ts'),
        `import { defineNuxtConfig } from 'nuxt/config'
export default defineNuxtConfig({
  modules: ['liti/nuxt'],
  ...{ files: false },
  liti: { auth: true, i18n: true, llms: true, ogImage: true, robots: true, schemaOrg: true, seo: true, sitemap: true },
  i18n: { locales: ['en'], defaultLocale: 'en' },
  llms: { domain: 'http://localhost', title: 'Packed' },
})
`,
    )
    await writeFile(
        join(temporary, 'server/liti.config.ts'),
        `import { defineLitiConfig, text } from 'liti'
import { voidAdapter } from '@litijs/void'
export default defineLitiConfig({ adapter: voidAdapter(), authorization: { roles: { user: {} } }, models: { posts: { fields: { title: text() } } } })
`,
    )
    await mkdir(join(temporary, 'server/app/components/OgImage'), { recursive: true })
    await writeFile(
        join(temporary, 'server/app/app.vue'),
        `<script setup>defineOgImage('Default.takumi')</script><template><div>packed server</div></template>`,
    )
    await writeFile(
        join(temporary, 'server/app/components/OgImage/Default.takumi.vue'),
        '<template><div style="display:flex;background:white;color:black;font-size:48px">Packed</div></template>',
    )
    const remoteOriginPort = await reservePort()
    const remoteOrigin = `http://127.0.0.1:${remoteOriginPort}`
    await writeFile(
        join(temporary, 'remote/nuxt.config.ts'),
        `import { defineNuxtConfig } from 'nuxt/config'
export default defineNuxtConfig({ modules: ['liti/nuxt'], ...{ files: false }, liti: { ${disabled}, client: { origin: ${JSON.stringify(remoteOrigin)} }, server: { enabled: false } } })
`,
    )
    await writeFile(
        join(temporary, 'remote/app.vue'),
        `<script setup>const route = useRoute(); const { data: entry } = await useLitiQuery('posts', { mode: 'one', path: () => route.path })</script><template><div>{{ entry?.data?.title || 'remote empty' }}</div></template>`,
    )

    for (const name of ['server', 'remote'])
        await writeFile(
            join(temporary, name, 'package.json'),
            JSON.stringify({ name: 'packed-' + name, type: 'module', dependencies: { nuxt: '*' } }),
        )
    await writeFile(
        join(temporary, 'server/void.config.ts'),
        "export default { inference: { bindings: { db: true } }, cloudflare: { name: 'packed-liti', compatibility_flags: ['nodejs_compat'] } }",
    )
    await install()
    exec(['tsc', '--noEmit'])
    run(process.execPath, ['core.ts'])
    run(process.execPath, [
        '--input-type=module',
        '-e',
        `import { readFileSync } from 'node:fs'; const meta = JSON.parse(readFileSync(new URL(import.meta.resolve('liti/module.json')))); const pkg = JSON.parse(readFileSync(new URL(import.meta.resolve('liti/package.json')))); if (meta.name !== pkg.name || meta.configKey !== 'liti' || meta.version !== pkg.version) throw new Error('Invalid module metadata')`,
    ])
    run(process.execPath, [
        '--input-type=module',
        '-e',
        `
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (specifier.includes('drizzle')) throw new Error('Core imported Drizzle: ' + specifier)
  if (specifier === 'ai' || specifier.startsWith('ai/') || specifier.startsWith('@ai-sdk/') || specifier.startsWith('workers-ai-provider')) throw new Error('Core eagerly imported AI: ' + specifier)
  return next(specifier, context)
} })
await import('liti')
await import('liti/client')
await import('liti/server')
await import('liti/adapter')
for (const module of ['assets', 'content', 'document', 'plugins']) {
  try {
    import.meta.resolve('liti/markdown/' + module)
    throw new Error('Internal Markdown module became a public export: ' + module)
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
}
`,
    ])
    run(process.execPath, ['form.ts'])
    run(process.execPath, [
        '--input-type=module',
        '-e',
        `
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'comark' || specifier.startsWith('comark/') || specifier.startsWith('markdown-exit') || specifier.startsWith('mdurl') || specifier.startsWith('linkify-it')) throw new Error('Form imported Markdown parser: ' + specifier)
  return next(specifier, context)
} })
await import('liti/vue')
`,
    ])
    exec(['liti', 'generate', '--cwd', 'server', '--schema-only'])
    await mkdir(join(temporary, 'server/server'), { recursive: true })
    await writeFile(
        join(temporary, 'server/server/auth.config.ts'),
        `import { defineServerAuth } from '@nuxtjs/better-auth/config'
export default defineServerAuth({
  emailAndPassword: { enabled: true },
})
`,
    )
    exec(['liti', 'generate', '--cwd', 'server'])
    const migrationFiles = (await readdir(join(temporary, 'server/db/migrations'))).filter((name) =>
        name.endsWith('.sql'),
    )
    if (migrationFiles.length !== 1) throw new Error('Void must generate one baseline migration from the packed schema')
    await mkdir(join(temporary, 'server/.data'), { recursive: true })
    await writeFile(
        join(temporary, 'server/.data/wrangler.json'),
        JSON.stringify({
            name: 'packed-liti',
            main: '../.output/server/index.mjs',
            compatibility_date: '2026-10-15',
            compatibility_flags: ['nodejs_compat'],
            d1_databases: [
                {
                    binding: 'DB',
                    database_name: 'packed',
                    database_id: '00000000-0000-4000-8000-000000000005',
                    migrations_dir: '../db/migrations',
                },
            ],
            vars: {
                NUXT_BETTER_AUTH_SECRET: 'packed-consumer-test-secret-000000000000000',
                NUXT_APP_SECRET: 'packed-consumer-test-app-secret-000000000000000',
            },
        }),
    )
    run(
        process.execPath,
        [
            join(temporary, 'node_modules/wrangler/bin/wrangler.js'),
            'd1',
            'migrations',
            'apply',
            'DB',
            '--local',
            '--config',
            '.data/wrangler.json',
            '--persist-to',
            '.data/state',
        ],
        join(temporary, 'server'),
    )
    await writeFile(
        join(temporary, 'server/app/auth.config.ts'),
        `import { defineClientAuth } from '@nuxtjs/better-auth/config'; export default defineClientAuth({})`,
    )
    await writeFile(
        join(temporary, 'server/server/types.ts'),
        `import { useServerHooks } from 'nuxt/server'
export default () => {
  useServerHooks().hook('liti:authorize', (context) => {
    const request: Request = context.event.req
    context.event.res.headers.set('x-native-probe', '1')
    // @ts-expect-error Native events do not expose Node.
    context.event.node
    // @ts-expect-error Use event.req; the legacy request alias is removed.
    context.request
    void request
  })
  // @ts-expect-error Unknown liti hook.
  useServerHooks().hook('liti:missing', () => {})
}
const admin: ReturnType<typeof import('liti/nuxt/server').useAdmin> = useAdmin()
void admin
`,
    )
    await mkdir(join(temporary, 'server/server/api'), { recursive: true })
    await writeFile(
        join(temporary, 'server/server/api/__runtime.get.ts'),
        `import { defineEventHandler } from 'nuxt/server'
import { useLitiRuntime } from 'liti/internal/nuxt/server'
export default defineEventHandler(async (event) => {
  try { const runtime = useLitiRuntime(); await runtime.getLiti(event); return { ready: true } }
  catch (error) { return { message: String(error), stack: error instanceof Error ? error.stack : undefined } }
})`,
    )
    await writeFile(
        join(temporary, 'server/app/types.ts'),
        `const nativeSession = useUserSession()
const role: NonNullable<typeof nativeSession.user.value>['role'] = 'admin'
const impersonatedBy: NonNullable<typeof nativeSession.session.value>['impersonatedBy'] = 'test-admin'
// @ts-expect-error Native role inference must not degrade to any.
const invalidRole: NonNullable<typeof nativeSession.user.value>['role'] = 1
// @ts-expect-error Native session inference must retain its field type.
const invalidImpersonatedBy: NonNullable<typeof nativeSession.session.value>['impersonatedBy'] = 1
const { data: models } = useLitiModels()
const route = useRoute()
// @ts-expect-error No such public client method.
models.value.missing()
void route
void role
void impersonatedBy
void invalidRole
void invalidImpersonatedBy
`,
    )
    if (integrations) {
        const setupNuxt = (dev) =>
            run(
                process.execPath,
                [
                    '--input-type=module',
                    '-e',
                    `import { loadNuxt } from 'nuxt/kit'; const nuxt = await loadNuxt({ cwd: '.', dev: ${dev}, ready: true }); try { if (!nuxt.options.alias['#auth/server']?.endsWith('liti/better-auth-server-config.ts')) throw new Error('Native module ordering lost the liti auth wrapper'); } finally { await nuxt.close() }`,
                ],
                join(temporary, 'server'),
                {
                    ...process.env,
                    CI: 'true',
                    AI_AGENT: '1',
                    NUXT_BETTER_AUTH_SECRET: 'packed-consumer-test-secret-000000000000000',
                },
            )
        const manifestBefore = await readFile(join(temporary, 'package.json'), 'utf8')
        try {
            run(
                process.execPath,
                [join(temporary, 'node_modules/nuxt/bin/nuxt.mjs'), 'build'],
                join(temporary, 'server'),
                { ...process.env, CI: 'true' },
            )
            throw new Error('Missing renderer dependency was accepted.')
        } catch (error) {
            if (
                !/Missing dependencies:|renderer missing dependencies|takumi renderer is not installed/u.test(
                    String(error),
                )
            )
                throw error
        }
        if ((await readFile(join(temporary, 'package.json'), 'utf8')) !== manifestBefore)
            throw new Error('Build mutated dependencies.')
        // Noninteractive builds require application-owned renderer dependencies.
        await addDependency(
            Object.entries(renderers).map(([name, version]) => `${name}@${version}`),
            {
                cwd: temporary,
                packageManager,
                corepack: false,
                silent: true,
            },
        )
        setupNuxt(true)
        setupNuxt(false)
        const nativeConfigPath = join(temporary, 'server/nuxt.config.ts')
        const nativeConfig = await readFile(nativeConfigPath, 'utf8')
        for (const modules of ["['liti/nuxt', '@nuxtjs/better-auth']", "['@nuxtjs/better-auth', 'liti/nuxt']"]) {
            await writeFile(nativeConfigPath, nativeConfig.replace("['liti/nuxt']", modules))
            setupNuxt(false)
        }
        await writeFile(nativeConfigPath, nativeConfig)
        if (!consumer.dependencies['nuxt-og-image'])
            throw new Error('Consumer must install its enabled OG module peer.')
        const takumiPath = join(temporary, 'server/app/components/OgImage/Default.takumi.vue')
        const satoriPath = join(temporary, 'server/app/components/OgImage/Default.satori.vue')
        const template = await readFile(takumiPath, 'utf8')
        await rm(takumiPath)
        await writeFile(satoriPath, template)
        setupNuxt(true)
        setupNuxt(false)
        await writeFile(takumiPath, template)
        setupNuxt(false)
        await rm(satoriPath)
    }
    exec(['nuxt', 'build'], join(temporary, 'server'))
    // CLI 4 relocates build artifacts; prepare restores the public generated type surface.
    exec(['nuxt', 'prepare'], join(temporary, 'server'))
    await assertAiOmitted(join(temporary, 'server'))
    for (const context of ['node', 'app', 'server'])
        exec(['tsc', '--noEmit', '-p', `server/.nuxt/tsconfig.${context}.json`])
    const serverFiles = await filesUnder(join(temporary, 'server/.output'))
    const serverBundle = (
        await Promise.all(serverFiles.map((file) => readFile(file).catch(() => Buffer.alloc(0))))
    ).join('\n')
    if (!serverBundle.includes('management-handler')) throw new Error('Default auth integration was not bundled.')
    for (const forbidden of ['devframe', '@nuxt/devtools-kit', '__liti-devtools']) {
        if (serverBundle.includes(forbidden))
            throw new Error(`Development-only code leaked into production server: ${forbidden}`)
    }
    // Drizzle ORM's comments mention Kit. Check the actual package/import, not documentation text.
    for (const file of serverFiles) {
        if (!(await stat(file)).isFile()) continue
        const source = String(await readFile(file))
        if (
            file.replaceAll('\\', '/').includes('/node_modules/drizzle-kit/') ||
            /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]drizzle-kit(?:\/|['"])/u.test(source)
        )
            throw new Error(`Generation-only Drizzle Kit leaked into production server: ${file}`)
    }
    const local = await startNuxt(join(temporary, 'server'), true)
    try {
        const response = await fetch(`${local.origin}/api/content/posts`)
        const body = await response.text()
        if (!response.ok || body !== '[]') {
            throw new Error(
                `Packed server runtime probe failed (${response.status}): ${body}\n${await fetch(`${local.origin}/api/__runtime`).then((result) => result.text())}\n${local.output.join('')}`,
            )
        }
    } finally {
        await stop(local.child)
    }

    if (integrations) {
        exec(['nuxt', 'build', 'remote'])
        const remoteFiles = await filesUnder(join(temporary, 'remote/.output'))
        const remoteContents = await Promise.all(
            remoteFiles.map(async (file) => [file, String(await readFile(file).catch(() => Buffer.alloc(0)))]),
        )
        for (const forbidden of [
            '@nuxtjs/better-auth',
            '@nuxtjs/i18n',
            '@nuxtjs/robots',
            '@nuxtjs/sitemap',
            'devframe',
            '@nuxt/devtools-kit',
            'drizzle-kit',
            'nuxt-og-image',
            'nuxt-schema-org',
            'liti.ai',
        ]) {
            const leaked = remoteContents.filter(([, content]) => content.includes(forbidden)).map(([file]) => file)
            if (leaked.length > 0) {
                throw new Error(`Disabled integration leaked into remote bundle: ${forbidden} in ${leaked.join(', ')}`)
            }
        }
        await install(join(temporary, 'remote/.output/server'), true)
        const publicServer = createServer((request, response) => {
            response.setHeader('content-type', 'application/json')
            if (request.url?.startsWith('/api/content/_route')) {
                response.end(
                    JSON.stringify({
                        entry: { data: { title: 'Remote title' }, locale: '', model: 'posts', path: '/remote' },
                        kind: 'page',
                    }),
                )
            } else response.end('{}')
        })
        await new Promise((resolve, reject) => {
            publicServer.once('error', reject)
            publicServer.listen(remoteOriginPort, '127.0.0.1', resolve)
        })
        const remote = await startNuxt(join(temporary, 'remote'))
        try {
            const response = await fetch(`${remote.origin}/remote`)
            const html = await response.text()
            if (!response.ok || !html.includes('Remote title')) {
                throw new Error(
                    `Packed remote consumer runtime probe failed: ${response.status}\n${html.slice(0, 2000)}\n${remote.output.join('')}`,
                )
            }
        } finally {
            await stop(remote.child)
            await new Promise((resolve, reject) => publicServer.close((error) => (error ? reject(error) : resolve())))
        }
    }
} finally {
    if (!process.env.LITI_KEEP_CONSUMER)
        await rm(temporary, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
}
