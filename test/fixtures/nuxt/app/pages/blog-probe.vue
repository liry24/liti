<script setup lang="ts">
const handle = useLitiForm('articles')
const {
    blog: { review, proofread },
    field,
} = handle
const content = field('content')
const ready = await handle
const same = ready.blog.review === review && ready.blog.proofread === proofread
</script>

<template>
    <div>
        <span id="blog-stable">{{ same }}</span>
        <span id="blog-availability">{{ review.availability }}</span>
        <span id="blog-status">{{ review.status }}</span>
        <span id="blog-content">{{ content.value }}</span>
    </div>
</template>
