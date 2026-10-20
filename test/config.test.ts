import { createLitiDescriptor } from '../packages/liti/src/descriptor'
import { describe, expect, it } from 'vitest'
import { defineLitiConfig, text } from '../packages/liti/src'
import { resolveLitiConfig } from '../packages/liti/src/config-resolution'
import { resolveLitiAssets } from '../packages/void/src/assets-config'
import { Output } from 'ai'
import { z } from 'zod'
import { MockLanguageModelV4, Experimental_DecisionMockModelV4 } from 'ai/test'

describe('common liti configuration', () => {
    it('replaces opaque native AI models, output parsers and prop schemas in environment overrides', () => {
        const model = new MockLanguageModelV4()
        const decisionModel = new Experimental_DecisionMockModelV4()
        const output = Output.object({ schema: z.object({ content: z.string() }) })
        const schema = z.object({ content: z.string().min(3) })
        const config = defineLitiConfig({
            models: {},
            ai: {
                model: new MockLanguageModelV4(),
                decisionModel: new Experimental_DecisionMockModelV4(),
                actions: {
                    proofread: {
                        type: 'text-generation',
                        input: z.object({ content: z.string() }).strict(),
                        prompt: ({ content }) => content,
                        output: Output.text(),
                    },
                },
            },
            $production: {
                ai: { model, decisionModel, actions: { proofread: { output, input: schema } } },
            },
        })
        const resolved = resolveLitiConfig(config, ['production'])
        expect(resolved.ai.model).toBe(model)
        expect(resolved.ai.decisionModel).toBe(decisionModel)
        expect(resolved.ai.actions.proofread.output).toBe(output)
        expect(resolved.ai.actions.proofread.input).toBe(schema)
        expect(resolved.ai.actions.proofread.prompt({ content: 'Typed' })).toBe('Typed')
    })
    const action = () => 'server-only suggestion'
    const files = { storage: { content: { adapter: 'fs' as const, config: { root: './.data/files' } } } }
    const config = defineLitiConfig({
        assets: { maxUploadSize: 100 },
        ai: { actions: { suggest: { type: 'text-generation', input: z.object({}).strict(), prompt: action } } },
        models: { posts: { fields: { slug: text(), title: text({ required: true, default: 'base' }) } } },
        $development: { assets: { maxUploadSize: 200 } },
        $production: {
            assets: { maxUploadSize: 300 },
            models: { posts: { fields: { slug: text(), title: { default: 'production' } } } },
        },
        $test: { assets: { maxUploadSize: 400 } },
        $prerender: { assets: { maxUploadSize: 500 } },
        $env: { staging: { assets: { maxUploadSize: 600 } } },
    })

    it.each([
        [['development'], 200],
        [['production'], 300],
        [['test'], 400],
        [['production', 'prerender'], 500],
        [['production', 'staging'], 600],
    ] as const)('resolves the entire configuration for %j', (environments, maxUploadSize) => {
        const resolved = resolveLitiConfig(config, environments)
        expect(resolved.assets?.maxUploadSize).toBe(maxUploadSize)
        expect(resolved.ai?.actions?.suggest.prompt).toBe(action)
        expect(Object.keys(resolved).some((key) => key.startsWith('$'))).toBe(false)
    })

    it('merges model defaults using the same resolver instead of a separate config path', () => {
        const resolved = resolveLitiConfig(config, ['production'])
        expect(resolved.models.posts.fields.title.default).toBe('production')
        expect(resolved.models.posts.fields.title.required).toBe(true)
    })

    it('deep-merges direct and named domain overrides while replacing arrays and keeping functions', () => {
        const resolved = resolveLitiConfig(
            defineLitiConfig({
                models: {},
                assets: { maxUploadSize: 1 },
                $production: { assets: { maxUploadSize: 20 }, markdown: { plugins: [] } },
                $env: { production: { assets: { separateDrafts: true } } },
            }),
            ['production'],
        )
        expect(resolved.assets).toEqual({ maxUploadSize: 20, separateDrafts: true })
        expect(resolved.markdown?.plugins).toEqual([])
    })

    it('replaces complete SEO image descriptors across environment layers without mixing component props', () => {
        const base = { component: 'Development', props: { old: true }, options: { width: 800 } }
        const replacement = { component: 'Production', props: { fresh: true } }
        const resolved = resolveLitiConfig(
            defineLitiConfig({
                models: { posts: { fields: { slug: text() }, seo: { image: base } } },
                seo: { image: base },
                routeRules: { '/posts/**': { seo: { image: base } } },
                $production: {
                    seo: { image: replacement },
                    models: { posts: { seo: { image: replacement } } },
                    routeRules: { '/posts/**': { seo: { image: replacement } } },
                },
            }),
            ['production'],
        )
        expect(resolved.seo.image).toEqual(replacement)
        expect(resolved.models.posts.seo.image).toEqual(replacement)
        expect(resolved.routeRules['/posts/**'].seo.image).toEqual(replacement)
    })

    it('infers a sole storage while requiring an explicit reference for multiple storages', () => {
        expect(resolveLitiAssets(config.assets, files)?.storage).toBe('content')
        expect(resolveLitiAssets({}, { storage: { adapter: 'fs', config: { root: '/tmp/test' } } })?.storage).toBe(
            'default',
        )
        const storage = { ...files.storage, other: files.storage.content }
        expect(() => resolveLitiAssets({}, { storage })).toThrow('assets.storage is required')
        expect(() => resolveLitiAssets({ storage: 'missing' }, { storage })).toThrow('unknown Files storage')
    })

    it('serializes only the safe descriptor, excluding storage options, AI and database code', () => {
        const serialized = JSON.stringify(createLitiDescriptor(resolveLitiConfig(config, ['development'])))
        expect(serialized).not.toContain('./.data/files')
        expect(serialized).not.toContain('server-only suggestion')
        expect(serialized).not.toContain('maxAttempts')
        expect(JSON.parse(serialized).assets.storage).toBe('content')
    })
})
