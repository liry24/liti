import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { litiNuxtClientTemplate, litiNuxtModelTypes } from '../packages/nuxt/src/nuxt/client-templates'

it('infers high-level form, management list, field and successful save types from model names', async () => {
    await mkdir('.tmp', { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/management-types-'))
    await writeFile(
        join(directory, 'client.ts'),
        litiNuxtClientTemplate({ basePath: '/content', managementBase: '/manage', auth: true }),
    )
    await writeFile(join(directory, 'models.d.ts'), litiNuxtModelTypes(join(directory, 'config.ts')))
    await writeFile(
        join(directory, 'config.ts'),
        `import { array, defineLitiConfig, file, image, images, markdown, object, text } from 'liti'
import { Output } from 'ai'
import { z } from 'zod'
export default defineLitiConfig({ models: {
  posts: { fields: { title: text({ required: true }), copy: markdown({ required: true }), image: image(), gallery: images(), sections: array(object({ attachment: file() })) } },
  authors: { fields: { name: text({ required: true }) } },
}, ai: { actions: {
  publication: { type: 'text-generation', input: z.object({ mode: z.enum(['automatic', 'manual']) }), prompt: ({ mode }) => mode, output: Output.object({ schema: z.object({ data: z.object({ title: z.string().optional(), copy: z.string().optional() }), slug: z.string().optional() }) }) },
  correct: { type: 'text-generation', input: z.object({ content: z.string(), fields: z.array(z.enum(['copy'])) }), prompt: ({ content }) => content, output: Output.object({ schema: z.object({ data: z.object({ copy: z.string() }) }) }) },
  plain: { type: 'text-generation', input: z.object({}), prompt: () => 'Plain' },
} } })
`,
    )
    await writeFile(
        join(directory, 'imports.d.ts'),
        `interface ImportMeta { server: boolean }
declare module '#imports' {
  export const useRoute: () => { path: string }
  export const useRequestURL: () => URL
  export const useRequestFetch: () => (url: string, options: { [name: string]: unknown; onResponse?: (context: { response: Response }) => void }) => Promise<unknown>
  export const useState: <Value>(key: string, value: () => Value) => import('vue').Ref<Value>
  export const useUserSession: () => { user: import('vue').Ref<{ id: string; role?: string } | null>; session: import('vue').Ref<{ id: string } | null> }
  export const useNuxtApp: () => { payload: { data: Record<string, unknown> }; callHook: (...args: unknown[]) => Promise<void>; runWithContext: <Value>(callback: () => Value) => Value; hook: (event: string, callback: (keys?: string[]) => Promise<void>) => () => void }
  export { clearNuxtData, refreshNuxtData, useNuxtData } from '#app/composables/asyncData'
}
`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `import { ref } from 'vue'
import { useLitiQuery, useLitiForm } from './client'
const id = ref<string | null>('post')
const post = await useLitiQuery('posts', { mode: 'one', view: 'current', id })
const immediate = useLitiForm('posts', { instance: ref('one') })
const immediateTitle: string = immediate.form.state.values.title
immediate.upload('sections[0].attachment', new File(['x'], 'x.txt'))
// @ts-expect-error Unknown nested field.
immediate.upload('sections[0].missing', new File(['x'], 'x.txt'))
void immediateTitle
const { form } = await useLitiForm('posts', { id, onSuccess: (saved) => {
    const version: number = saved.version
    if ('data' in saved) { const title: string = saved.data.title; const url: string | undefined = saved.data.image?.url; void [title, url] }
    void version
} })
const title: string = form.state.values.title
const copy: string = form.state.values.copy
const assetUrl: string | undefined = form.state.values.image?.url
form.setFieldValue('title', 'Typed')
form.setFieldValue('image', { id: 'asset', url: '/manage/assets/asset/content' })
// @ts-expect-error Unknown model.
useLitiQuery('missing', { view: 'current' })
const projected = useLitiQuery('posts', { view: 'current', transform: (rows) => rows.map((row) => row.data.title) })
const projectedTitles: string[] = projected.data.value
// @ts-expect-error Current queries cannot select published paths.
useLitiQuery('posts', { view: 'current', mode: 'one', path: '/posts/one' })
// @ts-expect-error Fields retain their schema types.
form.setFieldValue('title', 12)
// @ts-expect-error Unknown field.
form.setFieldValue('missing', '')
// @ts-expect-error Optional assets require presentation URLs.
form.setFieldValue('image', { id: 'asset' })
// @ts-expect-error No second AI execution engine lives in a form.
form.ai.run('correct', {})
const page = ref({ limit: 20, offset: 20 })
const list = await useLitiQuery('posts', { view: 'current', page })
const first: string | undefined = list.data.value[0]?.data.title
const size: number = list.data.value.length
const one: string | undefined = post.data.value?.data.title
const { form: author } = await useLitiForm('authors')
const name: string = author.state.values.name
void [title, copy, assetUrl, first, size, projectedTitles, one, name]

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
                    'liti/internal/form': [resolve('packages/vue/src/form.ts')],
                    'liti/internal/model': [resolve('packages/vue/src/model.ts')],
                    '#build/liti/client': [join(directory, 'client.ts')],
                    '#app/*': [resolve('node_modules/nuxt/dist/app/*')],
                    '#app': [resolve('node_modules/nuxt/dist/app/index.d.ts')],
                    '#app/composables/asyncData': [resolve('node_modules/nuxt/dist/app/composables/asyncData.d.ts')],
                },
            },
            include: ['./*.ts'],
        }),
    )
    const result = await promisify(execFile)(process.execPath, [
        resolve('node_modules/typescript/bin/tsc'),
        '--noEmit',
        '-p',
        join(directory, 'tsconfig.json'),
    ]).catch((error: { stdout?: string; stderr?: string }) => {
        throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    })
    expect(result.stdout).toBe('')
})
