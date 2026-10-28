import assert from 'node:assert/strict'
import test from 'node:test'
import { transformSchedulePlugin } from '../fixtures/vitehub/workarounds/schedule-plugin.ts'

await test('only the generated Schedule plugin uses the host Nitro plugin API', () => {
    const source =
        "import { definePlugin } from 'nitro'\nexport default definePlugin(app => app.hooks.hook('cloudflare:scheduled', run))"
    const result = transformSchedulePlugin(source, 'C:\\project\\.vitehub\\nitro\\schedule\\plugin.ts')
    assert.equal(
        result,
        source.replace(
            "import { definePlugin } from 'nitro'",
            "import { defineNitroPlugin as definePlugin } from 'nitropack/runtime'",
        ),
    )
    assert.equal(transformSchedulePlugin(source, '/app/server/plugins/app.ts'), undefined)
})
