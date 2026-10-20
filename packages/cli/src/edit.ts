import { parse } from '@babel/parser'
import type { Node, ObjectExpression, ArrayExpression, ImportDeclaration } from '@babel/types'
import type { LitiPluginManifest } from '../../liti/src/plugins'

type Edit = { start: number; end: number; text: string }
const start = (node: Node) => node.start!
const end = (node: Node) => node.end!
const unwrap = (node: Node): Node =>
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)
        ? unwrap((node as Node & { expression: Node }).expression)
        : node

function walk(node: unknown, visit: (node: Node) => void) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit)
        return
    }
    if ('type' in node && typeof node.type === 'string') visit(node as Node)
    for (const [key, value] of Object.entries(node))
        if (!['loc', 'comments', 'tokens', 'leadingComments', 'trailingComments', 'innerComments'].includes(key))
            walk(value, visit)
}

function document(source: string, filename: string) {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript'], sourceFilename: filename })
    const newline = source.includes('\r\n') ? '\r\n' : '\n'
    const quote =
        ast.program.body.find((node) => node.type === 'ImportDeclaration')?.source.extra?.raw?.toString()[0] === '"'
            ? '"'
            : "'"
    const imports = ast.program.body.filter((node): node is ImportDeclaration => node.type === 'ImportDeclaration')
    const exported = ast.program.body.filter((node) => node.type === 'ExportDefaultDeclaration')
    if (exported.length !== 1) throw new Error(`${filename}: expected one editable default export.`)
    let value = unwrap(exported[0]!.declaration)
    if (value.type === 'Identifier') {
        const declarations = ast.program.body
            .flatMap((node) => (node.type === 'VariableDeclaration' && node.kind === 'const' ? node.declarations : []))
            .filter((node) => node.id.type === 'Identifier' && node.id.name === (value as { name: string }).name)
        if (declarations.length !== 1 || !declarations[0]!.init)
            throw new Error(`${filename}: the default export must resolve to a local const or object.`)
        value = unwrap(declarations[0]!.init)
    }
    if (value.type === 'CallExpression') {
        const binding = imports.flatMap((node) =>
            node.importKind !== 'type' && (node.source.value === 'liti' || node.source.value === 'liti/config')
                ? node.specifiers
                      .filter(
                          (item) =>
                              item.type === 'ImportSpecifier' &&
                              item.importKind !== 'type' &&
                              item.imported.type === 'Identifier' &&
                              item.imported.name === 'defineLitiConfig',
                      )
                      .map((item) => item.local.name)
                : [],
        )
        const valid = filename.endsWith('nuxt.config.ts')
            ? value.callee.type === 'Identifier' && value.callee.name === 'defineNuxtConfig'
            : value.callee.type === 'Identifier' && binding.includes(value.callee.name)
        if (!valid || value.arguments.length !== 1)
            throw new Error(`${filename}: cannot safely edit this config factory.`)
        value = unwrap(value.arguments[0]!)
    }
    if (
        value.type !== 'ObjectExpression' ||
        value.properties.some((node) => node.type !== 'ObjectProperty' || node.computed)
    )
        throw new Error(`${filename}: computed properties, spreads and dynamic configuration require a manual edit.`)
    const identifiers = new Set<string>()
    walk(ast.program, (node) => {
        if (node.type === 'Identifier') identifiers.add(node.name)
    })
    return { ast, object: value, imports, newline, quote, identifiers }
}

function property(object: ObjectExpression, name: string) {
    const matches = object.properties.filter(
        (node) =>
            node.type === 'ObjectProperty' &&
            ((node.key.type === 'Identifier' && node.key.name === name) ||
                (node.key.type === 'StringLiteral' && node.key.value === name)),
    )
    if (matches.length > 1) throw new Error(`Duplicate ${name} properties require a manual edit.`)
    const match = matches[0]
    return match?.type === 'ObjectProperty' ? match : undefined
}

