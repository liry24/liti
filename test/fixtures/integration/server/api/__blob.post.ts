import assert from 'node:assert/strict'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async (event) => {
    if (!process.env.LITI_PROBE_TOKEN || getHeader(event, 'x-liti-probe') !== process.env.LITI_PROBE_TOKEN)
        throw createError({ statusCode: 403 })
    const bytes = new Uint8Array([0, 1, 2, 255]),
        pathname = `dev-probe/${crypto.randomUUID()}.bin`
    const [writeError, stored] = await blob.put(pathname, bytes, { contentType: 'application/octet-stream' })
    assert.ifError(writeError)
    assert.ok(stored)
    assert.equal(stored.pathname, pathname)
    const [readError, file] = await blob.get(pathname)
    assert.ifError(readError)
    assert.ok(file)
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes)
    return { pathname }
})
