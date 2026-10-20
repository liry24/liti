import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const cli = resolve('packages/cli/src/index.ts')

describe('configuration-free CLI', () => {
    it('does not evaluate project configuration for default help, explicit help, or version', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'liti-cli-'))
        try {
            await writeFile(join(directory, 'liti.config.ts'), 'throw new Error("Config was evaluated")')
            const { stdout: help } = await run('bun', [cli], { cwd: directory })
            expect(help).toContain('Usage: liti')
            const { stdout: explicit } = await run('bun', [cli, 'generate', '--config', 'missing.ts', '--help'], {
                cwd: directory,
            })
            expect(explicit).toBe(help)
            const { stdout: version } = await run('bun', [cli, '--version'], { cwd: directory })
            const manifest = await import('../packages/liti/package.json')
            expect(version.trim()).toBe(manifest.version)
        } finally {
            await rm(directory, { recursive: true, force: true })
        }
    })
})
