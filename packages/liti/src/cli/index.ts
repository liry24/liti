#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const help = `Usage: liti <init|add blog|remove blog|generate|upgrade> [options]
  --cwd <directory> --dry-run --json --package-manager <bun|npm|pnpm>
  upgrade --to <exact-version|full-commit-sha>

init registers native ViteHub and liti/nuxt and creates explicit Content/Model definitions.
add/remove blog changes its optional Nuxt integration; existing article definitions/data remain yours.
generate delegates to Nuxt prepare and ViteHub db generate. It never applies migrations.
upgrade selects one exact Liti package cohort. ViteHub alpha updates remain separate changes.
Dry runs never load configuration, install dependencies, execute generators or change files.
`
const args = process.argv.slice(2)
const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
    dependencies: Record<string, string>
}
if (!args.length || args.includes('--help')) console.log(help)
else if (args.includes('--version')) console.log(manifest.version)
else {
    try {
        const { values, positionals } = parseArgs({
            args,
            allowPositionals: true,
            options: {
                cwd: { type: 'string' },
                'dry-run': { type: 'boolean' },
                json: { type: 'boolean' },
                'package-manager': { type: 'string' },
                to: { type: 'string' },
            },
        })
        const { runCommand } = await import('./run')
        const result = await runCommand(positionals, values, manifest, new URL('../patches/', import.meta.url))
        console.log(values.json ? JSON.stringify(result) : result.join('\n'))
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (args.includes('--json')) console.log(JSON.stringify({ status: 'failed', error: message }))
        else console.error(message)
        process.exitCode = 1
    }
}
