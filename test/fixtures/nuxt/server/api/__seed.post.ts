import { useLitiRuntime } from 'liti/internal/nuxt/server'
import { withLitiContext } from 'liti/internal/runtime/context'
import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler((event) =>
    withLitiContext(event.context, async () => {
        const admin = await useLitiRuntime().getLiti(event)
        if ((await admin.listEntries('posts')).length === 0) {
            const en = await admin.createEntry('posts', {
                data: {
                    slug: 'hello',
                    description: 'English description',
                    title: 'Hello',
                    body: '---\nprivate: FULL_SSR_FRONTMATTER\n---\nNative summary\n\n<!-- more -->\n\nFULL_SSR_BODY_SENTINEL',
                },
                defaultLocale: 'en',
                translations: { ja: { slug: 'こんにちは', description: '日本語の説明', title: 'こんにちは' } },
            })
            await admin.publishEntry(en.id, { expectedVersion: en.version })
            await admin.createEntry('links', {
                data: { slug: 'external', destination: 'https://example.com/destination', title: 'External' },
            })
        }
        return { seeded: true }
    }),
)
