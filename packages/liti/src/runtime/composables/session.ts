import { computed, watch, type ComputedRef } from 'vue'
import { clearNuxtData, useState } from '#app'
import { useUserSession, type UserSession } from '@vite-hub/auth/vue'
export function useLitiSession(): UserSession & {
    scope: ComputedRef<string>
    rememberActor(actor: string, requestedScope: string): void
} {
    const auth = useUserSession()
    const requestScope = useState('liti:request-scope', () => crypto.randomUUID())
    const knownActor = useState<string | null>('liti:actor', () => null)
    const rememberActor = (actor: string, requestedScope: string) => {
        if (requestScope.value !== requestedScope) return
        if (knownActor.value !== null && knownActor.value !== actor) requestScope.value = crypto.randomUUID()
        knownActor.value = actor
    }
    watch(
        [auth.ready, auth.user],
        ([ready, user]) => {
            if (ready) rememberActor(user?.id ?? '', requestScope.value)
        },
        { flush: 'sync', immediate: true },
    )
    const scope = computed(() => requestScope.value)
    watch(
        scope,
        (next, previous) => {
            if (next !== previous) clearNuxtData((key) => key.startsWith('liti:private:'))
        },
        { flush: 'sync' },
    )
    return { ...auth, scope, rememberActor }
}
