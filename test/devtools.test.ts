import { expect, it } from 'vitest'
import type { RequestEvent } from 'nuxt/server'
import { createDatabase } from 'db0'
import nodeSqlite from 'db0/connectors/node-sqlite'
import { defineLitiConfig, text } from '../packages/liti/src'
import snapshot from '../packages/nuxt/src/runtime/devtools-snapshot'
import { configureLitiRuntime } from '../packages/nuxt/src/nuxt/server'
import { createRuntime } from '../packages/liti/src/server'
import { createMigratedTestAdmin, testAdapter } from './migrate'

it('protects runtime diagnostics and never returns content bodies or field defaults', async () => {
    const database = createDatabase(nodeSqlite({ name: ':memory:' }))
    try {
        const liti = await createMigratedTestAdmin({
            database,
            config: defineLitiConfig({
                models: { posts: { fields: { slug: text(), title: text({ default: 'SECRET_DEFAULT' }) } } },
            }),
            authorize: (request) => {
                const role = request.headers.get('authorization')
                return role ? { id: 'test', roles: [role] } : null
            },
        })
        await liti.createEntry('posts', { data: { slug: 'secret-content-body', title: 'SECRET_CONTENT_BODY' } })
        configureLitiRuntime({
            getLiti: () => liti,
            publicBase: '/api/content',
            managementBase: '/api/liti',
            development: { connector: 'sqlite', devDatabase: true },
        })
        const fetch = (req: Request) =>
            snapshot({
                req,
                url: new URL(req.url),
                res: { headers: new Headers() },
                context: {},
            } satisfies RequestEvent)
        expect((await fetch(new Request('http://localhost/snapshot'))).status).toBe(401)
        expect(
            (await fetch(new Request('http://localhost/snapshot', { headers: { authorization: 'user' } }))).status,
        ).toBe(403)
        const response = await fetch(new Request('http://localhost/snapshot', { headers: { authorization: 'admin' } }))
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        const source = await response.text()
        expect(source).not.toContain('SECRET_')
        const result = JSON.parse(source)
        expect(result.database).toMatchObject({ connector: 'sqlite', schemaReady: true, devDatabase: true })
        expect(result.revisions).toHaveLength(1)
        expect(result.models.posts.fields.title).toEqual({ kind: 'text', required: false })
        await database.exec('DROP TABLE liti_content_posts')
        configureLitiRuntime({
            publicBase: '/api/content',
            managementBase: '/api/liti',
            getLiti: async () =>
                createRuntime({
                    database: await testAdapter(database, liti.config),
                    config: liti.config,
                    authorize: () => ({ id: 'admin', roles: ['admin'] }),
                }),
        })
        const missing = await fetch(new Request('http://localhost/snapshot'))
        expect(missing.status).toBe(200)
        expect(await missing.json()).toMatchObject({
            database: { schemaReady: false },
            diagnostics: [{ code: 'LITI_MIGRATION_REQUIRED' }],
        })
    } finally {
        await database.dispose()
    }
})
