<script setup lang="ts">
const list = await useLitiQuery('posts', { locale: 'en', markdown: 'summary' })
const batch = await useLitiQuery('posts', { mode: 'many', locale: 'en', markdown: 'summary' })
const listData = list.data
const batchData = batch.data
</script>

<template>
    <div>
        <span id="summary-nodes">{{ JSON.stringify(listData?.[0]?.data.body?.nodes) }}</span>
        <span id="summary-batch-nodes">{{ JSON.stringify(batchData?.[0]?.data.body?.nodes) }}</span>
    </div>
</template>
