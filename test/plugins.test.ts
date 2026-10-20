import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineLitiConfig, defineLitiPlugin, resolveLitiConfig, text } from '../packages/liti/src'
import type { DatabaseAdapter, LitiAdapter } from '../packages/liti/src'

const database = (id: string) =>
    ({
        id,
        role: 'database' as const,
        connect: vi.fn(() => {
            throw new Error('Configuration must not connect.')
        }),
    }) satisfies DatabaseAdapter

describe('liti declarations', () => {
    it('normalizes an empty configuration without connecting to a host', () => {
        const config = resolveLitiConfig(defineLitiConfig({}), [])
        expect(config.models).toEqual({})
        expect(config.actions).toEqual({})
    })

    it('collects plugin contributions before validating references, preserving schema identity', () => {
        const input = z.object({ title: z.string() })
        const output = z.object({ slug: z.string() })
        const execute = vi.fn(({ title }: z.infer<typeof input>) => ({ data: { slug: title } }))
        const article = defineLitiPlugin({
            id: 'article',
            apiVersion: 1,
            models: { posts: { fields: { title: text({ required: true }) } } },
            requires: { actions: ['slug'], plugins: ['generation'] },
        })
        const generation = defineLitiPlugin({
            id: 'generation',
            apiVersion: 1,
            actions: { slug: { input, output, execute } },
        })
        for (const plugins of [
            [article, generation],
            [generation, article],
        ]) {
            const resolved = resolveLitiConfig(defineLitiConfig({ plugins }), [])
            expect(resolved.models.posts).toBe(article.models.posts)
            expect(resolved.actions.slug?.input).toBe(input)
            expect(resolved.actions.slug?.output).toBe(output)
            expect(resolved.actions.slug?.execute).toBe(execute)
        }
        expect(execute).not.toHaveBeenCalled()
    })

    it('rejects duplicate plugins, models, actions and unresolved references', () => {
        const plugin = defineLitiPlugin({
            id: 'article',
            apiVersion: 1,
            models: { posts: { fields: { title: text() } } },
        })
        expect(() => resolveLitiConfig(defineLitiConfig({ plugins: [plugin, plugin] }), [])).toThrow('Duplicate plugin')
        expect(() => resolveLitiConfig(defineLitiConfig({ models: plugin.models, plugins: [plugin] }), [])).toThrow(
            'Duplicate model',
        )
        const action = { input: z.string(), output: z.string(), execute: (value: string) => ({ data: value }) }
        expect(() =>
            resolveLitiConfig(
                defineLitiConfig({
                    plugins: [
                        { id: 'a', apiVersion: 1, actions: { shared: action } },
                        { id: 'b', apiVersion: 1, actions: { shared: action } },
                    ],
                }),
                [],
            ),
        ).toThrow('Duplicate action')
        expect(() =>
            resolveLitiConfig(defineLitiConfig({ plugins: [{ ...plugin, requires: { actions: ['missing'] } }] }), []),
        ).toThrow('requires action "missing"')
    })

    it('replaces an entire database provider and plugin array in environment order', () => {
        const original = { ...database('original'), privateConnection: { marker: 'do not merge' } }
        const direct = database('direct')
        const named = database('named')
        const production = defineLitiPlugin({
            id: 'production',
            apiVersion: 1,
            models: { production: { fields: { title: text() } } },
        })
        const config = defineLitiConfig({
            adapter: { database: original },
            plugins: [{ id: 'development', apiVersion: 1, models: { development: { fields: {} } } }],
            $production: { adapter: { database: direct }, plugins: [production] },
            $env: { production: { adapter: { database: named } } },
        })
        const resolved = resolveLitiConfig(config, ['production'])
        expect(resolved.adapter.database).toBe(named)
        expect(resolved.adapter.database).not.toHaveProperty('privateConnection')
        expect(resolved.models).toEqual(production.models)
        expect(resolved.plugins).toEqual([production])
        expect(Object.keys(resolved).some((key) => key.startsWith('$'))).toBe(false)
        expect(original.connect).not.toHaveBeenCalled()
        expect(direct.connect).not.toHaveBeenCalled()
        expect(named.connect).not.toHaveBeenCalled()
    })

    it.each([[], { unknown: database('db') }, { auth: database('db') }, { database: { id: 'db', role: 'database' } }])(
        'rejects malformed adapter slots before runtime: %j',
        (adapter) => {
            expect(() => resolveLitiConfig(defineLitiConfig({ adapter: adapter as LitiAdapter }), [])).toThrow(
                'adapter',
            )
        },
    )
})
