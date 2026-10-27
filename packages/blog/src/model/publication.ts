import type { ContentEntry, DraftEntry } from '@litijs/model'

export interface ArticleDates {
    authoredAt: string | null
    firstPublishedAt: string | null
    publishedUpdatedAt: string | null
    date: string | null
}
export function articleDates(entry: Pick<ContentEntry, 'data' | 'publication'>): ArticleDates {
    const authoredAt = typeof entry.data.authoredAt === 'string' ? entry.data.authoredAt : null
    const firstPublishedAt = entry.publication?.firstPublishedAt ?? null
    return {
        authoredAt,
        firstPublishedAt,
        publishedUpdatedAt: entry.publication?.updatedAt ?? null,
        date: authoredAt ?? firstPublishedAt,
    }
}
export const articleDraftUpdatedAt = (entry: Pick<DraftEntry, 'updatedAt'>) => entry.updatedAt
/** Returns Markdown so the application's existing renderer owns HTML policy and component syntax. */
export function articleSummary(entry: Pick<ContentEntry, 'data' | 'body'>) {
    return typeof entry.data.summary === 'string' ? entry.data.summary : entry.body.split('<!-- more -->', 1)[0]!.trim()
}
