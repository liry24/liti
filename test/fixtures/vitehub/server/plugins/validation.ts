import { registerWorkspacePlugin } from 'vite-hub/workspace'
import { managedWriteScope } from '../utils/managed'

export default defineNitroPlugin((nitro) => {
    const unregister = registerWorkspacePlugin('content', {
        id: 'liti-probe-permanent-validation',
        hooks: {
            'write:validate': (input) => {
                if (
                    (input.path.startsWith('managed/') || input.path.startsWith('.liti-probe/')) &&
                    !managedWriteScope.getStore()
                )
                    throw new Error('PROBE_MANAGED_ROUTE_REQUIRED')
                if (input.path.startsWith('posts/') && String(input.content).includes('CONSOLE_FORBIDDEN_PROBE'))
                    throw new Error('PROBE_CONSOLE_WRITE_REJECTED')
            },
        },
    })
    nitro.hooks.hook('close', unregister)
})
