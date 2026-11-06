<script setup lang="ts">
const route = useRoute()
const locale = ref('ja')
const { form, save, receipt, isDirty, hasUnsavedChanges, values, error, warnings } = await useLitiForm('posts', {
    id: () => String(route.query.id),
    locale,
})
if (false) {
    const title: string | undefined = values.value.data.title
    // @ts-expect-error Form fields come from the model definition.
    console.log(values.value.data.absentField)
    console.log(title)
}
const saveNow = async () => {
    try {
        await save()
    } catch {}
}
onMounted(() => {
    document.documentElement.dataset.hydrated = 'true'
})
</script>
<template>
    <main>
        <form.Field name="data.title" v-slot="{ field }"
            ><label
                >Title<input
                    id="title"
                    :value="field.value"
                    @input="field.handleChange(($event.target as HTMLInputElement).value)" /></label></form.Field
        ><button id="save" @click="saveNow">Save</button
        ><button id="locale" @click="locale = locale === 'ja' ? 'en' : 'ja'">Locale</button>
        <p id="dirty">{{ isDirty }}</p>
        <p id="unsaved">{{ hasUnsavedChanges }}</p>
        <p id="receipt">{{ receipt?.digest }}</p>
        <p id="error">{{ error }}</p>
        <p id="warnings">{{ warnings.length }}</p>
    </main>
</template>
