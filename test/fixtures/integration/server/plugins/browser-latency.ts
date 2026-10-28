export default defineNitroPlugin((nitro) => {
    nitro.hooks.hook('request', async (event) => {
        if (
            event.method === 'GET' &&
            event.path.split('?')[0] === '/api/_liti' &&
            String(getQuery(event).id).startsWith('slow-')
        )
            await new Promise((done) => setTimeout(done, 300))
        if (event.method !== 'POST' || event.path !== '/api/_liti/manage') return
        const input = await readBody<{ action?: string; data?: { title?: string } }>(event)
        if (input?.action === 'save' && input.data?.title === 'Submitted browser')
            await new Promise((done) => setTimeout(done, 350))
    })
})
