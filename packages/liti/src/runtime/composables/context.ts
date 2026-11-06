import { useRuntimeConfig } from '#app'
export const litiBaseURL = () => (useRuntimeConfig().public.liti as { baseURL: string }).baseURL
