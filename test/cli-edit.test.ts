import { describe, expect, it } from 'vitest'
import { editNuxt, editPlugin } from '../packages/cli/src/edit'
import type { LitiPluginManifest } from '../packages/liti/src/plugins'

const manifest: LitiPluginManifest = {
    id: 'blog',
    apiVersion: 1,
    liti: '^0.1.0',
    factory: 'blog',
    config: '@litijs/blog',
    options: { models: { posts: {} } },
}
const edit = (source: string, action: 'add' | 'remove') =>
    editPlugin(source, 'liti.config.ts', '@litijs/blog', manifest, action)

describe('CLI config edits', () => {
    it('preserves aliases, options, comments, satisfies and CRLF across idempotent add/remove', () => {
        const original = [
            'import { defineLitiConfig as config } from "liti"',
            'import { blog as articles, createProofreader } from "@litijs/blog"',
            '// keep this comment',
            'const settings = config({',
            '  plugins: [articles({ models: { news: { route: "/news/:slug" } } }) /* comma, comment */,],',
            '  models: {}, // unchanged',
            '} satisfies Options)',
            'export default settings',
            'export const proofread = createProofreader()',
            '',
        ].join('\r\n')
        expect(edit(original, 'add').source).toBe(original)
        const removed = edit(original, 'remove')
        expect(removed.source).toContain('createProofreader')
        expect(removed.source).not.toContain('blog as articles')
        expect(removed.source).toContain('/* comma, comment */')
        expect(removed.source).toContain('models: {}, // unchanged')
        expect(removed.source.replaceAll('\r\n', '')).not.toContain('\n')
        expect(removed.keepPackage).toBe(true)
        expect(edit(removed.source, 'remove').source).toBe(removed.source)
        const added = edit(removed.source, 'add').source
        expect(edit(added, 'add').source).toBe(added)
        expect(added).toContain('from "@litijs/blog"')
        expect(added).toContain('satisfies Options')
    })

    it('uses an unused binding and retains environment-specific imports and package references', () => {
        const input = `import { defineLitiConfig } from 'liti'
const blog = 'application value'
export default defineLitiConfig({ models: {} })
`
        const added = edit(input, 'add').source
        expect(added).toContain('blog as blog2')
        expect(added).toContain('plugins: [blog2(')
        expect(edit(added, 'remove').keepPackage).toBe(false)
        const environment = `import { blog } from '@litijs/blog'
export default { plugins: [blog({ models: { posts: {} } })], $production: { plugins: [blog({ models: { news: {} } })] } }`
        const removed = edit(environment, 'remove')
        expect(removed.keepPackage).toBe(true)
        expect(removed.source).toContain('import { blog }')
        expect(removed.source).toContain('$production: { plugins: [blog(')
    })

    it.each([
        'export { default } from "./other"',
        'export default makeConfig()',
        'export default { ...shared }',
        'export default { plugins: shared }',
        'export default { plugins: [...shared] }',
        'export default { [key]: [] }',
    ])('refuses an uncertain edit and supplies a concrete manual change: %s', (source) => {
        expect(() => edit(source, 'add')).toThrow('No configuration was changed')
        expect(() => edit(source, 'add')).toThrow('plugins: [blog(')
    })

    it('only adds the requested Nuxt module and preserves existing module options', () => {
        const source = `export default defineNuxtConfig({ modules: ['existing'], compatibilityDate: '2026-10-20' })`
        const result = editNuxt(source)
        expect(result).toContain("modules: ['existing', 'liti/nuxt']")
        expect(result).toContain("compatibilityDate: '2026-10-20'")
        expect(editNuxt(result)).toBe(result)
        expect(() => editNuxt('export default defineNuxtConfig({ modules: getModules() })')).toThrow('manually')
        const tuple = `export default defineNuxtConfig({ modules: [['existing', { option: true }]] })`
        expect(editNuxt(tuple)).toContain("['existing', { option: true }]")
        expect(editNuxt(`export default defineNuxtConfig({ modules: [['liti/nuxt', { debug: true }]] })`)).toContain(
            '{ debug: true }',
        )
    })
})
