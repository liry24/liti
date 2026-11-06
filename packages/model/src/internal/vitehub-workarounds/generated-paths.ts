import { isAbsolute, resolve } from 'node:path'
import type { Nitro, NitroModule } from 'nitro/types'

export function generatedPaths() {
    let host: Nitro | undefined
    const normalize = () => {
        if (!host) return
        const root = host.options.rootDir
        const path = (value: string) =>
            isAbsolute(value) || value.includes('.vitehub') ? resolve(root, value).replaceAll('\\', '/') : value
        host.options.plugins = host.options.plugins.map(path)
        for (const handler of host.options.handlers) handler.handler = path(handler.handler)
        host.routing.sync()
    }
    const nitro: NitroModule = {
        name: 'liti-vitehub-generated-paths',
        setup(instance) {
            host = instance
            instance.hooks.hook('build:before', normalize)
        },
    }
    // ViteHub's async config hooks add handlers after Nitro initializes its environment.
    return {
        nitro,
        buildApp: { order: 'pre' as const, handler: normalize },
        configureServer: { order: 'pre' as const, handler: normalize },
    }
}
