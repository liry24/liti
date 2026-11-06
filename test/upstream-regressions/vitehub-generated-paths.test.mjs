import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { normalizeGeneratedPaths } from '../fixtures/vitehub/workarounds/generated-paths.ts'

await test('ViteHub generated Nitro paths are absolute and safe to embed on Windows', () => {
    const root = resolve('test/fixtures/vitehub')
    const config = {
        plugins: ['.vitehub/nitro/workspace/plugin.ts', 'unrelated-plugin'],
        handlers: [{ handler: resolve(root, '.vitehub/content/route.mjs') }],
    }
    normalizeGeneratedPaths(root, config)
    assert.equal(config.plugins[0], resolve(root, '.vitehub/nitro/workspace/plugin.ts').replaceAll('\\', '/'))
    assert.equal(config.plugins[1], 'unrelated-plugin')
    assert.equal(config.handlers[0].handler, resolve(root, '.vitehub/content/route.mjs').replaceAll('\\', '/'))
    assert.equal(config.handlers[0].handler.includes('\\'), false)
})
