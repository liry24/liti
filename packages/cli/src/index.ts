#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const args = process.argv.slice(2)
const help = `Usage: liti <command> [options]

Commands:
  generate    Generate schema files from liti.config.ts

Options:
  --help      Show help without loading project configuration
  --version   Show the installed liti version
`

if (args.length === 0 || args.includes('--help')) {
    parseArgs({ args, allowPositionals: true, strict: false, options: { help: { type: 'boolean' } } })
    console.log(help)
} else if (args.includes('--version')) {
    parseArgs({ args, options: { version: { type: 'boolean' } } })
    const manifest: { version: string } = JSON.parse(
        await readFile(new URL(import.meta.resolve('liti/package.json')), 'utf8'),
    )
    console.log(manifest.version)
} else {
    await import('./generate')
}
