import { defineAgent } from 'vite-hub/agent'
export default defineAgent({
    runtime: false,
    capabilities: [],
    driver: {
        run: () => {
            throw new Error('SERVER_ONLY_AGENT_MARKER')
        },
    },
})
