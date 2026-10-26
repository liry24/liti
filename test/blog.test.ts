import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase, type Database } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineLitiConfig, resolveLitiConfig as resolveConfig, text, type LitiConfigInput } from '../packages/liti/src'
import { blog, createProofreader, validateProofreading } from '../packages/blog/src'
import { ai, type AiProvider } from '../packages/ai/src'
import { createSlugGenerator } from '../packages/ai/src/slug'
import { createManagementOperations } from '../packages/liti/src/server/operations'
import { createMigratedTestAdmin } from './migrate'
import { handlePublicRequest } from '../packages/liti/src/server'

const databases: Database[] = []
const resolveLitiConfig = <const Config extends LitiConfigInput>(config: Config) => resolveConfig(config, [])
afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.dispose()))
})
const database = () => {
    const db = createDatabase(nodeSqlite({ name: ':memory:' }))
    databases.push(db)
    return db
}
const draft = { title: 'Article', content: 'Intro.\n\n<!-- more -->\n\nBody.', tags: [] }

it('runs manual articles without AI and shares dates across detail, list, summary, batch and routes', async () => {
    const config = resolveLitiConfig(
        defineLitiConfig({
            plugins: [
                blog({
                    models: {
                        posts: {
                            mapping: { cover: 'image' },
                            fields: { authorUserId: text() },
                            slug: { mode: 'manual' },
                        },
                    },
                }),
            ],
        }),
    )
    expect(config.models.posts.fields).toHaveProperty('image')
    expect(config.models.posts.fields).not.toHaveProperty('cover')
    const admin = await createMigratedTestAdmin({
        database: database(),
        config,
        now: () => new Date('2026-02-01T00:00:00Z'),
    })
    let entry = await admin.createEntry('posts', {
        data: { ...draft, authoredAt: '2025-12-01T00:00:00Z', authorUserId: 'owner' },
    })
    expect(entry.data.slug).toBe('')
    await expect(admin.publishEntry(entry.id, { expectedVersion: entry.version })).rejects.toMatchObject({
        issues: [{ path: 'slug' }],
    })
    entry = await admin.publishEntry(entry.id, { expectedVersion: entry.version, draft: { data: { slug: 'article' } } })
    expect(entry.data.authorUserId).toBe('owner')
    const published = await admin.getPublicEntry('posts', entry.id)
    expect(published?.meta?.blog).toEqual({
        date: '2025-12-01T00:00:00Z',
        authoredAt: '2025-12-01T00:00:00Z',
        firstPublishedAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
    })
    expect(published?.seo).toMatchObject({
        type: 'article',
        articlePublishedTime: '2025-12-01T00:00:00Z',
        articleModifiedTime: '2026-02-01T00:00:00.000Z',
    })
    const list = await admin.listPublicEntries('posts')
    expect(list[0]?.meta).toEqual(published?.meta)
    const route = await admin.resolvePath('/posts/article')
    expect(route?.kind === 'page' && route.entry.meta).toEqual(published?.meta)
    const content = await admin.content('posts')
    const file = (await content.list())[0]!
    expect(file.data._liti).toMatchObject({ meta: published?.meta, seo: published?.seo })
    const response = await handlePublicRequest(
        admin,
        new Request('https://site.test/api/content/posts?markdown=summary'),
        '/api/content',
    )
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).toContain('"articlePublishedTime":"2025-12-01T00:00:00Z"')
})

it('generates a candidate only on explicit publication and avoids an occupied URL', async () => {
    const generate = vi.fn(() => ({ slug: 'generated' }))
    const config = resolveLitiConfig(
        defineLitiConfig({ plugins: [blog({ models: { posts: { slug: { mode: 'auto', generate } } } })] }),
    )
    const admin = await createMigratedTestAdmin({ database: database(), config })
    const blocker = await admin.createEntry('posts', { data: { ...draft, slug: 'generated' } })
    await admin.publishEntry(blocker.id, { expectedVersion: blocker.version })
    const entry = await admin.createEntry('posts', { data: draft })
    expect(generate).not.toHaveBeenCalled()
    const request = { expectedVersion: entry.version, draft: { data: draft } }
    const result = await admin.publishEntry(entry.id, request)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.data.slug).toMatch(/^generated-[a-z0-9]{6}$/u)
    await expect(
        admin.publishEntry(entry.id, { expectedVersion: result.version, draft: { data: { slug: '' } } }),
    ).rejects.toMatchObject({ code: 'LITI_INVALID_INPUT' })
    expect(generate).toHaveBeenCalledTimes(1)
})

