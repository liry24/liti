import type { MarkdownItPlugin } from 'comark'
import { parseMarkdown } from 'comark/parse'

export interface ProofreadingOptions {
    /** Additional literal fragments, such as application-specific inline syntax. */
    protect?: (content: string) => unknown[] | Promise<unknown[]>
    summaryDelimiter?: string
}

/** Parser tokens preserve order and multiplicity; this validates AI proposals, not ordinary author edits. */
export async function protectedMarkdown(content: string, options: ProofreadingOptions = {}): Promise<unknown[]> {
    const values: unknown[] = []
    const inlineSource = new WeakMap<object, string>()
    const delimiter = options.summaryDelimiter ?? '<!-- more -->'
    const inspect: MarkdownItPlugin = (parser) => {
        parser.set({ html: true })
        const getRules = parser.inline.ruler.getRules.bind(parser.inline.ruler)
        parser.inline.ruler.getRules = (chain) =>
            getRules(chain).map((rule) => (state, silent) => {
                const start = state.pos,
                    count = state.tokens.length
                const matched = rule(state, silent)
                const token = state.tokens.at(-1)
                if (matched && !silent && state.tokens.length > count && token?.type === 'code_inline')
                    inlineSource.set(token, state.src.slice(start, state.pos))
                return matched
            })
        parser.core.ruler.after('inline', 'liti-protected-markdown', (state) => {
            const lines = state.src.split('\n')
            const visit = (tokens: typeof state.tokens) => {
                for (const [index, token] of tokens.entries()) {
                    if (token.type === 'fence' || token.type === 'code_block')
                        values.push([
                            token.type,
                            token.content,
                            token.info,
                            token.map ? lines.slice(...token.map).join('\n') : token.markup,
                        ])
                    if (token.type === 'code_inline')
                        values.push([token.type, inlineSource.get(token) ?? token.content])
                    if (token.type === 'link_open' || token.type === 'image')
                        values.push([token.type, token.attrGet('href') ?? token.attrGet('src'), token.attrGet('title')])
                    if (token.type === 'html_inline' || token.type === 'html_block')
                        values.push([token.type, token.content])
                    if (token.type === 'html_block' && token.content.includes(delimiter)) {
                        const [start, end] = token.map ?? [0, 0]
                        const blanks = (range: string[]) => {
                            const first = range.findIndex((line) => line.trim())
                            return first < 0 ? range.length : first
                        }
                        values.push([
                            'summary-boundary',
                            index,
                            blanks(lines.slice(0, start).reverse()),
                            blanks(lines.slice(end)),
                        ])
                    }
                    if (token.children) visit(token.children)
                }
            }
            visit(state.tokens)
            values.push([
                'references',
                Object.entries(state.env.references ?? {}).sort(([a], [b]) => a.localeCompare(b)),
            ])
        })
    }
    await parseMarkdown(content, {
        registerDefaultPlugins: false,
        autoClose: false,
        autoUnwrap: false,
        plugins: [{ name: 'liti-protected-markdown', markdownItPlugins: [inspect] }],
    })
    values.push(content.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/giu) ?? [])
    values.push((await options.protect?.(content)) ?? [])
    return values
}

export async function validateProofreading(
    original: string,
    proposal: string,
    options: ProofreadingOptions = {},
): Promise<boolean> {
    if (!proposal.trim()) return false
    const [before, after] = await Promise.all([
        protectedMarkdown(original, options),
        protectedMarkdown(proposal, options),
    ])
    return JSON.stringify(before) === JSON.stringify(after)
}
