import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface DeclarationResult {
    stdout: string
    stderr: string
}
export const diagnostics = (result: DeclarationResult) =>
    (result.stdout + result.stderr)
        .trim()
        .replaceAll('\r', '')
        .split(/\n(?=\S.*error TS)/u)
        .filter(Boolean)
        .map((item) => item.replace(/\(\d+,\d+\):/u, ':'))
        .sort((left, right) => left.localeCompare(right))

export function assertNativeDiagnostics(checked: DeclarationResult, baseline: DeclarationResult) {
    const actual = diagnostics(checked),
        native = new Set(diagnostics(baseline))
    for (const diagnostic of actual) {
        assert.match(diagnostic, /^node_modules\//u, 'Consumer source must typecheck')
        assert.doesNotMatch(diagnostic, /@litijs(?:\/|\+)|node_modules\/liti\//u, 'SDK declarations must typecheck')
        assert.ok(native.has(diagnostic), `SDK added a declaration diagnostic:\n${diagnostic}`)
    }
    return actual.length
}

/** Reuses the earlier strict native-baseline check without disabling declaration checking. */
export async function verifyNativeDeclarations(directory: string, config: string, nativeImports: readonly string[]) {
    const check = (path: string) =>
        spawnSync(
            process.execPath,
            [
                'node_modules/typescript/bin/tsc',
                '--noEmit',
                '--strict',
                '--skipLibCheck',
                'false',
                '--pretty',
                'false',
                '-p',
                path,
            ],
            { cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        )
    const checked = check(config)
    if (checked.error) throw checked.error
    if (checked.status === 0) {
        console.log('PASS strict standalone Model declarations')
        return
    }
    // shortcut: compare native alpha declaration failures until the installed upstream declarations pass.
    await writeFile(
        join(directory, 'native-types.ts'),
        nativeImports.map((name) => `import ${JSON.stringify(name)}`).join('\n'),
    )
    await writeFile(
        join(directory, 'tsconfig.native.json'),
        JSON.stringify({ extends: `./${config}`, include: ['native-types.ts'] }),
    )
    const baseline = check('tsconfig.native.json')
    if (baseline.error) throw baseline.error
    assert.notEqual(baseline.status, 0, 'SDK declarations failed while native declarations passed')
    const count = assertNativeDiagnostics(checked, baseline)
    console.log(`Strict native declarations: ${count} pre-existing upstream diagnostics; Model adds none`)
}
