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
    return `${base}-${id}`
}
