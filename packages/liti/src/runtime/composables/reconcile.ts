export const snapshot = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
            : item,
    )

/** Preserve fields changed during the request while accepting the server's canonical values elsewhere. */
export function reconcile<Data extends Record<string, unknown>>(submitted: Data, edited: Data, saved: Data): Data {
    const result = { ...saved }
    for (const key of new Set([...Object.keys(submitted), ...Object.keys(edited)])) {
        if (snapshot(submitted[key]) === snapshot(edited[key])) continue
        if (Object.hasOwn(edited, key)) result[key as keyof Data] = edited[key as keyof Data]
        else delete result[key]
    }
    return result
}
