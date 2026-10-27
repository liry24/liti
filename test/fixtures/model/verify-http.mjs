import assert from 'node:assert/strict'

export async function verifyHttp(origin, token, logs = () => '') {
    assert.equal((await fetch(`${origin}/api/__probe`, { method: 'POST' })).status, 403)
    const response = await fetch(`${origin}/api/__probe`, {
        method: 'POST',
        headers: { 'x-liti-probe': token },
        signal: AbortSignal.timeout(60_000),
    })
    const body = await response.text()
    assert.equal(response.status, 200, `${body}\n${logs()}`)
    const result = JSON.parse(body)
    assert.equal(result.checks.length, 9)
    for (const check of result.checks) console.log(`PASS ${check}`)
    const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
            name: 'editor',
            email: `editor-${crypto.randomUUID()}@example.test`,
            password: 'Synthetic-probe-password-2026',
        }),
    })
    assert.equal(signup.status, 200, `${await signup.text()}\n${logs()}`)
    const editor = signup.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; ')
    const attempt = await fetch(`${origin}/_vitehub/rpc/__call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vitehub-console': '1', cookie: editor, origin },
        body: JSON.stringify({
            method: 'vitehub:console:documents',
            input: {
                method: 'POST',
                query: { section: 'content', action: 'save' },
                body: {
                    collection: 'posts',
                    id: `${crypto.randomUUID()}/ja`,
                    data: { title: 'Console bypass', slug: 'bypass', tags: [] },
                    body: '',
                },
            },
        }),
    })
    assert.ok(attempt.status >= 400, `Console bypass returned ${attempt.status}`)
    console.log('PASS Console cannot bypass Model validation even for an authenticated editor')
    return { editor, documentId: result.documentId }
}
