<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, navigateTo } from '#app'
import { useLitiModels } from '../composables/models'
import ModelEditor from './editor.vue'
const route = useRoute()
const { data, error } = await useLitiModels()
const selected = computed(() => data.value?.find((model) => model.name === route.query.model))
const entryId = computed(() => (typeof route.query.id === 'string' ? route.query.id : undefined))
</script>
<template>
    <main>
        <h1>モデルの翻訳と参照</h1>
        <p v-if="error" role="alert">ログインとモデルの管理権限が必要です。<a href="/_vitehub">Console を開く</a></p>
        <nav>
            <a
                v-for="model in data"
                :key="model.name"
                :href="`?model=${encodeURIComponent(model.name)}`"
                @click.prevent="navigateTo({ query: { model: model.name } })"
                >{{ model.label }}</a
            >
        </nav>
        <ModelEditor v-if="selected" :key="selected.name" :model="selected" :entry-id="entryId" />
    </main>
</template>
