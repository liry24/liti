import { fileURLToPath } from 'node:url'
import { NUXT_DEVTOOLS_GROUP_ID, onDevtoolsReady } from '@nuxt/devtools-kit'
import type { Nuxt } from 'nuxt/schema'
import { defineDevframe, defineRpcFunction } from 'devframe'
import { createEmbedded } from 'devframe/adapters/embedded'
import { DEVTOOLS_PATH } from './index'

export const setupDock = (nuxt: Nuxt): void => {
    onDevtoolsReady(async (context) => {
        const clientAssets = fileURLToPath(new URL('./client', import.meta.url))
        await createEmbedded(
            defineDevframe({
                id: 'liti',
                name: 'liti',
                version: '0.0.0',
                packageName: 'liti',
                homepage: 'https://github.com/liry24/liti',
                description: 'Read-only liti runtime diagnostics.',
                importMetaUrl: import.meta.url,
                clientAssets,
                async setup(frame) {
                    await frame.host.mountConnectionMeta?.(DEVTOOLS_PATH)
                    frame.views.hostStatic(DEVTOOLS_PATH, clientAssets)
                    const diagnostics = frame.diagnostics.defineDiagnostics({
                        codes: {
                            LITI_INSPECTION_FAILED: {
                                why: 'The authenticated runtime snapshot could not be read.',
                                fix: 'Sign in with system.diagnostics permission; generate and explicitly apply pending Drizzle migrations.',
                            },
                        },
                    })
                    frame.diagnostics.register(diagnostics)
                    let reported = false
                    frame.scope('liti').rpc.register(
                        defineRpcFunction({
                            name: 'report-failure',
                            type: 'event',
                            handler() {
                                if (reported) return
                                reported = true
                                diagnostics.LITI_INSPECTION_FAILED({}, { method: 'error' })
                                void context.messages.add({
                                    id: 'liti:inspection',
                                    message: 'liti inspection failed',
                                    description: 'Check authentication and database migrations.',
                                    level: 'error',
                                    category: 'liti',
                                    labels: ['liti'],
                                    notify: true,
                                })
                            },
                        }),
                    )
                },
            }),
            { ctx: context },
        )
        context.docks.register({
            id: 'liti',
            title: 'liti',
            icon: 'ph:database',
            type: 'iframe',
            url: DEVTOOLS_PATH,
            groupId: NUXT_DEVTOOLS_GROUP_ID,
        })
        context.commands.register({
            id: 'liti:open',
            title: 'liti: Open',
            category: 'tools',
            handler: () => context.docks.activate('liti'),
        })
        for (const [method, title] of [
            ['refresh', 'Refresh'],
            ['copy-diagnostics', 'Copy Diagnostics'],
        ] as const) {
            context.commands.register({
                id: `liti:${method}`,
                title: `liti: ${title}`,
                category: 'tools',
                handler: () => context.scope('liti').rpc.broadcast({ method, args: [], optional: true, event: true }),
            })
        }
    }, nuxt)
}
