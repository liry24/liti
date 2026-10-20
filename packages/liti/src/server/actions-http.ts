import { LitiError } from '../errors'

export const handleActionRequest = async (
    request: Request,
    base: string,
    execute: (name: string, input: unknown) => Promise<unknown>,
): Promise<Response> => {
    const headers = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, no-store',
        vary: 'Cookie',
    }
    try {
        if (request.method !== 'POST')
            return new Response(JSON.stringify({ error: { code: 'LITI_INVALID_INPUT', message: 'POST required.' } }), {
                status: 405,
                headers: { ...headers, allow: 'POST' },
            })
        const url = new URL(request.url)
        const origin = request.headers.get('origin')
        const site = request.headers.get('sec-fetch-site')
        if (origin !== null ? origin !== url.origin : site !== null && site !== 'same-origin')
            throw new LitiError('LITI_FORBIDDEN', 'Actions require the same origin.')
        const prefix = base.replace(/\/$/u, '') + '/actions/'
        const suffix = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ''
        if (!suffix || suffix.includes('/')) throw new LitiError('LITI_ENTRY_NOT_FOUND', 'Action does not exist.')
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
            throw new LitiError('LITI_INVALID_INPUT', 'Content-Type must be application/json.')
        let input: unknown
        try {
            const reader = request.body?.getReader()
            const chunks: Uint8Array[] = []
            let length = 0
            if (reader) {
                try {
                    while (true) {
                        request.signal.throwIfAborted()
                        const { done, value } = await reader.read()
                        if (done) break
                        length += value.byteLength
                        if (length > 1_048_576) {
                            await reader.cancel()
                            throw new LitiError('LITI_INVALID_INPUT', 'Action input exceeds 1 MiB.')
                        }
                        chunks.push(value)
                    }
                } finally {
                    reader.releaseLock()
                }
            }
            const bytes = new Uint8Array(length)
            let offset = 0
            for (const chunk of chunks) {
                bytes.set(chunk, offset)
                offset += chunk.byteLength
            }
            const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
            if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'input'))
                throw new LitiError('LITI_INVALID_INPUT', 'Action requires input.')
            input = (body as { input: unknown }).input
        } catch (error) {
            if (error instanceof LitiError) throw error
            throw new LitiError('LITI_INVALID_INPUT', 'Invalid JSON.')
        }
        return new Response(JSON.stringify(await execute(decodeURIComponent(suffix), input)), { headers })
    } catch (error) {
        const known = error instanceof LitiError ? error : new LitiError('LITI_ACTION_FAILED', 'Action failed.')
        return new Response(
            JSON.stringify({
                error: { code: known.code, message: known.message, ...(known.issues ? { issues: known.issues } : {}) },
            }),
            { status: known.status, headers },
        )
    }
}
