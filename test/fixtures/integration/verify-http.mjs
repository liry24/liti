import assert from 'node:assert/strict'
import { verifyHttp as verifyModel } from './verify-model-http.mjs'
export { verifyContentPerformance as verifyPerformance } from './verify-performance.mjs'
export async function verifyHttp(origin, token, logs) {
    const context = await verifyModel(origin, token, logs)
    for (const query of ['filter=%7B', 'fallback=invalid', 'id=one', 'mode=one&id=one&path=%2Fone']) {
        const invalidQuery = await fetch(`${origin}/api/_liti?model=posts&${query}`)
        assert.equal(invalidQuery.status, 400, await invalidQuery.clone().text())
    }
    const blog = await fetch(`${origin}/api/__blog`, { method: 'POST', headers: { 'x-liti-probe': token } })
    assert.equal(blog.status, 200, `${await blog.clone().text()}\n${logs()}`)
    for (const check of (await blog.json()).checks) console.log(`PASS ${check}`)
    const manage = (body, cookie = context.editor, requestOrigin = origin) =>
        fetch(`${origin}/api/_liti/manage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie, origin: requestOrigin },
            body: JSON.stringify(body),
        })
    const rpc = (action, body, cookie = context.editor) =>
        fetch(`${origin}/_vitehub/rpc/__call`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-vitehub-console': '1', cookie, origin },
            body: JSON.stringify({
                method: 'vitehub:console:documents',
                input: { method: 'POST', query: { section: 'content', action }, body },
            }),
        })
    assert.equal((await manage({ action: 'models' }, '')).status, 401)
    const hostile = await manage({ action: 'models' }, context.editor, 'https://hostile.test')
    assert.equal(hostile.status, 403, `${await hostile.text()}\n${logs()}`)
    const metadata = await manage({ action: 'models' })
    assert.equal(metadata.status, 200, await metadata.clone().text())
    assert.ok((await metadata.json()).some((model) => model.name === 'games' && model.storage === 'records'))
    const firstUser = (
        await (await fetch(`${origin}/api/auth/get-session`, { headers: { cookie: context.editor } })).json()
    ).user
    const second = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
            name: 'second',
            email: `editor-${crypto.randomUUID()}@example.test`,
            password: 'Synthetic-probe-password-2026',
        }),
    })
    assert.equal(second.status, 200, await second.clone().text())
    const secondUser = (await second.json()).user,
        secondCookie = second.headers
            .getSetCookie()
            .map((cookie) => cookie.split(';')[0])
            .join('; ')
    const owned = [
        { user: firstUser, cookie: context.editor, secret: `FIRST_PRIVATE_${crypto.randomUUID()}` },
        { user: secondUser, cookie: secondCookie, secret: `SECOND_PRIVATE_${crypto.randomUUID()}` },
    ]
    for (const entry of owned) {
        const created = await manage(
            {
                action: 'save',
                model: 'memos',
                id: entry.user.id,
                data: { title: 'Owner memo', secret: entry.secret },
                ifDigest: null,
            },
            entry.cookie,
        )
        assert.equal(created.status, 200, await created.clone().text())
    }
    const pages = await Promise.all(
        owned.flatMap((entry) =>
            owned.map(async (viewer) => {
                const html = await (
                    await fetch(`${origin}/private?id=${entry.user.id}`, { headers: { cookie: viewer.cookie } })
                ).text()
                assert.equal(html.includes(entry.secret), entry.user.id === viewer.user.id, html)
                assert.equal(html.includes(owned.find((other) => other.user.id !== entry.user.id).secret), false, html)
            }),
        ),
    )
    assert.equal(pages.length, 4)
    const spoofed = await fetch(`${origin}/api/_liti/manage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, cookie: secondCookie, 'x-liti-actor': firstUser.id },
        body: JSON.stringify({ action: 'read', model: 'memos', id: firstUser.id }),
    })
    assert.equal(spoofed.status, 403, await spoofed.clone().text())
    const consoleMemo = await rpc('get', { collection: 'memos', id: firstUser.id })
    assert.equal(consoleMemo.status, 200, await consoleMemo.clone().text())
    assert.equal((await consoleMemo.json()).value.data.secret, owned[0].secret)
    const otherMemo = await rpc('get', { collection: 'memos', id: firstUser.id }, secondCookie)
    assert.equal(otherMemo.status, 403, await otherMemo.clone().text())
    const rawDatabase = await fetch(`${origin}/_vitehub/rpc/__call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vitehub-console': '1', cookie: context.editor, origin },
        body: JSON.stringify({
            method: 'vitehub:console:database',
            input: { method: 'GET', query: { database: 'default' } },
        }),
    })
    assert.equal(rawDatabase.status, 403, await rawDatabase.clone().text())
    console.log('PASS concurrent authenticated SSR isolates owner-only drafts and rejects a spoofed actor header')
    console.log('PASS Console enforces entry ownership and the native policy rejects raw Database inspection')
    const id = crypto.randomUUID()
    const save = await manage({
        action: 'save',
        model: 'posts',
        id,
        locale: 'ja',
        data: { title: 'Nuxt private form', slug: id, tags: [], secret: 'SERVER_PRIVATE_MODEL_MARKER' },
        body: 'Body',
        ifDigest: null,
    })
    assert.equal(save.status, 200, `${await save.clone().text()}\n${logs()}`)
    const receipt = await save.json()
    assert.equal('data' in receipt, false)
    const consoleId = crypto.randomUUID()
    const consoleInput = {
        collection: 'posts',
        id: `${consoleId}/ja`,
        data: { title: 'Managed Console', slug: consoleId, tags: [] },
        body: 'Console model body',
        ifDigest: null,
    }
    const consoleSave = await rpc('save', consoleInput)
    const consoleBody = await consoleSave.text()
    assert.equal(consoleSave.status, 200, `${consoleBody}\n${logs()}`)
    const consoleReceipt = JSON.parse(consoleBody).value
    assert.equal(consoleReceipt.data._litiBody, undefined)
    const invalidConsole = await rpc('save', {
        ...consoleInput,
        ifDigest: consoleReceipt.digest,
        data: { ...consoleInput.data, title: '' },
    })
    assert.equal(invalidConsole.status, 400, await invalidConsole.clone().text())
    const consolePublish = await rpc('publish', {
        collection: 'posts',
        expect: [{ id: `${consoleId}/ja`, digest: consoleReceipt.digest }],
    })
    assert.equal(consolePublish.status, 200, await consolePublish.clone().text())
    assert.equal(
        (await (await fetch(`${origin}/api/_liti?model=posts&mode=one&id=${consoleId}`)).json()).data.title,
        'Managed Console',
    )
    console.log('PASS native Console editor routes valid saves/publications through Model and rejects invalid fields')
    const batch = []
    let batchRevision
    for (let index = 0; index < 2; index++) {
        const entryId = crypto.randomUUID()
        const response = await manage({
            action: 'save',
            model: 'posts',
            id: entryId,
            locale: 'ja',
            ifDigest: null,
            data: { title: `Reviewed list ${index}`, slug: entryId, tags: [] },
        })
        assert.equal(response.status, 200, await response.clone().text())
        const saved = await response.json()
        batchRevision = saved.revision
        batch.push({ model: 'posts', id: entryId, digests: { ja: saved.digest, en: null } })
    }
    const publishMany = (entries, revision = batchRevision) => manage({ action: 'publishMany', entries, revision })
    assert.equal((await publishMany(batch, 'stale-review')).status, 409)
    assert.equal((await publishMany([batch[0], batch[0]])).status, 400)
    assert.equal((await publishMany([batch[0], { ...batch[1], digests: { ja: 'stale', en: null } }])).status, 409)
    const otherDraft = await (await manage({ action: 'read', model: 'memos', id: secondUser.id }, secondCookie)).json()
    assert.equal(
        (
            await publishMany([
                batch[0],
                {
                    model: 'memos',
                    id: secondUser.id,
                    digests: { und: otherDraft.digest },
                },
            ])
        ).status,
        403,
    )
    for (const entry of batch)
        assert.equal(await (await fetch(`${origin}/api/_liti?model=posts&mode=one&id=${entry.id}`)).json(), null)
    const publishedBatch = await publishMany(batch)
    assert.equal(publishedBatch.status, 200, await publishedBatch.clone().text())
    for (const entry of batch)
        assert.equal(
            (await (await fetch(`${origin}/api/_liti?model=posts&mode=one&id=${entry.id}`)).json()).id,
            entry.id,
        )
    console.log(
        'PASS reviewed batch publication rejects stale order, duplicate entries, changed documents and unauthorized entries without partial publication',
    )
    const read = await manage({ action: 'read', model: 'posts', id, locale: 'ja', revision: receipt.revision })
    assert.equal((await read.json()).data.secret, 'SERVER_PRIVATE_MODEL_MARKER')
    const unpublished = await fetch(`${origin}/api/_liti?model=posts&mode=one&id=${id}&locale=ja`)
    const unpublishedBody = await unpublished.text()
    assert.equal(unpublished.status, 200, `${unpublishedBody}\n${logs()}`)
    assert.equal(unpublishedBody, 'null')
    const published = await manage({ action: 'publish', model: 'posts', id, digests: { ja: receipt.digest, en: null } })
    assert.equal(published.status, 200, await published.clone().text())
    const visible = await (await fetch(`${origin}/api/_liti?model=posts&mode=one&id=${id}&locale=en`)).json()
    assert.equal(visible.data.title, 'Nuxt private form')
    assert.equal(visible.data.secret, undefined)
    const html = await fetch(`${origin}/query?id=${id}`)
    const rendered = await html.text()
    assert.equal(html.status, 200, `${rendered}\n${logs()}`)
    assert.ok(rendered.includes('Nuxt private form'), rendered)
    assert.ok(!rendered.includes('SERVER_PRIVATE_MODEL_MARKER'), rendered)
    const edit = await fetch(`${origin}/edit?id=${id}`, { headers: { cookie: context.editor } })
    const editHtml = await edit.text()
    assert.equal(edit.status, 200, `${editHtml}\n${logs()}`)
    assert.ok(editHtml.includes('Nuxt private form'), editHtml)
    const unauthorizedEdit = await fetch(`${origin}/edit?id=${id}`)
    assert.ok(!(await unauthorizedEdit.text()).includes('SERVER_PRIVATE_MODEL_MARKER'))
    console.log(
        'PASS packed liti/nuxt discovery, generated types, authenticated SSR forms, public-only query/SEO and origin checks',
    )
    const { chromiumProbe } = await import('./verify-browser.mjs')
    const publicPage = await chromiumProbe(`${origin}/query?id=${id}&bundle=1`, process.cwd())
    assert.ok(publicPage.scripts.length)
    for (const script of publicPage.scripts) {
        const source = await (await fetch(script)).text()
        for (const forbidden of [
            'MODEL_RULE_REJECTED',
            'SERVER_ONLY_AGENT_MARKER',
            '_getOrCreateFieldApi',
            'モデルの翻訳と参照',
            '原文の本文に戻す',
        ])
            assert.ok(!source.includes(forbidden), `${forbidden} entered public script ${script}`)
    }
    console.log('PASS hydrated public page excludes Model server validation, Agent and form/admin implementations')
    const browser = await chromiumProbe(`${origin}/browser`, process.cwd())
    assert.equal(browser.success, true, JSON.stringify(browser))
    for (const check of browser.checks) console.log(`PASS ${check}`)
    const review = await chromiumProbe(`${origin}/review`, process.cwd())
    assert.equal(review.success, true, JSON.stringify(review))
    for (const check of review.checks) console.log(`PASS ${check}`)
    return context
}
