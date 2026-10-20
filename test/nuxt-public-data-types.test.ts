import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

import { litiNuxtClientTemplate } from '../packages/nuxt/src/nuxt/client-templates'

it('preserves model-specific public data and native AsyncData options/transform/pick/default inference', async () => {
    await mkdir('.tmp', { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/public-data-types-'))
    await writeFile(
        join(directory, 'client.ts'),
        litiNuxtClientTemplate({ basePath: '/content', managementBase: '/manage', i18n: true }),
    )
    await writeFile(
        join(directory, 'imports.d.ts'),
        `interface ImportMeta { server: boolean }
declare module '#imports' {
  export const useRoute: () => { path: string }
  export const useRequestURL: () => URL
  export const useRequestFetch: () => (url: string, options: { [name: string]: unknown; onResponse?: (context: { response: Response }) => void }) => Promise<unknown>
  export const useState: <Value>(key: string, value: () => Value) => import('vue').Ref<Value>
  export { clearNuxtData, refreshNuxtData, useNuxtData } from '#app/composables/asyncData'
  export const useNuxtApp: () => { payload: { data: Record<string, unknown> }; callHook: (...args: unknown[]) => Promise<void>; $i18n?: { locale: import('vue').Ref<string> }; runWithContext: <Value>(callback: () => Value) => Value }
}
`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `import { computed, ref } from 'vue'
import { array, datetime, defineLitiConfig, image, images, markdown, relation, text, textarea, url, type InferLitiPublicModels } from 'liti'
import type { AsyncData } from '#app/composables/asyncData'
import type { NuxtError } from '#app'
import { useLitiQuery } from './client'
const config = defineLitiConfig({ models: {
  arts: { fields: { title: text({ required: true }), description: textarea(), href: url(), images: images({ required: true }), createdAt: datetime() } },
  socials: { fields: { href: url({ required: true }), icon: text({ required: true }), label: text({ required: true }) } },
  careers: { fields: { period: text({ required: true }), position: text({ required: true }), company: text({ required: true }) } },
  ranks: { fields: { game: text({ required: true }), season: text(), rank: text({ required: true }), image: image({ required: true }), href: url() } },
  posts: { fields: { title: text({ required: true }), excerpt: textarea(), content: markdown({ required: true }), tags: array(text(), { required: true, default: [] }), image: image(), author: relation('authors'), authorUserId: text(), createdAt: datetime() } },
  authors: { fields: { bio: markdown({ required: true }) } },
  private: { fields: { secret: text() }, public: false },
} })
declare module 'liti/client' {
  interface LitiClientRegistry { publicModels: InferLitiPublicModels<typeof config>; publicSummaryModels: InferLitiPublicModels<typeof config, 'summary'> }
}
const slug = ref('slug')
const locale = ref('ja')
const entry = useLitiQuery('posts', { mode: 'one', id: slug })
const awaitable: AsyncData<InferLitiPublicModels<typeof config>['posts'] | null | undefined, NuxtError | undefined> = entry
const title: string | undefined = entry.data.value?.data.title
const nodes: import('comark').Node[] | undefined = entry.data.value?.data.content.nodes
const summary: import('comark').Node[] | undefined = entry.data.value?.data.content.meta.summary
// @ts-expect-error Native summary is optional AST, never an excerpt string.
const invalidSummary: string | undefined = entry.data.value?.data.content.meta.summary
const transformed = useLitiQuery('posts', { mode: 'one', id: () => slug.value,
  transform: (entry) => ({ title: entry?.data.title ?? '' }), default: () => ({ title: '' }),
  locale: computed(() => locale.value), lazy: true, server: false, immediate: false,
  watch: [slug], deep: true, dedupe: 'defer', timeout: 500, enabled: ref(true),
  getCachedData: () => undefined, serialize: false, middleware: [(next) => next()],
 })
const transformedTitle: string = transformed.data.value.title
const titles = useLitiQuery('posts', { transform: (items) => items.map((entry) => entry.data.title), default: () => [] })
const titleList: string[] = titles.data.value
const summaryList = useLitiQuery('posts', { markdown: 'summary' })
const summaryNodes: import('comark').Node[] | undefined = summaryList.data.value?.[0]?.data.content.nodes
// @ts-expect-error Summary rendering documents do not expose arbitrary plugin metadata.
summaryList.data.value?.[0]?.data.content.meta.rawSource
// @ts-expect-error Summary rendering documents do not expose Markdown source.
summaryList.data.value?.[0]?.data.content.source
const summaryTitles = useLitiQuery('posts', { markdown: 'summary', transform: (items) => items.map((entry) => entry.data.title), default: () => [] })
const summaryTitleList: string[] = summaryTitles.data.value
useLitiQuery('posts', { mode: 'one', id: 'slug',  markdown: 'summary'  })
// @ts-expect-error Unknown projection modes are rejected.
useLitiQuery('posts', { markdown: 'excerpt' })
const picked = useLitiQuery('posts', { mode: 'one', id: 'slug',  pick: ['data']  })
const pickedTitle: string | undefined = picked.data.value?.data.title
// @ts-expect-error Native pick removes the top-level slug.
picked.data.value?.slug
const defaulted = useLitiQuery('posts', { mode: 'one', id: 'slug',  default: () => null  })
const defaultTitle: string | undefined = defaulted.data.value?.data.title
const asyncTransform = useLitiQuery('posts', { transform: async (items) => ({ count: items.length }), default: () => ({ count: 0 }) })
const count: number = asyncTransform.data.value.count
// @ts-expect-error Unknown model names fail through the generated registry.
useLitiQuery('missing', { mode: 'one', id: 'slug' })
// @ts-expect-error Private models have no public HTTP projection.
useLitiQuery('private')
// @ts-expect-error Native options retain their real value types.
useLitiQuery('posts', { dedupe: 'invalid' })
// @ts-expect-error There is no second cache/key/selection framework.
useLitiQuery('posts', { mode: 'one', id: 'slug',  key: 'custom'  })
// @ts-expect-error Public Markdown is a Comark document.
const invalidBody: string | undefined = entry.data.value?.data.content
entry.refresh({ dedupe: 'cancel' })
entry.execute({ signal: new AbortController().signal })
entry.clear()
const paged = useLitiQuery('posts', { mode: 'many', pageSize: 20, markdown: 'summary' })
const relationSummary: import('liti').LitiMarkdownSummary | undefined = paged.data.value[0]?.data.author?.data.bio
const arts = useLitiQuery('arts')
const artUrl: string | undefined = arts.data.value[0]?.data.images[0]?.url
// @ts-expect-error Mode is not inferred from selectors.
useLitiQuery('posts', { id: slug })
// @ts-expect-error One requires exactly one selector.
useLitiQuery('posts', { mode: 'one' })
// @ts-expect-error A one query has no page size.
useLitiQuery('posts', { mode: 'one', id: slug, pageSize: 1 })
void [relationSummary, artUrl]
const status: string = entry.status.value
const error: NuxtError | undefined = entry.error.value
void [awaitable, title, nodes, summary, invalidSummary, transformedTitle, titleList, pickedTitle, defaultTitle, count, invalidBody, status, error]
`,
    )
    await writeFile(
        join(directory, 'tsconfig.json'),
        JSON.stringify({
            extends: resolve('tsconfig.json'),
            compilerOptions: {
                paths: {
                    liti: [resolve('packages/liti/src/index.ts')],
                    'liti/client': [resolve('packages/liti/src/public-client.ts')],
                    'liti/internal/*': [resolve('packages/liti/src/*')],
                    'liti/internal/runtime/*': [resolve('packages/nuxt/src/runtime/*')],
                    'liti/internal/client': [resolve('packages/liti/src/client.ts')],
                    '#app/*': [resolve('node_modules/nuxt/dist/app/*')],
                    '#app': [resolve('node_modules/nuxt/dist/app/index.d.ts')],
                    '#app/composables/asyncData': [resolve('node_modules/nuxt/dist/app/composables/asyncData.d.ts')],
                    vue: [resolve('node_modules/vue/dist/vue.d.ts')],
                },
            },
            include: ['./*.ts'],
        }),
    )
    const run = promisify(execFile)
    const result = await run(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '-p',
        join(directory, 'tsconfig.json'),
    ]).catch((error: { stdout?: string; stderr?: string }) => {
        throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    })
    expect(result.stdout).toBe('')
})
