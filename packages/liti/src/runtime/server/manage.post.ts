import { assertAuthOrigin, getAuthForRequest } from '@vite-hub/auth/server'
import { ModelError, type Actor } from '@litijs/model'
import type { PublishSelection } from '@litijs/model/content'
import { createError, defineEventHandler, readBody, setResponseHeader, getRequestURL, getRequestHeaders } from 'h3'
import runtime from '#liti/runtime'
import { object, text, respond } from './http'

export default defineEventHandler((event) =>
    respond(event, async () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(getRequestHeaders(event)))
            if (value !== undefined) headers.set(key, value)
        const request = { url: getRequestURL(event).href, headers }
        await assertAuthOrigin(request, event)
        const session = await getAuthForRequest(request, undefined, event).api.getSession({ headers: request.headers })
        if (!session?.user) throw createError({ statusCode: 401, message: 'Sign in to manage content.' })
        const actor: Actor = { ...session.user, id: text(session.user.id) }
        setResponseHeader(event, 'x-liti-actor', actor.id)
        const input = object(await readBody(event)),
            action = text(input.action)
        if (action === 'models') return await runtime.descriptors(actor)
        const name = text(input.model),
            model = runtime.definition(name),
            operation = { actor }
        const id = text(input.id),
            locale = input.locale === undefined ? undefined : text(input.locale)
        if (action === 'read') {
            if (model.storage === 'content')
                return await runtime.content.readDraft(
                    name,
                    id,
                    operation,
                    locale,
                    input.revision === undefined ? {} : { revision: text(input.revision) },
                )
            const entry = await runtime.records.readDraft(name, id, operation)
            if (input.ifVersion !== undefined && entry?.version !== Number(input.ifVersion))
                throw new ModelError('LITI_CONFLICT', 'The record changed after the save receipt.')
            return entry ? { ...entry, model: name } : null
        }
        if (model.storage === 'records') {
            const ifVersion = input.ifVersion === null ? null : Number(input.ifVersion)
            if (action === 'save')
                return await runtime.records.save(name, id, object(input.data), { ...operation, ifVersion })
            if (action === 'remove' && ifVersion !== null)
                return await runtime.records.remove(name, id, { ...operation, ifVersion })
            throw new ModelError('LITI_INVALID_INPUT', 'Unsupported record action.')
        }
        if (['save', 'restore', 'remove'].includes(action) && !Object.hasOwn(input, 'ifDigest'))
            throw new ModelError('LITI_INVALID_INPUT', 'A reviewed document digest is required.')
        const ifDigest = input.ifDigest == null ? null : text(input.ifDigest, false)
        const write = { ...operation, ifDigest, ...(locale ? { locale } : {}) }
        if (action === 'save')
            return await runtime.content.save(
                name,
                id,
                {
                    data: object(input.data),
                    ...(input.body === undefined ? {} : { body: input.body === null ? null : text(input.body, false) }),
                    ...(input.order === undefined ? {} : { order: Number(input.order) }),
                },
                write,
            )
        if (action === 'restore') return await runtime.content.restore(name, id, text(input.revision), write)
        if (action === 'remove' && ifDigest !== null)
            return await runtime.content.remove(name, id, { ...write, ifDigest })
        if (action === 'unpublish')
            return await runtime.content.unpublish(name, id, { ...operation, ifHead: text(input.ifHead) })
        if (action === 'cancelSchedule') return await runtime.content.cancelSchedule(text(input.schedule), operation)
        if (action === 'publish' || action === 'schedule') {
            const digests = object(input.digests)
            for (const digest of Object.values(digests)) if (digest !== null) text(digest)
            const selection: PublishSelection[] = [
                { model: name, id, digests: digests as Record<string, string | null> },
            ]
            return action === 'publish'
                ? await runtime.content.publish(selection, operation)
                : await runtime.content.schedule(selection, new Date(text(input.at)), operation)
        }
        throw new ModelError('LITI_INVALID_INPUT', 'Unknown management action.')
    }),
)
