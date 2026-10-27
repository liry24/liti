import { computed, watch } from 'vue'
import { useAsyncData, useRequestFetch, useRequestURL } from '#app'
import type { describeModel } from '@litijs/model'
import { litiBaseURL } from './context'
import { useLitiSession } from './session'

export function useLitiModels() {
    const session = useLitiSession(),
        request = useRequestFetch(),
        origin = useRequestURL().origin,
        base = litiBaseURL()
    const key = computed(() => `liti:private:${session.scope.value}:models`)
    const resource = useAsyncData(key, async (_app, { signal }) => {
        const requestedScope = session.scope.value
        return await request<ReturnType<typeof describeModel>[]>(`${base}/manage`, {
            method: 'POST',
            body: { action: 'models' },
            headers: { origin },
            signal,
            onResponse: ({ response }) =>
                session.rememberActor(response.headers.get('x-liti-actor') ?? '', requestedScope),
        })
    })
    watch(
        session.scope,
        () => {
            resource.data.value = undefined
        },
        { flush: 'sync' },
    )
    return resource
}
