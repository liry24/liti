import assert from 'node:assert/strict'
import { verifyHttp as verifyModel } from './verify-model-http.mjs'
export async function verifyHttp(origin, token, logs) {
    const context = await verifyModel(origin, token, logs)
    const manage = (body, cookie = context.editor, requestOrigin = origin) =>
        fetch(`${origin}/api/_liti/manage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie, origin: requestOrigin },
            body: JSON.stringify(body),
        })
    assert.equal((await manage({ action: 'models' }, '')).status, 401)
    const hostile = await manage({ action: 'models' }, context.editor, 'https://hostile.test')
    assert.equal(hostile.status, 403, `${await hostile.text()}\n${logs()}`)
    const metadata = await manage({ action: 'models' })
    assert.equal(metadata.status, 200, await metadata.clone().text())
    assert.ok((await metadata.json()).some((model) => model.name === 'games' && model.storage === 'records'))
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
    const rpc = (action, body) =>
        fetch(`${origin}/_vitehub/rpc/__call`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-vitehub-console': '1', cookie: context.editor, origin },
            body: JSON.stringify({
                method: 'vitehub:console:documents',
                input: { method: 'POST', query: { section: 'content', action }, body },
            }),
        })
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
    return context
}
