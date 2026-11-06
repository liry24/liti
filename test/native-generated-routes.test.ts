import { resolve } from 'node:path'
import { mergeGeneratedSourceNitroConfig } from 'vite-hub/source/vite'
import { expect, it } from 'vite-plus/test'

it('reuses generated routes across Windows separators while rejecting user route collisions', () => {
    const route = '/api/content/**'
    const handler = resolve('.vitehub/content/route.mjs')
    const generated = [{ handler, route }]
    const config = mergeGeneratedSourceNitroConfig(
        { handlers: [{ handler: handler.replaceAll('\\', '/'), route, lazy: true }] },
        generated,
    )
    expect(config.handlers).toHaveLength(1)
    expect(mergeGeneratedSourceNitroConfig(config, generated).handlers).toHaveLength(1)
    expect(() =>
        mergeGeneratedSourceNitroConfig({ handlers: [{ handler: resolve('server/custom.ts'), route }] }, generated),
    ).toThrow(/conflicts with an existing handler/)
})
