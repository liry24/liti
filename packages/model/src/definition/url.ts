import { ModelError } from './errors'

const hasControl = (value: string) =>
    value.split('').some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

export function normalizeModelUrl(value: string | null | undefined): string | null {
    if (value == null) return null
    if (
        typeof value !== 'string' ||
        !value.startsWith('/') ||
        value.startsWith('//') ||
        /[\\?#]/u.test(value) ||
        hasControl(value)
    )
        throw new ModelError(
            'LITI_INVALID_INPUT',
            'Public model URLs must be root-relative paths without a query or fragment.',
        )
    const url = new URL(value, 'https://liti.invalid')
    if (url.origin !== 'https://liti.invalid')
        throw new ModelError('LITI_INVALID_INPUT', 'Invalid public model origin.')
    try {
        return url.pathname
            .split('/')
            .map((part) => {
                const decoded = decodeURIComponent(part)
                if (/[\\/]/u.test(decoded) || hasControl(decoded)) throw new Error('Invalid path segment')
                return encodeURIComponent(decoded)
            })
            .join('/')
    } catch {
        throw new ModelError('LITI_INVALID_INPUT', 'Invalid public model path encoding.')
    }
}
