import { expect, it } from 'vite-plus/test'
import { reconcile, snapshot } from '../packages/liti/src/runtime/composables/reconcile'

it('retains in-flight nested edits and deletion while accepting unrelated canonical values', () => {
    const submitted = { title: ' Before ', tags: ['one'], removed: 'value', nested: { label: 'before' } }
    const edited = { title: 'After', tags: ['one'], nested: { label: 'edited' }, added: 'new' }
    const saved = { title: 'Before', tags: ['canonical'], removed: 'value', nested: { label: 'before' } }
    expect(reconcile<Record<string, unknown>>(submitted, edited, saved)).toEqual({
        title: 'After',
        tags: ['canonical'],
        nested: { label: 'edited' },
        added: 'new',
    })
    expect(snapshot({ b: 1, a: 2 })).toBe(snapshot({ a: 2, b: 1 }))
})
