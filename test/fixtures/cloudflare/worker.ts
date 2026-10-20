import { createFilesStorage } from '../../../packages/void/src/storage'
import type { AnyD1Database } from 'drizzle-orm/d1'
import { Files } from 'files-sdk'
import { r2 } from 'files-sdk/r2'
import { createD1Database } from '../../../packages/void/src/database'
// @ts-ignore Test setup generates this application schema before bundling.
import * as schema from './.data/schema/schema'

import { defineLitiConfig, file, text } from '../../../packages/liti/src/index'
import { queryRow, runAtomic } from '../../sqlite-queries'
import { createRuntime } from '../../../packages/liti/src/server/index'
import { searchProbe } from './search-probe'

interface Env {
    LITI_DB: AnyD1Database
    ASSETS: Extract<Parameters<typeof r2>[0], { binding: unknown }>['binding']
    DRAFT_ASSETS: Env['ASSETS']
}

const config = defineLitiConfig({
    assets: { storage: 'content' },
    models: {
        posts: {
            fields: { slug: text(), attachment: file(), title: text({ required: true }) },
            route: '/posts/:slug',
            sortable: true,
        },
    },
})

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            if (new URL(request.url).pathname === '/health') return new Response('OK')
            if (new URL(request.url).pathname.startsWith('/search-'))
                return await searchProbe(request, env.LITI_DB, schema)
            const database = createD1Database(env.LITI_DB, schema)
            if (new URL(request.url).pathname === '/missing-binding') {
                const missing = createD1Database(undefined as unknown as AnyD1Database, schema)
                await queryRow(missing, 'SELECT 1')
            }
            if (new URL(request.url).pathname === '/rollback') {
                const key = crypto.randomUUID()
                try {
                    await runAtomic(database, [
                        { params: [key, 'one'], sql: 'INSERT INTO liti_meta(key, value) VALUES (?, ?)' },
                        { params: [key, 'two'], sql: 'INSERT INTO liti_meta(key, value) VALUES (?, ?)' },
                    ])
                } catch {}
                return Response.json({
                    rolledBack: !(await queryRow(database, 'SELECT value FROM liti_meta WHERE key = ?', [key])),
                })
            }
            const files = new Files({ adapter: r2({ binding: env.ASSETS }) })
            if (new URL(request.url).pathname === '/alias') {
                const aliased = createRuntime({
                    config: { ...config, assets: { storage: 'content', separateDrafts: true } },
                    database,
                    getStorage: createFilesStorage(async () => new Files({ adapter: r2({ binding: env.ASSETS }) })),
                })
                try {
                    await aliased.initialize()
                } catch (error) {
                    return Response.json({
                        rejected:
                            error instanceof Error && 'code' in error && error.code === 'LITI_STORAGE_UNAVAILABLE',
                    })
                }
                return Response.json({ rejected: false })
            }
            if (new URL(request.url).pathname === '/separation') {
                const draftFiles = new Files({ adapter: r2({ binding: env.DRAFT_ASSETS }) })
                const separated = createRuntime({
                    config: {
                        ...config,
                        assets: { storage: 'content', separateDrafts: true, cleanup: { minimumAge: 0 } },
                    },
                    database,
                    getStorage: createFilesStorage(async (name) => (name === 'draft' ? draftFiles : files)),
                })
                const asset = await separated.uploadAsset({
                    body: request.body!,
                    size: Number(request.headers.get('x-upload-size')),
                    filename: 'separated.bin',
                })
                let entry = await separated.createEntry('posts', {
                    data: { slug: 'separated', title: 'Separated', attachment: asset.id },
                })
                const privateBefore = await draftFiles.exists(asset.key)
                const publicBefore = (await files.list({ prefix: `liti/public/${asset.id}/` })).items.length
                entry = await separated.publishEntry(entry.id, { expectedVersion: entry.version })
                const publicAsset = await separated.downloadAsset(asset.id)
                const copiedBytes = (await new Response(publicAsset.file.body).arrayBuffer()).byteLength
                entry = await separated.unpublishEntry(entry.id, { expectedVersion: entry.version })
                const cleared = (await files.list({ prefix: `liti/public/${asset.id}/` })).items.length === 0
                const retained = await draftFiles.exists(asset.key)
                await separated.deleteEntry(entry.id, { expectedVersion: entry.version })
                const deleted = (await separated.runAssetGC()).deleted.includes(asset.id)
                return Response.json({ privateBefore, publicBefore, copiedBytes, cleared, retained, deleted })
            }
            const admin = createRuntime({ config, database, getStorage: createFilesStorage(async () => files) })
            if (new URL(request.url).pathname === '/upload') {
                const asset = await admin.uploadAsset({
                    body: request.body!,
                    size: Number(request.headers.get('x-upload-size')),
                    filename: 'stream.bin',
                })
                const stored = await files.download(asset.key)
                const size = (await stored.arrayBuffer()).byteLength
                await admin.deleteAsset(asset.id)
                return Response.json({ asset, size })
            }
            if (new URL(request.url).pathname === '/reorder') {
                const entries = await Promise.all(
                    ['sort-a', 'sort-b'].map((title) => admin.createEntry('posts', { data: { title, slug: title } })),
                )
                const published = await Promise.all(
                    entries.map((entry) => admin.publishEntry(entry.id, { expectedVersion: entry.version })),
                )
                const items = published.map((entry, sortOrder) => ({
                    id: entry.id,
                    sortOrder,
                    expectedVersion: entry.version,
                }))
                const before = await admin.publicGeneration()
                let conflict = false
                try {
                    await admin.setSortOrders('posts', [items[0]!, { ...items[1]!, expectedVersion: 999 }])
                } catch {
                    conflict = true
                }
                const unchanged =
                    (await admin.getEntry(items[0]!.id)).version === items[0]!.expectedVersion &&
                    (await admin.publicGeneration()) === before
                const sorted = await admin.setSortOrders('posts', items)
                return Response.json({
                    conflict,
                    unchanged,
                    sorted: sorted.map((entry) => entry.sortOrder),
                    generation: (await admin.publicGeneration()) - before,
                })
            }
            const draft = await admin.createEntry('posts', { data: { slug: 'd1', title: 'D1' } })
            const published = await admin.publishEntry(draft.id, { expectedVersion: draft.version })
            let conflict = false
            try {
                await admin.updateEntry(draft.id, {
                    data: { slug: draft.data.slug, title: 'stale' },
                    expectedVersion: draft.version,
                })
            } catch {
                conflict = true
            }
            return Response.json({ conflict, entries: await admin.listPublicEntries('posts'), published })
        } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : 'failed' }, { status: 500 })
        }
    },
}
