import assert from 'node:assert/strict'

export async function verifyHttp(origin, token, logs = () => '') {
    const rpc = async (action, body, cookie = '') =>
        await fetch(`${origin}/_vitehub/rpc/__call`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-vitehub-console': '1', cookie, origin },
            body: JSON.stringify({
                method: 'vitehub:console:documents',
                input: {
                    method: 'POST',
                    query: { section: 'content', action },
                    body,
                },
            }),
        })
    assert.equal((await rpc('list', { collection: 'posts' })).status, 401)
    const session = async (role) => {
        const email = `${role}-${crypto.randomUUID()}@example.test`
        const response = await fetch(`${origin}/api/auth/sign-up/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: JSON.stringify({ name: role, email, password: 'Synthetic-probe-password-2026' }),
        })
        const result = await response.text()
        assert.equal(response.status, 200, `${result}\n${logs()}`)
        const cookie = response.headers
            .getSetCookie()
            .map((item) => item.split(';')[0])
            .join('; ')
        assert.ok(cookie)
        const current = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie } })
        assert.equal(current.status, 200)
        assert.equal((await current.json()).user.email, email)
        return cookie
    }
    const editor = await session('editor')
    const reader = await session('reader')
    const document = {
        collection: 'posts',
        id: crypto.randomUUID(),
        data: { title: 'Console' },
        body: 'Console body',
        ifDigest: null,
    }
    assert.equal((await rpc('save', document, reader)).status, 403)
    assert.equal((await rpc('save', { ...document, collection: 'managed' }, editor)).status, 500)
    const savedResponse = await rpc('save', document, editor)
    const savedText = await savedResponse.text()
    assert.equal(savedResponse.status, 200, `${savedText}\n${logs()}`)
    const saved = JSON.parse(savedText).value
    assert.equal(saved.data.title, 'Console')
    const forbidden = await rpc(
        'save',
        { ...document, data: { title: 'CONSOLE_FORBIDDEN_PROBE' }, ifDigest: saved.digest },
        editor,
    )
    assert.equal(forbidden.status, 500)
    const unchanged = await rpc('get', { collection: 'posts', id: document.id }, editor)
    assert.equal((await unchanged.json()).value.digest, saved.digest)
    assert.equal(
        (await rpc('publish', { collection: 'posts', expect: [{ id: document.id, digest: saved.digest }] }, reader))
            .status,
        403,
    )
    const published = await rpc(
        'publish',
        { collection: 'posts', expect: [{ id: document.id, digest: saved.digest }] },
        editor,
    )
    assert.equal(published.status, 200, `${await published.text()}\n${logs()}`)
    console.log('PASS Auth signup/session and Console RPC authorization/validation/publication')
    const denied = await fetch(`${origin}/api/__probe`, { method: 'POST' })
    assert.equal(denied.status, 403)
    const response = await fetch(`${origin}/api/__probe`, {
        method: 'POST',
        headers: { 'x-liti-probe': token },
        signal: AbortSignal.timeout(30_000),
    })
    const body = await response.text()
    assert.equal(response.status, 200, `${body}\n${logs()}`)
    const result = JSON.parse(body)
    assert.equal(result.checks.length, 11)
    for (const check of result.checks) console.log(`PASS ${check}`)
    const references = await rpc('references', { pathnames: [result.image.pathname] }, editor)
    assert.equal(references.status, 200)
    const referenceResult = await references.json()
    const reference = referenceResult.value.references[result.image.pathname].find(
        (item) => item.id === result.image.documentId,
    )
    assert.ok(reference, JSON.stringify(referenceResult))
    assert.deepEqual(reference.refs, ['published'])
    console.log('PASS native image references, stored PNG bytes and Console published-only usage')
    return { editor, documentId: document.id }
}
