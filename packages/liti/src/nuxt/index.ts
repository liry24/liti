import type { NitroConfig } from 'nitropack'
import { readdir, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import {
    addImports,
    addTemplate,
    addTypeTemplate,
    createResolver,
    defineNuxtModule,
    hasNuxtModule,
    updateTemplates,
    extendPages,
    addServerImports,
} from 'nuxt/kit'
import { modelDatabaseContribution } from '@litijs/model/vite'
import { registerViteHubWorkarounds } from '../internal/vitehub-workarounds'

export interface ModuleOptions {
    workspace: string
    database: string
    baseURL: string
    admin: boolean
}
const slash = (path: string) => path.replaceAll('\\', '/')
async function modelFiles(root: string): Promise<string[]> {
    if (!existsSync(root)) return []
    const entries = await readdir(root, { withFileTypes: true })
    return (
        await Promise.all(
            entries.map(async (entry) =>
                entry.isDirectory()
                    ? modelFiles(resolve(root, entry.name))
                    : /\.(?:ts|js|mts|mjs)$/u.test(entry.name) && !entry.name.endsWith('.d.ts')
                      ? [slash(resolve(root, entry.name))]
                      : [],
            ),
        )
    )
        .flat()
        .sort()
}

export default defineNuxtModule<ModuleOptions>({
    meta: { name: 'liti', configKey: 'liti', compatibility: { nuxt: '^4.6.2' } },
    defaults: { workspace: 'content', database: 'default', baseURL: '/api/_liti', admin: true },
    async setup(options, nuxt) {
        if (nuxt.options.server?.builder && nuxt.options.server.builder !== '@nuxt/nitro-server')
            throw new Error('[liti] The pinned integration requires Nuxt 4.6 with its Nitro 2 server builder.')
        await registerViteHubWorkarounds(nuxt)
        if (!/^\/[a-zA-Z0-9/_-]+$/u.test(options.baseURL) || options.baseURL.endsWith('/'))
            throw new Error('[liti] baseURL must be an absolute path without a trailing slash.')
        const resolver = createResolver(import.meta.url)
        const directory = resolve(nuxt.options.serverDir, 'models')
        const contentFile = slash(resolve(nuxt.options.serverDir, 'content.ts'))
        let files = await modelFiles(directory)
        const imports = () =>
            files.map((file, index) => `import * as model${index} from ${JSON.stringify(file)}`).join('\n')
        const values = () => `[${files.map((_, index) => `model${index}`).join(',')}].flatMap(Object.values)`
        const definitionsSource = () =>
            `${imports()}\nexport const models = [...new Set(${values()}.filter(value => value && typeof value === 'object' && (value.storage === 'content' || value.storage === 'records')))]\n`
        const definitions = addTemplate({
            filename: 'liti/definitions.mjs',
            write: true,
            getContents: definitionsSource,
        })
        const schemaSource = () =>
            `import { models } from ${JSON.stringify(slash(definitions.dst))}\nimport { recordSchema } from '@litijs/model/records/schema'\nexport const tables = recordSchema(models.filter(model => model.storage === 'records'))\n`
        const schema = addTemplate({ filename: 'liti/records.mjs', write: true, getContents: schemaSource })
        // Database inspects contributions before Nuxt writes its ordinary templates.
        await mkdir(dirname(definitions.dst), { recursive: true })
        await writeFile(definitions.dst, definitionsSource())
        await writeFile(schema.dst, schemaSource())
        const runtime = addTemplate({
            filename: 'liti/runtime.mjs',
            write: true,
            getContents: () =>
                `import { models } from ${JSON.stringify(slash(definitions.dst))}\nimport { content } from ${JSON.stringify(contentFile)}\nimport { createLitiRuntime } from 'liti/server'\nconst runtime = createLitiRuntime({ models, content, workspace: ${JSON.stringify(options.workspace)}, database: ${JSON.stringify(options.database)} })\nexport const useLiti = () => runtime\nexport default runtime\n`,
        })
        addServerImports({ name: 'useLiti', from: slash(runtime.dst) })
        const plugin = addTemplate({
            filename: 'liti/plugin.mjs',
            write: true,
            getContents: () =>
                `import { defineNitroPlugin } from 'nitropack/runtime'\nimport runtime from ${JSON.stringify(slash(runtime.dst))}\nexport default defineNitroPlugin(nitro => { nitro.hooks.hook('close', () => runtime.dispose()) })\n`,
        })
        addTypeTemplate(
            {
                filename: 'types/liti.d.ts',
                getContents: () => {
                    const union =
                        files.map((file) => `typeof import(${JSON.stringify(file)})`).join(' | ') ||
                        'Record<never, never>'
                    return `import type { Model } from '@litijs/model'\nimport 'liti/types'\ntype Values<T> = T extends unknown ? T[keyof T] : never\ntype Models = Extract<Values<${union}>, Model>\ntype Registry = { [M in Models as M['name']]: M }\ndeclare module 'liti/types' { interface LitiModels extends Registry {} }\nexport {}\n`
                },
            },
            { nuxt: true, nitro: true, node: true },
        )
        addTypeTemplate(
            {
                filename: 'types/liti-runtime.d.ts',
                getContents: () =>
                    "declare module '#liti/runtime' { const runtime: import('liti/server').LitiRuntime; export default runtime }\n",
            },
            { nuxt: true, nitro: true, node: true },
        )
        nuxt.options.runtimeConfig.public.liti = { baseURL: options.baseURL }
        nuxt.options.vite.plugins ??= []
        nuxt.options.vite.plugins.push(modelDatabaseContribution({ module: slash(schema.dst), export: 'tables' }))
        addImports({ name: 'useLitiQuery', from: resolver.resolve('../runtime/composables/query') })
        addImports({ name: 'useLitiModels', from: resolver.resolve('../runtime/composables/models') })
        addImports({ name: 'useLitiSession', from: resolver.resolve('../runtime/composables/session') })
        addImports({ name: 'useLitiForm', from: resolver.resolve('../runtime/composables/form') })
        addImports({ name: 'useLitiSeo', from: resolver.resolve('../runtime/seo/index') })
        if (options.admin)
            extendPages((pages) => {
                pages.push({
                    name: 'liti-model-tools',
                    path: '/_liti',
                    file: resolver.resolve('../runtime/admin/tools.vue'),
                })
            })
        nuxt.hook('nitro:config', (input) => {
            const config = input as NitroConfig
            config.alias ??= {}
            config.alias['#liti/runtime'] = slash(runtime.dst)
            config.alias['vite-hub/_internal/content/runtime/console'] = resolver.resolve('../runtime/server/console')
            config.plugins ??= []
            config.plugins.unshift(slash(plugin.dst))
            config.externals ??= {}
            config.externals.inline ??= []
            config.externals.inline.push('liti', '@litijs/model', '@litijs/blog')
            config.handlers ??= []
            config.handlers.push({
                route: options.baseURL,
                method: 'get',
                handler: resolver.resolve('../runtime/server/public.get'),
            })
            config.handlers.push({
                route: `${options.baseURL}/manage`,
                method: 'post',
                handler: resolver.resolve('../runtime/server/manage.post'),
            })
        })
        nuxt.hook('modules:done', () => {
            if (!hasNuxtModule('vite-hub/nuxt'))
                throw new Error('[liti] Register vite-hub/nuxt explicitly in modules and configure its Definitions.')
            if (!existsSync(contentFile))
                throw new Error(
                    '[liti] Create server/content.ts with an explicit defineContent({ extends: cms, collections }) and export const content.',
                )
        })
        nuxt.options.watch.push(slash(directory) + '/**/*')
        nuxt.hook('builder:watch', async (_event, path) => {
            if (!slash(resolve(nuxt.options.rootDir, path)).startsWith(slash(directory) + '/')) return
            files = await modelFiles(directory)
            await updateTemplates({
                filter: (template) => template.filename.startsWith('liti/') || template.filename === 'types/liti.d.ts',
            })
        })
    },
})
