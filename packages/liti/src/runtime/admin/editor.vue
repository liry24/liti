<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { describeModel } from '@litijs/model'
import type { ModelName } from '../../nuxt/types'
import { useLitiForm } from '../composables/form'
import RelationPicker from './relation-picker.vue'
import { snapshot } from '../composables/reconcile'
const props = defineProps<{ model: ReturnType<typeof describeModel>; entryId?: string }>()
const locale = ref(props.model.locales?.default ?? 'und')
const { form, save, error, warnings, values, receipt, isDirty } = await useLitiForm(props.model.name as ModelName, {
    id: () => props.entryId,
    locale,
})
const translated = computed(() => locale.value !== (props.model.locales?.default ?? 'und'))
const fields = computed(() =>
    Object.entries(props.model.fields).filter(([, definition]) => !translated.value || definition.localized),
)
const value = (name: string) => Object.entries(values.value.data).find(([key]) => key === name)?.[1]
const jsonInputs = reactive<Record<string, string>>({}),
    jsonErrors = reactive<Record<string, string>>({})
const set = (name: string, input: unknown, inherit = false) => {
    const data = { ...values.value.data } as Record<string, unknown>
    if (inherit || input === undefined) delete data[name]
    else data[name] = input
    form.setFieldValue('data', data)
}
const fieldType = (schema: unknown) =>
    schema && typeof schema === 'object' && 'type' in schema ? schema.type : undefined
const setJson = (name: string, input: string) => {
    jsonInputs[name] = input
    try {
        set(name, input ? JSON.parse(input) : undefined)
        delete jsonErrors[name]
    } catch {
        jsonErrors[name] = `${name}: 正しい JSON を入力してください。`
    }
}
watch(
    () => values.value.data,
    (current, previous) => {
        for (const [name, input] of Object.entries(jsonInputs))
            try {
                if (
                    snapshot(JSON.parse(input)) ===
                    snapshot(Object.entries(previous ?? {}).find(([key]) => key === name)?.[1])
                )
                    jsonInputs[name] = JSON.stringify(Object.entries(current).find(([key]) => key === name)?.[1]) ?? ''
            } catch {
                /* Keep invalid text available for correction. */
            }
    },
)
watch([locale, () => props.entryId], () => {
    for (const key of Object.keys(jsonInputs)) delete jsonInputs[key]
    for (const key of Object.keys(jsonErrors)) delete jsonErrors[key]
})
const submit = async () => {
    if (Object.keys(jsonErrors).length) return
    try {
        await save()
    } catch {}
}
</script>
<template>
    <section>
        <h2>{{ model.label }}</h2>
        <label v-if="model.locales"
            >言語
            <select v-model="locale" :disabled="Object.keys(jsonErrors).length > 0">
                <option v-for="language in model.locales.supported" :key="language">{{ language }}</option>
            </select></label
        >
        <form @submit.prevent="submit">
            <div v-for="[name, definition] in fields" :key="name">
                <label :for="`liti-${name}`">{{ definition.label ?? name }}</label
                ><label v-if="translated"
                    ><input
                        type="checkbox"
                        :checked="value(name) === undefined"
                        @change="set(name, '', ($event.target as HTMLInputElement).checked)"
                    />原文の値を使用</label
                ><RelationPicker
                    v-if="definition.reference"
                    :id="`liti-${name}`"
                    :model="definition.reference as ModelName"
                    :model-value="value(name) as string | undefined"
                    @update:model-value="set(name, $event)"
                /><input
                    v-else-if="fieldType(definition.schema) === 'boolean'"
                    :id="`liti-${name}`"
                    type="checkbox"
                    :checked="Boolean(value(name))"
                    @change="set(name, ($event.target as HTMLInputElement).checked)"
                /><input
                    v-else-if="fieldType(definition.schema) === 'number' || fieldType(definition.schema) === 'integer'"
                    :id="`liti-${name}`"
                    type="number"
                    :value="value(name) as number | undefined"
                    @input="set(name, Number(($event.target as HTMLInputElement).value))"
                /><input
                    v-else-if="fieldType(definition.schema) === 'string'"
                    :id="`liti-${name}`"
                    :value="value(name) as string | undefined"
                    @input="set(name, ($event.target as HTMLInputElement).value)"
                /><textarea
                    v-else
                    :id="`liti-${name}`"
                    :value="jsonInputs[name] ?? JSON.stringify(value(name))"
                    :aria-invalid="Boolean(jsonErrors[name])"
                    @input="setJson(name, ($event.target as HTMLTextAreaElement).value)"
                />
                <p v-if="jsonErrors[name]" role="alert">{{ jsonErrors[name] }}</p>
            </div>
            <label v-if="model.storage === 'content'" for="liti-body">本文</label
            ><textarea
                v-if="model.storage === 'content'"
                id="liti-body"
                :value="values.body ?? ''"
                :placeholder="translated ? '原文の本文を使用' : ''"
                @input="form.setFieldValue('body', ($event.target as HTMLTextAreaElement).value)"
            /><button v-if="translated" type="button" @click="form.setFieldValue('body', null)">原文の本文に戻す</button
            ><button type="submit">保存</button>
            <p aria-live="polite">{{ isDirty ? '未保存の変更があります' : receipt ? '保存済み' : '' }}</p>
            <p v-if="error" role="alert">{{ error instanceof Error ? error.message : String(error) }}</p>
            <p v-for="warning in warnings" :key="warning.code" role="status">{{ warning.message }}</p>
        </form>
        <p>公開・履歴は <a href="/_vitehub/content">Console</a> で確認できます。</p>
    </section>
</template>