it('validates action contracts independently of plugin order and uses the common server action ACL', async () => {
    const generate = vi.fn((input: unknown) => input)
    const provider: AiProvider = {
        id: 'fixture',
        text: {
            async generate(request) {
                generate(request)
                const output = await request.output!['~standard'].validate({ slug: 'ai-slug' })
                if (output.issues) throw new Error('Invalid fixture output')
                return { data: output.value, metadata: {} }
            },
        },
    }
    const article = blog({ models: { posts: { proofreading: 'proofread', slug: { mode: 'auto', action: 'slug' } } } })
    const actions = ai({ provider, actions: { slug: createSlugGenerator(), proofread: createProofreader() } })
    for (const plugins of [
        [article, actions],
        [actions, article],
    ])
        expect(() => resolveLitiConfig(defineLitiConfig({ plugins }))).not.toThrow()
    expect(() => resolveLitiConfig(defineLitiConfig({ plugins: [article] }))).toThrow('requires action')
    const config = resolveLitiConfig(
        defineLitiConfig({
            plugins: [article, actions],
            authorization: { roles: { editor: { models: { posts: ['create', 'update', 'publish', 'readDraft'] } } } },
        }),
    )
    const admin = await createMigratedTestAdmin({ database: database(), config })
    const entry = await admin.createEntry('posts', { data: draft })
    const editor = createManagementOperations(() => admin, { actor: { id: 'editor', roles: ['editor'] } })
    await expect(
        editor.publishEntry(entry.id, { expectedVersion: entry.version, draft: { data: draft } }),
    ).rejects.toMatchObject({ code: 'LITI_FORBIDDEN' })
    expect(generate).not.toHaveBeenCalled()
    const api = createManagementOperations(() => admin, { actor: { id: 'admin', roles: ['admin'] } })
    await api.publishEntry(entry.id, { expectedVersion: entry.version, draft: { data: draft } })
    expect(generate).toHaveBeenCalledTimes(1)
    const submitted = generate.mock.calls[0]![0]
    expect(JSON.stringify(submitted)).not.toContain('authorUserId')
})

it('protects Markdown fragments in order, including duplicates, without requiring the AI package at runtime', async () => {
    const original =
        'A typo.\n\n`x` and [link](https://example.test/a).\n\n<!-- more -->\n\n```js\nconst x = 1\n```\n\n<div>Keep this</div>\n\nliti://asset/example'
    expect(await validateProofreading(original, original.replace('A typo.', 'A correction.'))).toBe(true)
    for (const [from, to] of [
        ['`x`', '`y`'],
        ['https://example.test/a', 'https://evil.test/a'],
        ['const x = 1', 'const x = 2'],
        ['<div>Keep this</div>', '<div>Changed</div>'],
        ['liti://asset/example', 'liti://asset/other'],
        ['\n\n<!-- more -->\n\n', '\n<!-- more -->\n'],
    ] as const)
        expect(await validateProofreading(original, original.replace(from, to))).toBe(false)
    expect(await validateProofreading('`a` then `b`', '`b` then `a`')).toBe(false)
    expect(await validateProofreading('`a` and `a`', '`a`')).toBe(false)
    expect(
        await validateProofreading('A <game:one>', 'B <game:two>', { protect: (s) => s.match(/<game:[^>]+>/gu) ?? [] }),
    ).toBe(false)
    const definition = createProofreader()
    expect(await definition.input['~standard'].validate({ content: 'Text', prompt: 'forged' })).toHaveProperty('issues')
    const output = definition.output({ content: original })
    expect(await output['~standard'].validate({ content: original.replace('`x`', '`y`') })).toHaveProperty('issues')
})

it.each([
    ['nested link target', '[link](/posts/a(foo).png)', '[link](/posts/a(foo).jpg)'],
    ['nested image target', '![image](/assets/a(foo).png)', '![image](/assets/a(foo).jpg)'],
    ['indented code', 'Example:\n\n    one()\n    next()', 'Example:\n\n    two()\n    next()'],
    ['multiline code span', 'Example `one()\nnext()`.', 'Example `two()\nnext()`.'],
    ['code span whitespace', 'Example `one()\nnext()`.', 'Example `one() next()`.'],
    ['multiple backticks', 'Example ``one(`x`)\nnext()``.', 'Example ``two(`x`)\nnext()``.'],
    ['long fence', '````js\none()\n```\nnext()\n````', '````js\ntwo()\n```\nnext()\n````'],
    ['reference target', '[link][a]\n\n[a]: /posts/a(foo).png', '[link][a]\n\n[a]: /posts/a(foo).jpg'],
    ['unused reference', '[unused]: /posts/a(foo).png', '[unused]: /posts/a(foo).jpg'],
    ['inline HTML link', 'Read <a href="/posts/original">link</a>.', 'Read <a href="/posts/changed">link</a>.'],
    ['HTML image', '<img src="/assets/original.png">', '<img src="/assets/changed.png">'],
    ['inline HTML image', 'See <img src="/assets/original.png"> here.', 'See <img src="/assets/changed.png"> here.'],
    ['multiline HTML link', 'Read <a\n href="/posts/original">link</a>.', 'Read <a\n href="/posts/changed">link</a>.'],
    [
        'HTML block destination',
        '<div>\n<a href="/posts/original">link</a>\n</div>',
        '<div>\n<a href="/posts/changed">link</a>\n</div>',
    ],
    [
        'other HTML attributes',
        'Read <a href="/posts/original" title="Original">link</a>.',
        'Read <a href="/posts/original" title="Changed">link</a>.',
    ],
    ['HTML block prose', '<div>\nThis are an example.\n</div>', '<div>\nThis is an example.\n</div>'],
])('preserves %s during proofreading', async (_name, original, changed) => {
    expect(await validateProofreading(original, original)).toBe(true)
    expect(await validateProofreading(original, changed)).toBe(false)
})
