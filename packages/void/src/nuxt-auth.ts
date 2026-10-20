import { resolve } from 'node:path'
import { addTemplate } from 'nuxt/kit'
import type { Nuxt } from 'nuxt/schema'
import type { NitroConfig } from 'nitropack/types'
import type { LitiConfig } from 'liti/adapter'
// oxlint-disable-next-line import/no-empty-named-blocks -- load the host's module augmentation without a runtime import
import type {} from '@nuxtjs/better-auth'
import { allowGeneratedFilesConfig } from './nuxt-files'
import type { ActionDefinition } from 'liti'

const accessControl = (config: LitiConfig) => {
    const actions = (config as LitiConfig & { actions?: Record<string, ActionDefinition> }).actions ?? {}
    const modelActions = ['create', 'delete', 'publish', 'prune', 'readDraft', 'restore', 'schedule', 'sort', 'update']
    const assetActions = ['delete', 'gc', 'read', 'upload']
    const systemActions = ['diagnostics', 'publishDue', 'rebuildSearch']
    const resources = {
        ...Object.fromEntries(Object.keys(config.models).map((name) => [`liti:model:${name}`, modelActions])),
        'liti:assets': assetActions,
        'liti:actions': Object.keys(actions),
        'liti:system': systemActions,
        session: ['list', 'revoke', 'delete'],
        user: [
            'create',
            'list',
            'set-role',
            'ban',
            'impersonate',
            'delete',
            'set-password',
            'set-email',
            'get',
            'update',
        ],
    }
    const custom = Object.fromEntries(
        Object.entries(config.authorization?.roles ?? {}).map(([name, role]) => {
            const statements: Record<string, readonly string[]> = {
                'liti:assets': role.assets ?? [],
                'liti:system': role.system ?? [],
                'liti:actions': role.actions?.includes('*') ? Object.keys(actions) : (role.actions ?? []),
                session: [],
                user: [],
            }
            for (const model of Object.keys(config.models)) {
                statements[`liti:model:${model}`] = [...(role.models?.['*'] ?? []), ...(role.models?.[model] ?? [])]
            }
            return [name, statements]
        }),
    )
    const permissions = {
        admin: resources,
        user: Object.fromEntries(Object.keys(resources).map((name) => [name, []])),
        ...custom,
    }
    return {
        source: `const resources = ${JSON.stringify(resources)}\nconst permissions = ${JSON.stringify(permissions)}`,
        roleNames: Object.keys(permissions),
    }
}

const serverAccessPlugin = (
    access: ReturnType<typeof accessControl>,
): string => `import type { BetterAuthOptions } from 'better-auth'
import { extendLitiAuth } from '@litijs/void/auth'
${access.source}
export default <const T extends BetterAuthOptions>(options: T) => extendLitiAuth(options, resources, permissions)
`

const clientAccessPlugin = (
    access: ReturnType<typeof accessControl>,
): string => `import { adminClient } from 'better-auth/client/plugins'
import { createAccessControl } from 'better-auth/plugins'
${access.source}
const ac = createAccessControl(resources)
const roles = {
  ${access.roleNames.map((name) => `${JSON.stringify(name)}: ac.newRole(permissions[${JSON.stringify(name)}]),`).join('\n  ')}
}
export default adminClient({ ac, roles })
`

const betterAuthDatabaseProvider = (
    options: { usePlural?: boolean; camelCase?: boolean } = {},
): string => `import { createAuthDatabase } from '@litijs/void/session'
import * as schema from '@schema'
export { db } from 'void/db'
export const createDatabase = (event) => createAuthDatabase(schema, ${JSON.stringify(options)}, event?.context)
`

export function setupNuxtAuth(nuxt: Nuxt, domainConfig: LitiConfig) {
    nuxt.hook('liti:config', (config) => {
        domainConfig = config
    })
    const serverAuthPlugin = addTemplate({
        filename: 'liti/better-auth-server-plugin.ts',
        getContents: () => serverAccessPlugin(accessControl(domainConfig)),
        write: true,
    })
    const clientAuthPlugin = addTemplate({
        filename: 'liti/better-auth-client-plugin.mjs',
        getContents: () => clientAccessPlugin(accessControl(domainConfig)),
        write: true,
    })
    nuxt.hook('better-auth:plugins:extend', (sources) => {
        sources.client = [...(sources.client ?? []), clientAuthPlugin.dst]
    })
    {
        nuxt.hook('better-auth:database:providers', (providers) => {
            providers.liti = {
                priority: 1_000,
                isEnabled: () => true,
                buildDatabaseCode: betterAuthDatabaseProvider,
            }
        })
    }

    nuxt.hook('nitro:config', (nativeConfig) => {
        const config = nativeConfig as NitroConfig
        // Auth secrets belong to runtime bindings, not a developer's build environment.
        if (!nuxt.options.dev && config.runtimeConfig) config.runtimeConfig.betterAuthSecret = ''
        config.esbuild ??= {}
        config.esbuild.options ??= {}
        config.esbuild.options.exclude = allowGeneratedFilesConfig(
            config.esbuild.options.exclude,
            resolve(nuxt.options.buildDir, 'liti'),
        )
    })
    // Native setup resolves the app factory and any other additive plugins first.
    // Wrapping its final factory preserves request context and the app-selected adapter.
    const stopAuthSetupObserver = nuxt.hooks.afterEach(({ name }) => {
        if (name !== 'modules:done') return
        stopAuthSetupObserver()
        const source = nuxt.options.alias['#auth/server']
        if (!source) throw new Error('[liti] Native Better Auth server configuration is unavailable.')
        const serverConfig = addTemplate({
            filename: 'liti/better-auth-server-config.ts',
            getContents: () => `import createAuth from ${JSON.stringify(source)}
import extendAuth from ${JSON.stringify(serverAuthPlugin.dst)}
export default (context: Parameters<typeof createAuth>[0]) => extendAuth(createAuth(context))
`,
            write: true,
        })
        nuxt.options.alias['#auth/server'] = serverConfig.dst
        const rewritten = new WeakSet<object>()
        const rewriteTemplates = (templates: typeof nuxt.options.build.templates) => {
            for (const template of templates) {
                if (
                    !(
                        template.filename?.startsWith('types/nuxt-better-auth-') ||
                        template.filename === 'types/auth-database.d.ts'
                    ) ||
                    !template.getContents ||
                    rewritten.has(template)
                )
                    continue
                rewritten.add(template)
                const getContents = template.getContents
                template.getContents = async (context) =>
                    (await getContents(context)).replace(
                        `import type createServerAuth from '${source}'`,
                        `import type createServerAuth from ${JSON.stringify(serverConfig.dst)}`,
                    )
            }
        }
        // `nuxt prepare` writes types before the app template hook runs.
        rewriteTemplates(nuxt.options.build.templates)
        nuxt.hook('app:templates', (app) => rewriteTemplates(app.templates))
    })
}
