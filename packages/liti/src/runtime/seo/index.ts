import { useHead, useSeoMeta } from '#app'
import { toValue, type MaybeRefOrGetter } from 'vue'

export interface LitiSeo {
    url: string | null
    title?: string
    description?: string
    image?: string
    publication?: { firstPublishedAt: string | null; updatedAt: string | null } | null
}
export function useLitiSeo(
    entry: MaybeRefOrGetter<LitiSeo | null | undefined>,
    options: { origin: string; alternates?: MaybeRefOrGetter<Record<string, string>> },
) {
    const absolute = (path: string) => new URL(path, options.origin).href
    useHead(() => ({
        link: [
            ...(toValue(entry)?.url ? [{ rel: 'canonical' as const, href: absolute(toValue(entry)!.url!) }] : []),
            ...Object.entries(toValue(options.alternates) ?? {}).map(([hreflang, href]) => ({
                rel: 'alternate' as const,
                hreflang,
                href: absolute(href),
            })),
        ],
    }))
    useSeoMeta({
        title: () => toValue(entry)?.title,
        description: () => toValue(entry)?.description,
        ogTitle: () => toValue(entry)?.title,
        ogDescription: () => toValue(entry)?.description,
        ogImage: () => toValue(entry)?.image,
        ogUrl: () => (toValue(entry)?.url ? absolute(toValue(entry)!.url!) : undefined),
        articlePublishedTime: () => toValue(entry)?.publication?.firstPublishedAt ?? undefined,
        articleModifiedTime: () => toValue(entry)?.publication?.updatedAt ?? undefined,
    })
}
