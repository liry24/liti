import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export const verifyNuxtDeclarations = async (directory) => {
    const local = createRequire(join(directory, 'package.json'))
    const tsc = join(dirname(local.resolve('typescript/package.json')), 'bin/tsc')
    const check = (config) =>
        spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', 'false', '-p', config], {
            cwd: directory,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        })
    const checked = check('.nuxt/tsconfig.app.json')
    if (checked.status === 0) return
    // shortcut: Nuxt 4.6.2 has native declaration errors; remove this comparison once upstream passes.
    await mkdir(join(directory, 'native'), { recursive: true })
    await writeFile(
        join(directory, 'native/nuxt.config.ts'),
        "import { defineNuxtConfig } from 'nuxt/config'; export default defineNuxtConfig({ devtools: false })",
    )
    const prepared = spawnSync(
        process.execPath,
        [join(dirname(local.resolve('nuxt/package.json')), 'bin/nuxt.mjs'), 'prepare', 'native'],
        { cwd: directory, encoding: 'utf8' },
    )
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr)
    const baseline = check('native/.nuxt/tsconfig.app.json')
    assert.notEqual(baseline.status, 0, 'SDK declarations failed while native Nuxt passed')
    const diagnostics = (result) =>
        (result.stdout + result.stderr)
            .trim()
            .replaceAll('\r', '')
            .split(/\n(?=\S.*error TS)/u)
            .map((item) =>
                item
                    .replace(/^native\//u, '')
                    .replace(/\(\d+,\d+\):/u, ':')
                    .replace(/(?:\.\.\/)+(node_modules|#internal)\//gu, '$1/'),
            )
            .sort()
    assert.deepEqual(diagnostics(checked), diagnostics(baseline), 'SDK must add no errors to native Nuxt declarations')
    console.warn(`Strict Nuxt declarations: ${diagnostics(baseline).length} upstream diagnostics; SDK adds none`)
}
