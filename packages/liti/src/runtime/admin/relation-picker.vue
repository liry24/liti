<script setup lang="ts">
import type { ModelName } from '../../nuxt/types'
import { useLitiQuery } from '../composables/query'
const props = defineProps<{ model: ModelName; modelValue?: string; id: string; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()
const { data, status, error } = await useLitiQuery(props.model, { limit: 100 })
const { data: current } = await useLitiQuery(props.model, { mode: 'one', id: () => props.modelValue })
const labelFor = (entry: { id: string; data: object }) => {
    const value = Object.entries(entry.data).find(([key]) => key === props.label)?.[1]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : entry.id
}
</script>
<template>
    <div>
        <select
            :id="id"
            :value="modelValue ?? ''"
            :aria-busy="status === 'pending'"
            @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value || undefined)"
        >
            <option value="">—</option>
            <option v-if="current && !data.some((entry) => entry.id === current!.id)" :value="current.id">
                {{ labelFor(current) }}
            </option>
            <option v-for="entry in data" :key="entry.id" :value="entry.id">{{ labelFor(entry) }}</option>
        </select>
        <p v-if="error" role="alert">{{ error.message }}</p>
    </div>
</template>
