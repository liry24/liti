import { registerWorkspacePlugin } from 'vite-hub/workspace'

export default defineNitroPlugin((nitro) => {
    const unregister = registerWorkspacePlugin('content', {
        id: 'liti-probe-permanent-validation',
        hooks: {
            'write:validate': (input) => {
                if (input.path.startsWith('posts/') && String(input.content).includes('CONSOLE_FORBIDDEN_PROBE'))
                    throw new Error('PROBE_CONSOLE_WRITE_REJECTED')
            },
        },
    })
    nitro.hooks.hook('close', unregister)
})
