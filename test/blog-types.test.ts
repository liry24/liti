import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { litiNuxtClientTemplate, litiNuxtModelTypes } from '../packages/nuxt/src/nuxt/client-templates'

it('types immediate and awaited blog namespaces, mapped fields and public metadata only for blog models', async () => {
    await mkdir('.tmp', { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/blog-types-'))
    await writeFile(
        join(directory, 'client.ts'),
        litiNuxtClientTemplate({
            basePath: '/content',
            managementBase: '/manage',
            vue: ['@litijs/blog/vue'],
            editors: { posts: ['blog'], pages: ['blog'] },
        }),
    )
    await writeFile(
        join(directory, 'models.d.ts'),
        litiNuxtModelTypes(join(directory, 'config.ts'), [], ['@litijs/blog/vue']),
    )
    await writeFile(
        join(directory, 'config.ts'),
        `
import { defineLitiConfig, text } from 'liti'
import { blog } from '@litijs/blog'
export default defineLitiConfig({
    plugins: [blog({ models: { posts: {}, pages: { mapping: { content: 'body' }, fields: { extra: text() } } } })],
    models: { notes: { fields: { title: text() } } },
})
`,
    )
    await writeFile(
        join(directory, 'consumer.ts'),
        `
import { useLitiForm, useLitiQuery } from './client'
import { useLitiForm as useVueForm } from 'liti/vue'
const immediate = useLitiForm('posts')
const { blog: { review, proofread, applyProofreading, discardProofreading }, field, values, state } = immediate
const body: string = field('content').value
const title: string = values.value.title
const canApply: boolean = review.value.canApply
const status: 'idle' | 'pending' | 'success' | 'error' = review.value.status
const asynchronous = await useLitiForm('posts')
asynchronous.blog.proofread()
useVueForm('posts').blog.proofread()
const page = useLitiForm('pages')
const mappedBody: string = page.field('body').value
page.field('extra')
// @ts-expect-error The mapped field replaces the preset name.
page.field('content')
// @ts-expect-error Ordinary models have no blog namespace.
useLitiForm('notes').blog.proofread()
// @ts-expect-error Ordinary Vue models have no blog namespace.
useVueForm('notes').blog.proofread()
declare const name: 'posts' | 'notes'
// @ts-expect-error Branch on runtime model names before selecting a blog editor.
useLitiForm(name).blog
const published = useLitiQuery('posts')
const date: string | null | undefined = published.data.value[0]?.meta.blog.date
const summary = useLitiQuery('posts', { markdown: 'summary' })
const summaryDate: string | null | undefined = summary.data.value[0]?.meta.blog.date
void [body, title, canApply, status, mappedBody, date, summaryDate, state, proofread, applyProofreading, discardProofreading]
`,
    )
    const root = JSON.parse(await readFile('tsconfig.json', 'utf8'))
    const paths = Object.fromEntries(
        Object.entries(root.compilerOptions.paths as Record<string, string[]>).map(([key, values]) => [
            key,
            values.map((path) => resolve(path)),
        ]),
    )
    await writeFile(
        join(directory, 'tsconfig.json'),
        JSON.stringify({
            extends: resolve('tsconfig.json'),
            compilerOptions: {
                paths: {
                    ...paths,
                    'liti/client': [resolve('packages/liti/src/public-client.ts')],
                    'liti/internal/runtime/*': [resolve('packages/nuxt/src/runtime/*')],
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
