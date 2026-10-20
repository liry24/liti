import { defineFilesConfig } from 'nuxt-files-sdk/config'

// Provider configuration is owned by the Files integration, outside core configuration.
// @ts-expect-error The fs provider requires root.
defineFilesConfig({ storage: { adapter: 'fs', config: { missing: true } } })
// @ts-expect-error Environment provider options retain native validation.
defineFilesConfig({ $production: { storage: { adapter: 'fs', config: { missing: true } } } })
// @ts-expect-error Unknown provider option.
defineFilesConfig({ storage: { adapter: 'memory', madeUpOption: true } })

defineFilesConfig({
    storage: { content: { adapter: 'memory' } },
    $production: {
        routes: [
            {
                path: '/files',
                storage: 'content',
                authorize: ({ event }) => {
                    const request: Request = event.req
                    // @ts-expect-error Native events do not expose Node request adapters.
                    void event.node
                    void request
                    return undefined
                },
            },
        ],
    },
})
