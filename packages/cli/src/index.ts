#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const args = process.argv.slice(2)
const help = `Usage: liti <command> [options]

Commands:
  init        Create a minimal configuration and install liti
  plugin add <blog|ai|package>     Install and register a plugin
  plugin remove <blog|ai|package>  Remove its registration and unused package
  generate    Generate schema files from liti.config.ts
  upgrade     Update installed managed packages in the current minor series

Options:
  --help      Show help without loading project configuration
  --version   Show the installed liti version
  --cwd <dir> --config <file> --dry-run --json --no-interactive
  --package-manager <npm|pnpm|bun|yarn>   init, plugin, upgrade only
  init: --nuxt --no-install
  plugin remove: --keep-package
  plugin add/remove: --yes (does not permit speculative configuration edits)
  generate: --env <name> (repeatable) --out <file> --schema-only
  upgrade: --to <range> --major

Dry runs never evaluate configuration or run package managers/generators.
Dynamic configuration requires manual editing. Commands never apply migrations.
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
    try {
        const { values, positionals } = parseArgs({
            args,
            allowPositionals: true,
            options: {
                cwd: { type: 'string' },
                config: { type: 'string' },
                'package-manager': { type: 'string' },
                'dry-run': { type: 'boolean' },
                json: { type: 'boolean' },
                'no-interactive': { type: 'boolean' },
                'no-install': { type: 'boolean' },
                nuxt: { type: 'boolean' },
                'keep-package': { type: 'boolean' },
                yes: { type: 'boolean' },
                to: { type: 'string' },
                major: { type: 'boolean' },
                env: { type: 'string', multiple: true },
                out: { type: 'string' },
                'schema-only': { type: 'boolean' },
            },
        })
        const command = positionals[0]
        if (
            !['init', 'generate', 'upgrade', 'plugin'].includes(command ?? '') ||
            (command === 'plugin'
                ? positionals.length !== 3 || !['add', 'remove'].includes(positionals[1]!)
                : positionals.length !== 1)
        )
            throw new Error('Invalid command. Run liti --help.')
        const allowed = new Set([
            'cwd',
            'config',
            'dry-run',
            'json',
            'no-interactive',
            ...(command === 'generate' ? ['env', 'out', 'schema-only'] : ['package-manager']),
            ...(command === 'init' ? ['nuxt', 'no-install'] : []),
            ...(command === 'plugin' ? ['yes', ...(positionals[1] === 'remove' ? ['keep-package'] : [])] : []),
            ...(command === 'upgrade' ? ['to', 'major'] : []),
        ])
        for (const key of Object.keys(values))
            if (!allowed.has(key)) throw new Error(`--${key} does not apply to ${positionals.join(' ')}.`)
        const manifest: { version: string } = JSON.parse(
            await readFile(new URL(import.meta.resolve('liti/package.json')), 'utf8'),
        )
        const result =
            command === 'generate'
                ? await (await import('./generate')).runGenerate(values)
                : await (await import('./commands')).runCommand(positionals, values, manifest.version)
        if (values.json) console.log(JSON.stringify(result))
        else {
            for (const file of result.files)
                console.log(`${result.status === 'planned' ? 'Plan' : 'File'} ${file.path}`)
            for (const message of result.messages) console.log(message)
            console.log(
                result.status === 'planned'
                    ? 'Dry run complete; no files or dependencies changed and no command was executed.'
                    : result.status,
            )
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (args.includes('--json')) console.log(JSON.stringify({ status: 'failed', error: message }))
        else console.error(message)
        process.exitCode = 1
    }
}
