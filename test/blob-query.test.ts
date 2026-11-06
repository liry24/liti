import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parseImageVariant } from 'vite-hub/blob'
import { expect, it } from 'vite-plus/test'

it('parses native Blob variants from H3 1 and H3 2 paths without losing repeated values', () => {
    const require = createRequire(import.meta.url)
    const source = readFileSync(require.resolve('@vite-hub/blob/vite'), 'utf8')
    const lines = source
        .split('\n')
        .filter((line) => /"    const (query|variant) =/.test(line))
        .map((line) => JSON.parse(line.trim().replace(/,$/, '')))
    expect(lines).toHaveLength(2)
    const variant = new Function('event', 'parseImageVariant', `${lines.join('\n')}\nreturn variant`)
    for (const path of ['/media/image.png', 'https://example.invalid/media/image.png']) {
        expect(variant({ path }, parseImageVariant)).toBeUndefined()
        expect(variant({ path: `${path}?w=80&w=120&h=40&fmt=webp` }, parseImageVariant)).toMatchObject({
            width: 80,
            height: 40,
            format: 'webp',
        })
        expect(() => variant({ path: `${path}?w=invalid` }, parseImageVariant)).toThrow()
    }
})
