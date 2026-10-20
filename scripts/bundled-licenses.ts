import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin } from 'vite-plus'

export const bundledLicenses = (): Plugin => ({
    name: 'bundled-licenses',
    async generateBundle(_options, bundle) {
        const roots = new Set<string>()
        for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue
            for (const id of chunk.moduleIds) {
                const path = id.replaceAll('\\', '/')
                const offset = path.lastIndexOf('/node_modules/')
                if (offset < 0 || path.startsWith('\0')) continue
                const parts = path.slice(offset + 14).split('/')
                roots.add(path.slice(0, offset + 14) + parts.slice(0, parts[0]!.startsWith('@') ? 2 : 1).join('/'))
            }
        }
        const notices = new Map<string, string>()
        for (const root of roots) {
            const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
            const files = (await readdir(root)).filter((name) =>
                /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/iu.test(name),
            )
            if (!files.length) throw new Error(`Bundled dependency has no license text: ${manifest.name}`)
            const texts = await Promise.all(files.sort().map((name) => readFile(join(root, name), 'utf8')))
            notices.set(`${manifest.name}@${manifest.version}`, texts.join('\n\n'))
        }
        if (!notices.size) return
        const typesOnly = Object.keys(bundle).every((name) => /\.d\.[cm]?ts$/u.test(name))
        this.emitFile({
            type: 'asset',
            fileName: typesOnly ? 'THIRD_PARTY_TYPES_LICENSES.txt' : 'THIRD_PARTY_LICENSES.txt',
            source: [...notices]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, license]) => `${name}\n${'='.repeat(name.length)}\n\n${license}`)
                .join('\n\n'),
        })
    },
})
