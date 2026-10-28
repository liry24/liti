import { expect, it } from 'vite-plus/test'
import { assertNativeDiagnostics } from './declarations.ts'
const result = (stdout: string) => ({ stdout, stderr: '' })
it('permits only identical upstream diagnostics while rejecting source, SDK and newly introduced failures', () => {
    const native = result('node_modules/native/index.d.ts(1,2): error TS2307: Missing optional native type.\n')
    expect(
        assertNativeDiagnostics(
            result('node_modules/native/index.d.ts(4,5): error TS2307: Missing optional native type.\n'),
            native,
        ),
    ).toBe(1)
    for (const path of [
        'server/model.ts',
        'node_modules/@litijs/model/dist/index.d.ts',
        'node_modules/liti/dist/index.d.ts',
        'node_modules/new-native/index.d.ts',
    ])
        expect(() =>
            assertNativeDiagnostics(result(`${path}(1,2): error TS2307: Missing optional native type.\n`), native),
        ).toThrow()
})
