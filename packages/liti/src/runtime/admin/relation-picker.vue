<script setup lang="ts">
import type { ModelName } from '../../nuxt/types'
import { useLitiQuery } from '../composables/query'
import { useLitiModels } from '../composables/models'
import { computed, ref } from 'vue'
const props = defineProps<{ model: ModelName; modelValue?: string; id: string; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined] }>()
const offset = ref(0),
    catalog = await useLitiModels()
const title = computed(() => props.label ?? catalog.data.value?.find((model) => model.name === props.model)?.title)
const { data, status, error, total } = await useLitiQuery(props.model, {
    limit: 100,
    get offset() {
        return offset.value
    },
})
const { data: current } = await useLitiQuery(props.model, { mode: 'one', id: () => props.modelValue })
const labelFor = (entry: { id: string; data: object }) => {
    const value = Object.entries(entry.data).find(([key]) => key === title.value)?.[1]
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
        <nav v-if="total > 100" aria-label="参照候補のページ">
            <button type="button" :disabled="offset === 0" @click="offset -= 100">前へ</button>
            <button type="button" :disabled="offset + 100 >= total" @click="offset += 100">次へ</button>
        </nav>
        <p v-if="error" role="alert">{{ error.message }}</p>
    </div>
</template>
