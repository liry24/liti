import type { Entry } from 'liti/types'

export function inferredSharedEntry(entry: Entry<'articles'>) {
    const body: string = entry.body
    const title: string = entry.data.title
    return { body, title }
}
