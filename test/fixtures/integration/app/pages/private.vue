<script setup lang="ts">
const route = useRoute()
const { values, error } = await useLitiForm('memos', { id: () => String(route.query.id) })
</script>
<template>
    <main>
        <p id="private-secret">{{ values.data.secret }}</p>
        <p v-if="error">Access rejected</p>
    </main>
</template>
