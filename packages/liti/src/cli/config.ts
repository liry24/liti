import {
    parseModule,
    generateCode,
    type ProxifiedObject,
    type ProxifiedArray,
    type ProxifiedFunctionCall,
} from 'magicast'

/** Refuse dynamic configuration instead of evaluating it during scaffolding. */
export function editModules(source: string, modules: readonly string[], action: 'add' | 'remove') {
    const parsed = parseModule<{ default: unknown }>(source)
    let value: unknown = parsed.exports.default
    if (value && typeof value === 'object' && (value as ProxifiedFunctionCall).$type === 'function-call') {
        const call = value as ProxifiedFunctionCall
        if (call.$callee !== 'defineNuxtConfig' || call.$args.length !== 1)
            throw new Error('Edit this Nuxt configuration manually; only defineNuxtConfig({ ... }) is supported.')
        value = call.$args[0]
    }
    if (!value || typeof value !== 'object' || (value as ProxifiedObject).$type !== 'object')
        throw new Error('Edit this dynamic Nuxt configuration manually. No files changed.')
    const config = value as ProxifiedObject<Record<string, unknown>>
    if (
        config.$ast.type !== 'ObjectExpression' ||
        config.$ast.properties.some((property) => property.type !== 'ObjectProperty' || property.computed)
    )
        throw new Error('Edit Nuxt configuration with spreads or computed keys manually. No files changed.')
    if (config.modules === undefined) config.modules = []
    const list = config.modules as ProxifiedArray
    if (
        list.$type !== 'array' ||
        list.$ast.type !== 'ArrayExpression' ||
        list.$ast.elements.some((element) => element?.type === 'SpreadElement')
    )
        throw new Error('Edit the dynamic Nuxt modules list manually. No files changed.')
    const name = (entry: unknown): string => {
        if (typeof entry === 'string') return entry
        if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0]
        throw new Error('Use literal module names or edit the Nuxt modules list manually. No files changed.')
    }
    const names = list.map(name)
    if (action === 'add')
        for (const module of modules) {
            if (!names.includes(module)) list.push(module)
        }
    else
        for (let index = list.length - 1; index >= 0; index--) {
            if (modules.includes(names[index]!)) list.splice(index, 1)
        }
    return generateCode(parsed).code
}
