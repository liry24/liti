import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import test from 'node:test'

const entry = import.meta.resolve('nuxt')
const source = await readFile(new URL(entry), 'utf8')
const dependency = async (name) => await import(import.meta.resolve(name))
const walker = await dependency('oxc-walker')
const strings = await dependency('rolldown-string')
const { createUnplugin } = await dependency('unplugin')
const start = source.indexOf('const functionsToExtract =')
const end = source.indexOf('//#endregion', start)
assert.ok(start >= 0 && end > start, 'Locate the installed Nuxt extraction transform.')
const filters = ['SUPPORTED_EXT_RE', 'STYLE_QUERY_RE', 'MACRO_QUERY_RE$2']
    .map((name) => source.split('\n').find((line) => line.startsWith(`const ${name} =`)))
    .join('\n')
const factory = new Function(
    'ScopeTracker',
    'parseAndWalk',
    'walk',
    'getUndeclaredIdentifiersInFunction',
    'createUnplugin',
    'generateTransform',
    'rolldownString',
    'dirname',
    `${filters}\n${source.slice(start, end)}\nreturn ExtractAsyncDataHandlersPlugin;`,
)(
    walker.ScopeTracker,
    walker.parseAndWalk,
    walker.walk,
    walker.getUndeclaredIdentifiersInFunction,
    createUnplugin,
    strings.generateTransform,
    strings.rolldownString,
    dirname,
)

await test('installed Nuxt extraction retains enclosing and callback parameters in block and expression handlers', async () => {
    for (const method of ['useAsyncData', 'useLazyAsyncData']) {
        for (const expression of [false, true]) {
            const plugin = factory({ sourcemap: false }).raw({}, { framework: 'vite' })
            const body = '({ entry: options.id ? await request(signal) : null })'
            const input = `function example(options) {
                const request = async (signal) => signal;
                return ${method}((() => 'entry')(), async (_app, { signal }) => ${expression ? body : `{ return ${body}; }`});
            }`
            let output = plugin.transform.handler(input, '/fixture.js').code
            output = output.replace(/import\('([^']+)'\)/g, (_match, id) => {
                const chunk = plugin.load.handler(id)
                assert.ok(chunk?.code)
                return `import('data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}')`
            })
            const example = new Function(method, `${output}; return example;`)((_key, handler) => handler)
            const signal = new AbortController().signal
            assert.deepEqual(await example({ id: 'reviewed' })(undefined, { signal }), { entry: signal })
            assert.deepEqual(await example({ id: null })(undefined, { signal }), { entry: null })
        }
    }
})
