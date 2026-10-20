<script setup lang="ts">
const { data } = await useLitiQuery('posts', { view: 'current', locale: 'en' })
</script>

<template>
    <ul>
        <li v-for="item in data" :key="item.id" data-admin-entry>{{ item.data.title }}</li>
    </ul>
</template>
