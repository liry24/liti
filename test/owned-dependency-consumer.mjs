import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { consumerDependencies, stableVue } from './consumer-dependencies.mjs'

import { installDependencies, addDependency } from 'nypm'

/** Module setup is read-only in CI and development; installation is an explicit command. */
export async function verifyPeerDependencies(tarball, manager) {
    const directory = await mkdtemp(join(tmpdir(), 'liti-dependencies-'))
    const run = (command, args, env = process.env, failure = false) => {
        const result = spawnSync(command, args, {
            cwd: directory,
            encoding: 'utf8',
            env,
            shell: process.platform === 'win32' && ['npm', 'pnpm'].includes(command),
            maxBuffer: 16 * 1024 * 1024,
        })
        if (!failure && result.status !== 0) throw new Error(result.stdout + result.stderr)
        return result
    }
    const nuxt = ['node_modules/nuxt/bin/nuxt.mjs', 'prepare']
    const disabled =
        "auth: false, i18n: false, markdown: false, seo: false, schemaOrg: false, sitemap: false, robots: false, llms: false, ogImage: false, server: { enabled: false }, client: { origin: 'https://content.example.invalid' }"
    const config = (i18n) =>
        "export default { modules: ['liti/nuxt'], files: false, i18n: { locales: ['en'], defaultLocale: 'en' }, liti: { " +
        disabled.replace('i18n: false', 'i18n: ' + i18n) +
        ' } }'
    try {
        await writeFile(
            join(directory, 'package.json'),
            JSON.stringify({
                name: 'liti-explicit-dependencies',
                private: true,
                type: 'module',
                scripts: { postinstall: 'nuxt prepare' },
                dependencies: {
                    liti: 'file:' + resolve(tarball).replaceAll('\\', '/'),
                    ...consumerDependencies(['nuxt']),
                    vue: stableVue,
                },
            }),
        )
        await writeFile(join(directory, 'nuxt.config.ts'), config(false))
        await installDependencies({ cwd: directory, packageManager: manager, silent: true })
        run(process.execPath, nuxt, { ...process.env, CI: 'true' })
        await writeFile(join(directory, 'nuxt.config.ts'), config(true))
        const manifestBefore = await readFile(join(directory, 'package.json'), 'utf8')
        const lockName = manager === 'bun' ? 'bun.lock' : manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'
        const lockBefore = await readFile(join(directory, lockName), 'utf8')
        for (const CI of ['true', '']) {
            const result = run(process.execPath, nuxt, { ...process.env, CI }, true)
            assert.notEqual(result.status, 0)
            assert.ok((result.stdout + result.stderr).includes('Missing dependencies: @nuxtjs/i18n'))
            assert.equal(await readFile(join(directory, 'package.json'), 'utf8'), manifestBefore)
            assert.equal(await readFile(join(directory, lockName), 'utf8'), lockBefore)
        }
        await addDependency(`@nuxtjs/i18n@${consumerDependencies(['@nuxtjs/i18n'])['@nuxtjs/i18n']}`, {
            cwd: directory,
            packageManager: manager,
            silent: true,
        })
        const installed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        assert.ok(installed.dependencies['@nuxtjs/i18n'])
        for (const name of ['ai', 'comark', 'nuxt-og-image', '@nuxtjs/better-auth'])
            assert.equal(installed.dependencies[name], undefined)
        run(process.execPath, nuxt, { ...process.env, CI: 'true' })
        console.log(manager + ': read-only CI/development, explicit installation and postinstall reentry passed.')
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
}
