export function inferredQueryDefault() {
    const entries = useLitiQuery('articles', { default: () => [] })
    const title: string | undefined = entries.data.value[0]?.data.title
    const transformed = useLitiQuery('articles', {
        transform: (entries) => entries.map((entry) => entry.data.title),
        default: () => [],
    })
    const text: string | undefined = transformed.data.value[0]
    return { title, text }
}
