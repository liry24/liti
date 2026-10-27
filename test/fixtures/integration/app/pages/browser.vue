<script setup lang="ts">
const selected = ref<string | null>(null),
    locale = ref('ja')
const session = useLitiSession()
const callbacks: boolean[] = []
const resource = await useLitiForm('posts', {
    id: selected,
    locale,
    onSuccess: (_receipt, context) => {
        callbacks.push(context.hasUnsavedChanges)
    },
})
const first = await useLitiQuery('posts', { mode: 'one', id: selected, locale: 'ja' })
const second = await useLitiQuery('posts', { mode: 'one', id: selected, locale: 'ja' })
const raceId = ref<string | null>(null),
    slowId = ref<string | null>(null)
const canceledId = ref<string | null>(null),
    cancelController = new AbortController()
const race = await useLitiQuery('posts', { mode: 'one', id: raceId, locale: 'ja' })
const timed = await useLitiQuery('posts', { mode: 'one', id: slowId, timeout: 35 })
const canceled = await useLitiQuery('posts', { mode: 'one', id: canceledId, signal: cancelController.signal })
const { form, values, receipt, save, hasUnsavedChanges } = resource
const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds))
const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message)
}
const until = async (predicate: () => unknown) => {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return
        await pause(25)
    }
    throw new Error('Browser state did not settle')
}
const manage = async (input: Record<string, unknown>) => {
    const response = await fetch('/api/_liti/manage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(await response.text())
    return (await response.json()) as Record<string, unknown>
}
const signUp = async () => {
    const response = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: 'editor',
            email: `editor-${crypto.randomUUID()}@example.test`,
            password: 'Synthetic-probe-password-2026',
        }),
    })
    check(response.ok, `Browser signup: ${await response.text()}`)
    await session.refresh()
    await until(() => resource.descriptor.value)
}
onMounted(async () => {
    const checks: string[] = []
    try {
        await signUp()
        const id = crypto.randomUUID()
        const initial = await manage({
            action: 'save',
            model: 'posts',
            id,
            locale: 'ja',
            ifDigest: null,
            data: { title: 'Browser initial', slug: id, tags: [] },
            body: 'Original browser body',
        })
        await manage({ action: 'publish', model: 'posts', id, digests: { ja: initial.digest, en: null } })
        selected.value = id
        await until(
            () =>
                receipt.value?.digest &&
                values.value.data.title === 'Browser initial' &&
                first.data.value?.data.title === 'Browser initial' &&
                second.data.value?.data.title === 'Browser initial',
        )
        checks.push('browser authentication, inferred forms and shared public query')
        form.setFieldValue('data.title', 'Submitted browser')
        const pending = save()
        await pause(80)
        form.setFieldValue('data.title', 'Keep later browser edit')
        const saved = await pending
        check(saved?.digest, 'The committed save receipt was lost')
        check(values.value.data.title === 'Keep later browser edit', 'An in-flight edit was overwritten')
        check(hasUnsavedChanges.value && callbacks.at(-1) === true, 'Success callback lost the unsaved-change snapshot')
        const committed = await manage({ action: 'read', model: 'posts', id, locale: 'ja', revision: saved?.revision })
        check(
            (committed.data as { title: string }).title === 'Submitted browser',
            'Read the committed immutable revision',
        )
        checks.push('native form save preserves later edits and the committed receipt')
        const reviewedDigest = receipt.value?.digest
        const successCount = callbacks.length
        form.setFieldValue('data.title', '')
        let saveRejected = false
        try {
            await save()
        } catch {
            saveRejected = true
        }
        check(saveRejected && resource.error.value, 'A failed save must reject and retain its error')
        check(
            receipt.value?.digest === reviewedDigest && callbacks.length === successCount,
            'A failed save changed its receipt or emitted success',
        )
        check(values.value.data.title === '' && hasUnsavedChanges.value, 'A failed save discarded the editable values')
        form.setFieldValue('data.title', 'Recovered browser')
        const retry = await save()
        check(retry?.digest && !resource.error.value, 'A corrected submission must save normally')
        form.setFieldValue('data.title', 'Keep later browser edit')
        await until(() => values.value.data.title === 'Keep later browser edit' && hasUnsavedChanges.value)
        checks.push('failed native form save rejects, keeps edits and the reviewed receipt, and retries successfully')
        locale.value = 'en'
        await until(() => resource.status.value === 'success' && receipt.value === null)
        form.setFieldValue('data.title', 'English browser')
        await save()
        const translated = await manage({ action: 'read', model: 'posts', id, locale: 'en' })
        check(!Object.hasOwn(translated, 'body'), 'Untouched body fallback was saved as an empty translation')
        check(callbacks.at(-1) === true, 'Other-locale unsaved edits were omitted from the callback')
        locale.value = 'ja'
        await until(() => values.value.data.title === 'Keep later browser edit')
        checks.push('sparse translated body and cross-locale unsaved edits')
        const otherId = crypto.randomUUID()
        await manage({
            action: 'save',
            model: 'posts',
            id: otherId,
            locale: 'ja',
            ifDigest: null,
            data: { title: 'Other entry', slug: otherId, tags: [] },
        })
        selected.value = otherId
        await until(() => values.value.data.title === 'Other entry')
        check(!hasUnsavedChanges.value, 'Another entry inherited the unsaved-change flag')
        selected.value = id
        await until(() => values.value.data.title === 'Keep later browser edit')
        slowId.value = `slow-${id}`
        await until(() => timed.status.value === 'error')
        check(timed.error.value, 'Timeout must retain its error')
        canceledId.value = `slow-${id}`
        cancelController.abort(new DOMException('Explicit probe cancellation', 'AbortError'))
        await until(() => canceled.status.value === 'error')
        check(canceled.error.value, 'Cancellation must retain its error')
        raceId.value = `slow-${id}`
        await pause(30)
        raceId.value = id
        await until(() => race.data.value?.id === id)
        await pause(350)
        check(race.data.value?.id === id, 'A slow old query overwrote the current result')
        checks.push('query timeout, cancellation and reactive request race')
        await session.signOut()
        await session.refresh()
        await until(() => values.value.data.title !== 'Keep later browser edit')
        await signUp()
        await until(() => resource.status.value === 'success' && values.value.data.title === 'Recovered browser')
        check(!hasUnsavedChanges.value, 'Another actor inherited the prior actor draft')
        checks.push('authentication change clears the prior actor draft')
        ;(window as unknown as { __litiProbe: object }).__litiProbe = { done: true, success: true, checks }
    } catch (error) {
        ;(window as unknown as { __litiProbe: object }).__litiProbe = {
            done: true,
            success: false,
            checks,
            error: error instanceof Error ? error.stack : String(error),
        }
    }
})
</script>
<template><main>Browser contract probe</main></template>
