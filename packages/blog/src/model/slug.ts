export const slugFromTitle = (title: string): string =>
    Array.from(
        title
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '-'),
    )
        .slice(0, 80)
        .join('')
        .replace(/^-|-$/gu, '')

// An entry-derived suffix makes automatic slugs deterministic without a draft URL reservation.
export function articleSlug(title: string, id: string) {
    const base = slugFromTitle(title) || 'post'
    const parts = Array.from(base)
    while (parts.join('').length + id.length + 1 > 210) parts.pop()
    return `${parts.join('')}-${id}`
}
