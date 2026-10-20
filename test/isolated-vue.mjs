import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chromiumProbe } from './public-data-consumer.mjs'

export const verifyIsolatedVue = async (cwd, run) => {
    await writeFile(join(cwd, 'app.mjs'), await readFile(new URL('./fixtures/standalone-vue/app.mjs', import.meta.url)))
    await writeFile(
        join(cwd, 'render.mjs'),
        `
import { renderToString } from 'vue/server-renderer'
import { createApp } from './app.mjs'
console.log(await renderToString(createApp()))
`,
    )
    const html = run(process.execPath, ['render.mjs'], cwd)
    assert.match(html, /value="initial"/u)
    run('bun', ['build', 'app.mjs', '--target=browser', '--outfile=app-bundle.js'], cwd)
    const javascript = await readFile(join(cwd, 'app-bundle.js'))
    const server = createServer((request, response) => {
        response.setHeader('content-type', request.url === '/app.js' ? 'text/javascript' : 'text/html')
        response.end(
            request.url === '/app.js'
                ? javascript
                : `<!doctype html><div id="app">${html}</div><script type="module" src="/app.js"></script>`,
        )
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    try {
        const result = await chromiumProbe(`http://127.0.0.1:${server.address().port}`, cwd)
        assert.equal(result.ok, true, JSON.stringify(result))
        assert.deepEqual(
            result.browserDiagnostics.filter((entry) => /hydration|mismatch/iu.test(entry.text ?? '')),
            [],
        )
    } finally {
        await new Promise((resolve) => server.close(resolve))
    }
}
