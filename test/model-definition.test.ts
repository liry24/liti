import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
    defineContentModel,
    defineRecordModel,
    field,
    describeModel,
    validateData,
    resolveTranslation,
    documentId,
    referenceValues,
    assertJson,
    normalizeModelUrl,
} from '../packages/model/src/index'

const fields = {
    title: field(z.string().min(1), { localized: true }),
    count: field(z.number().int().min(0)),
    note: field(z.string().optional()),
    secret: field(z.string(), { public: false }),
}
const policy = () => true
describe('ViteHub model definitions', () => {
    it('derives validation and a public descriptor from one field definition', async () => {
        const model = defineContentModel({
            name: 'posts',
            fields,
            locales: { default: 'ja', supported: ['ja', 'en'] },
            authorize: policy,
        })
        expect(await validateData(model.fields, { title: 'Title', count: 2, secret: 'hidden' })).toEqual({
            title: 'Title',
            count: 2,
            secret: 'hidden',
        })
        expect(describeModel(model).fields.secret).toBeUndefined()
        expect(describeModel(model, 'management').fields.secret).toBeDefined()
        await expect(
            validateData(model.fields, { title: '', count: -1, secret: 'hidden', unknown: true }),
        ).rejects.toMatchObject({
            code: 'LITI_INVALID_INPUT',
            issues: expect.arrayContaining([
                expect.objectContaining({ path: ['count'] }),
                expect.objectContaining({ path: ['unknown'] }),
            ]),
        })
    })
    it('keeps sparse translation absence distinct from null and explicit empty values', async () => {
        const model = defineContentModel({
            name: 'posts',
            fields,
            locales: { default: 'ja', supported: ['ja', 'en'] },
            authorize: policy,
        })
        expect(await validateData(fields, {}, { sparse: true, localizedOnly: true })).toEqual({})
        await expect(validateData(fields, { count: 42 }, { sparse: true, localizedOnly: true })).rejects.toMatchObject({
            code: 'LITI_INVALID_INPUT',
        })
        expect(resolveTranslation(model, { title: 'Original', count: 1 }, {}, true)).toEqual({
            title: 'Original',
            count: 1,
        })
        expect(resolveTranslation(model, { title: 'Original', count: 1 }, { title: '' }, true)).toEqual({
            title: '',
            count: 1,
        })
        expect(resolveTranslation(model, { title: 'Original', count: 1 }, {}, false)).toEqual({ count: 1 })
    })
    it('keeps identity separate from any slug and rejects traversal', () => {
        const model = defineContentModel({ name: 'posts', fields: { title: field(z.string()) }, authorize: policy })
        expect(documentId(model, 'stable-id')).toBe('stable-id/und')
        expect(() => documentId(model, '../published')).toThrow('Invalid stable entry ID')
        expect(() => documentId(model, 'id', 'en')).toThrow('Unsupported model locale')
    })
    it('canonicalizes Japanese public paths and rejects alternate origins and URL query syntax', () => {
        expect(normalizeModelUrl('/ja/posts/日本語')).toBe('/ja/posts/%E6%97%A5%E6%9C%AC%E8%AA%9E')
        expect(normalizeModelUrl('/ja/../posts/title')).toBe('/posts/title')
        expect(normalizeModelUrl('/posts/%61')).toBe('/posts/a')
        for (const value of [
            '//example.com/path',
            '/\\example.com/path',
            '/path?q=1',
            '/path#fragment',
            'https://example.com/',
            '/posts/a%2fb',
            '/posts/%zz',
        ])
            expect(() => normalizeModelUrl(value)).toThrow()
    })
    it('rejects unsupported definitions before the persistence boundary', () => {
        expect(() => defineContentModel({ name: 'posts', fields, authorize: policy })).toThrow(
            'Localized fields require',
        )
        expect(() => defineRecordModel({ name: 'games', fields, authorize: policy })).toThrow('Translated entries')
        expect(() =>
            defineRecordModel({
                name: 'games',
                fields: { slug: field(z.string()) },
                // @ts-expect-error Exercise invalid runtime configuration in addition to the compile-time constraint.
                unique: [['missing']],
                authorize: policy,
            }),
        ).toThrow('Invalid unique tuple')
        expect(() =>
            defineContentModel({ name: 'posts', fields: { body: field(z.string()) }, authorize: policy }),
        ).toThrow('Reserved')
        expect(() =>
            defineContentModel({
                name: 'posts',
                fields: { title: field(z.string()) },
                locales: { default: 'ja', supported: ['en'] },
                authorize: policy,
            }),
        ).toThrow('Invalid model locales')
    })
    it('extracts nested references without treating unrelated strings as IDs', () => {
        expect(
            referenceValues({ mentions: [{ game: 'one', label: 'text' }, { game: 'two' }] }, 'mentions.*.game'),
        ).toEqual(['one', 'two'])
        expect(referenceValues({ mentions: [] }, 'mentions.*.game')).toEqual([])
        expect(() => referenceValues({ game: 42 }, 'game')).toThrow('stable IDs')
    })
    it('refuses non-JSON values returned by validators', async () => {
        await expect(validateData({ date: field(z.date()) }, { date: new Date() })).rejects.toMatchObject({
            code: 'LITI_INVALID_INPUT',
        })
        expect(() => assertJson({ value: Infinity })).toThrow('finite JSON')
        expect(() => assertJson(JSON.parse('{"__proto__":{"admin":true}}'))).toThrow('Unsafe object key')
    })
    it('allows canonical defaults but refuses repeated transformations that would change stored content', async () => {
        expect(
            await validateData(
                { title: field(z.string().trim()), tags: field(z.array(z.string()).default([])) },
                { title: ' Canonical ' },
            ),
        ).toEqual({ title: 'Canonical', tags: [] })
        await expect(
            validateData({ title: field(z.string().transform((value) => value + '!')) }, { title: 'Text' }),
        ).rejects.toMatchObject({ code: 'LITI_INVALID_MODEL' })
    })
})
