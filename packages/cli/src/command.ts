import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GenerationPlan } from '../../liti/src/plugins'

export async function generationRuntime() {
    if (!process.versions.bun) return process.execPath
    // Tooling uses Node loader hooks even when the CLI itself was started with Bun.
    const { stdout } = await promisify(execFile)('node', ['--version'])
    const [major, minor] = stdout.trim().replace(/^v/u, '').split('.').map(Number)
    if (!major || major < 24 || (major === 24 && (!minor || minor < 21)))
        throw new Error('Migration generation requires Node >=24.21.0 on PATH.')
    return 'node'
}

/** Run the project's installed executable and its declared peers without changing dependency resolution elsewhere. */
export async function resolveGenerationCommand(
    command: NonNullable<GenerationPlan['command']>,
    projectRoot: string,
): Promise<string[]> {
    const packagePath = resolve(projectRoot, 'package.json')
    const require = createRequire(packagePath)
    const manifest = async (name: string, version: string) => {
        const path = require.resolve
            .paths(name)
            ?.map((directory) => resolve(directory, name, 'package.json'))
            .find(existsSync)
        if (!path) throw new Error(`Install ${name}@${version} in this project before generating migrations.`)
        const data = JSON.parse(await readFile(path, 'utf8')) as {
            version: string
            bin?: string | Record<string, string>
        }
        if (data.version !== version)
            throw new Error(`Expected ${name}@${version}; the project resolves ${data.version}.`)
        return { path, data }
    }
    const { path, data } = await manifest(command.package, command.version)
    const bin = typeof data.bin === 'string' ? data.bin : data.bin?.[command.bin]
    if (!bin) throw new Error(`Missing ${command.bin} executable in ${command.package}.`)
    const executable = resolve(dirname(path), bin)
    if (!existsSync(executable)) throw new Error(`Missing installed executable: ${executable}`)
    const peers = Object.entries(command.peers ?? {})
    for (const [name, version] of peers) await manifest(name, version)
    if (!peers.length) return [executable, ...command.args]
    const loader = `import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
const peers = ${JSON.stringify(peers.map(([name]) => name))}
const require = createRequire(${JSON.stringify(pathToFileURL(packagePath).href)})
let resolving = false
registerHooks({ resolve(specifier, context, nextResolve) {
    if (resolving || !peers.some(name => specifier === name || specifier.startsWith(name + '/')))
        return nextResolve(specifier, context)
    if (!context.conditions.includes('require'))
        return nextResolve(specifier, { ...context, parentURL: ${JSON.stringify(pathToFileURL(packagePath).href)} })
    resolving = true
    try { return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true } }
    finally { resolving = false }
} })`
    return ['--import', `data:text/javascript,${encodeURIComponent(loader)}`, executable, ...command.args]
}
