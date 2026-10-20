import { voidAdapter } from '@litijs/void'
import { defineLitiConfig, text } from 'liti'

export default defineLitiConfig({
    adapter: voidAdapter(),
    models: { posts: { fields: { slug: text(), title: text({ required: true }) } } },
    tasks: { publishDue: '* * * * *', syncAssets: true },
})
