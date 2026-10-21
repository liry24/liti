import { customAlphabet } from 'nanoid'
import { LitiError, type ModelPreparationContext } from 'liti'

const slugId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6)

export const slugFromTitle = (title: string): string =>
    title
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[\u0300-\u036f]/gu, '')
        .replace(/[^a-z0-9]+/gu, '-')
        .slice(0, 80)
        .replace(/^-|-$/gu, '')

export async function availableSlug(context: ModelPreparationContext, field: string, base: string): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
        const candidate =
            base && attempt === 0 ? base : `${base ? base.slice(0, 73).replace(/-$/u, '') + '-' : ''}${slugId()}`
        context.signal?.throwIfAborted()
        context.request?.signal.throwIfAborted()
        if (await context.read.published.routeAvailable({ ...context.data, [field]: candidate })) return candidate
    }
    throw new LitiError('LITI_ROUTE_CONFLICT', 'Could not generate an available article URL. Retry publishing.')
}