function apply(source: string, edits: Edit[]) {
    for (const edit of edits
        .map((item, index) => ({ ...item, index }))
        .sort((a, b) => b.start - a.start || b.end - a.end || b.index - a.index))
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
    return source
}

function commaBetween(source: string, from: number, to: number) {
    const trivia = /(?:\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*/uy
    trivia.lastIndex = from
    trivia.exec(source)
    return trivia.lastIndex < to && source[trivia.lastIndex] === ',' ? trivia.lastIndex : -1
}

function append(source: string, container: ObjectExpression | ArrayExpression, text: string, newline: string): Edit[] {
    const items = container.type === 'ObjectExpression' ? container.properties : container.elements
    const last = items.at(-1)
    const close = end(container) - 1
    const multiline = source.slice(start(container), close).includes('\n')
    const base = source.slice(0, start(container)).split('\n').at(-1)!.match(/^\s*/u)![0]
    const indent = source.match(/\n([ \t]+)\S/u)?.[1] ?? '    '
    const edits: Edit[] = []
    if (last && commaBetween(source, end(last), close) < 0) edits.push({ start: end(last), end: end(last), text: ',' })
    edits.push({
        start: close,
        end: close,
        text: multiline ? `${indent}${text},${newline}${base}` : `${items.length ? ' ' : ''}${text}`,
    })
    return edits
}

function removeItem(source: string, node: Node, siblings: readonly (Node | null)[]): Edit[] {
    const index = siblings.indexOf(node)
    const next = siblings[index + 1]
    const previous = siblings[index - 1]
    const edits = [{ start: start(node), end: end(node), text: '' }]
    // Remove only syntax; comments surrounding the item remain in their original order.
    const comma = next
        ? commaBetween(source, end(node), start(next))
        : previous
          ? commaBetween(source, end(previous), start(node))
          : -1
    if (comma >= 0 && comma < (next ? start(next) : start(node))) edits.push({ start: comma, end: comma + 1, text: '' })
    else if (!next) {
        const trailing = commaBetween(source, end(node), source.length)
        if (trailing >= 0) edits.push({ start: trailing, end: trailing + 1, text: '' })
    }
    return edits
}

export function editPlugin(
    source: string,
    filename: string,
    name: string,
    manifest: LitiPluginManifest,
    action: 'add' | 'remove',
) {
    const manual = `Add import { ${manifest.factory} } from '${manifest.config}' and plugins: [${manifest.factory}(${manifest.options ? JSON.stringify(manifest.options) : ''})] to ${filename}.`
    try {
        const doc = document(source, filename)
        const entry = property(doc.object, 'plugins')
        const array = entry ? unwrap(entry.value) : undefined
        if (
            array &&
            (array.type !== 'ArrayExpression' ||
                array.elements.some(
                    (node) => !node || node.type !== 'CallExpression' || node.callee.type !== 'Identifier',
                ))
        )
            throw new Error('plugins must be a literal array of direct factory calls without spreads.')
        const plugins = array as ArrayExpression | undefined
        const bindings = doc.imports.flatMap((node) =>
            node.importKind !== 'type' && node.source.value === manifest.config
                ? node.specifiers
                      .filter(
                          (item) =>
                              item.type === 'ImportSpecifier' &&
                              item.importKind !== 'type' &&
                              ((item.imported.type === 'Identifier' && item.imported.name === manifest.factory) ||
                                  (item.imported.type === 'StringLiteral' && item.imported.value === manifest.factory)),
                      )
                      .map((item) => ({ declaration: node, specifier: item, local: item.local.name }))
                : [],
        )
        const names = bindings.map((binding) => binding.local)
        const matches =
            plugins?.elements.filter(
                (node) =>
                    node &&
                    node.type === 'CallExpression' &&
                    node.callee.type === 'Identifier' &&
                    names.includes(node.callee.name),
            ) ?? []
        if (matches.length > 1) throw new Error('Duplicate plugin registrations require a manual edit.')
        if (action === 'add') {
            if (matches.length) return { source, keepPackage: true }
            const base = manifest.factory === 'default' ? 'litiPlugin' : manifest.factory
            let local = bindings[0]?.local ?? base
            if (!bindings.length) {
                let suffix = 2
                while (doc.identifiers.has(local)) local = `${base}${suffix++}`
            }
            const call = `${local}(${manifest.options ? JSON.stringify(manifest.options) : ''})`
            const edits = plugins
                ? append(source, plugins, call, doc.newline)
                : append(source, doc.object, `plugins: [${call}]`, doc.newline)
            if (!bindings.length) {
                const position = doc.imports.at(-1)?.end ?? doc.ast.program.interpreter?.end ?? 0
                edits.push({
                    start: position,
                    end: position,
                    text: `${position ? doc.newline : ''}import { ${manifest.factory}${local === manifest.factory ? '' : ` as ${local}`} } from ${doc.quote}${manifest.config}${doc.quote}${doc.newline}`,
                })
            }
            const edited = apply(source, edits)
            parse(edited, { sourceType: 'module', plugins: ['typescript'] })
            return { source: edited, keepPackage: true }
        }
        let edited = apply(
            source,
            matches.flatMap((node) => removeItem(source, node!, plugins!.elements)),
        )
        const updated = document(edited, filename)
        const edits: Edit[] = []
        for (const binding of bindings) {
            const declaration = updated.imports.find(
                (node) =>
                    node.source.value === manifest.config &&
                    node.specifiers.some((item) => item.local.name === binding.local),
            )
            if (!declaration) continue
            let used = false
            walk(updated.ast.program, (node) => {
                if (
                    node.type === 'Identifier' &&
                    node.name === binding.local &&
                    (start(node) < start(declaration) || end(node) > end(declaration))
                )
                    used = true
            })
            if (used) continue
            const specifier = declaration.specifiers.find((item) => item.local.name === binding.local)!
            edits.push(
                ...(declaration.specifiers.length === 1
                    ? [{ start: start(declaration), end: end(declaration), text: '' }]
                    : removeItem(edited, specifier, declaration.specifiers)),
            )
        }
        edited = apply(edited, edits)
        const remaining = parse(edited, { sourceType: 'module', plugins: ['typescript'] })
        let keepPackage = false
        walk(remaining.program, (node) => {
            if (node.type === 'StringLiteral' && (node.value === name || node.value.startsWith(name + '/')))
                keepPackage = true
        })
        return { source: edited, keepPackage }
    } catch (error) {
        throw new Error(
            `${error instanceof Error ? error.message : String(error)} No configuration was changed. ${action === 'add' ? manual : `Remove the ${manifest.factory}() registration manually; retain imports used by other settings.`}`,
            { cause: error },
        )
    }
}

export function editNuxt(source: string) {
    const doc = document(source, 'nuxt.config.ts')
    const entry = property(doc.object, 'modules')
    const array = entry ? unwrap(entry.value) : undefined
    if (
        array &&
        (array.type !== 'ArrayExpression' ||
            array.elements.some(
                (node) =>
                    !node ||
                    (node.type !== 'StringLiteral' &&
                        !(node.type === 'ArrayExpression' && node.elements[0]?.type === 'StringLiteral')),
            ))
    )
        throw new Error('nuxt.config.ts: add liti/nuxt manually to the dynamic modules setting. No files were changed.')
    if (
        array?.type === 'ArrayExpression' &&
        array.elements.some(
            (node) =>
                (node?.type === 'StringLiteral' && node.value === 'liti/nuxt') ||
                (node?.type === 'ArrayExpression' &&
                    node.elements[0]?.type === 'StringLiteral' &&
                    node.elements[0].value === 'liti/nuxt'),
        )
    )
        return source
    return apply(
        source,
        append(
            source,
            (array as ArrayExpression) ?? doc.object,
            array ? `${doc.quote}liti/nuxt${doc.quote}` : `modules: [${doc.quote}liti/nuxt${doc.quote}]`,
            doc.newline,
        ),
    )
}
