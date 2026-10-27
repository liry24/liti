import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installDependencies } from 'nypm'
import { consumerPackages, archiveDependencies, archiveOverrides } from './consumer-packages.mjs'

const manager = process.env.LITI_PACKAGE_MANAGER ?? 'bun'
assert.ok(['bun', 'npm', 'pnpm'].includes(manager))
const directory = await mkdtemp(join(tmpdir(), `liti-isolated-${manager}-`))
const run = (command, args, cwd = directory) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
    return result.stdout
}
const archives = await consumerPackages(directory, run)
for (const profile of ['model', 'blog', 'vue']) {
    const cwd = join(directory, `consumer-${profile}`)
    await mkdir(cwd)
    const names = profile === 'model' ? ['@litijs/model'] : ['@litijs/model', '@litijs/blog']
    const dependencies = {
        ...archiveDependencies(archives, names),
        zod: '4.6.7',
        ...(profile === 'vue' ? { vue: '3.5.44' } : {}),
    }
    const manifest = {
        name: `isolated-${profile}`,
        private: true,
        type: 'module',
        packageManager: manager === 'bun' ? 'bun@1.4.4' : manager === 'pnpm' ? 'pnpm@10.25.0' : 'npm@11.19.1',
        dependencies,
        devDependencies: { typescript: '6.0.3', '@types/node': '26.6.5' },
        ...archiveOverrides(archives, manager),
    }
    await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest, null, 2))
    await installDependencies({ cwd, packageManager: manager })
    await writeFile(
        join(cwd, 'check.mjs'),
        `
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
registerHooks({resolve(specifier,context,next) {
    if (/^(?:nuxt|ai|vite-hub)(?:\\/|$)|^@(?:ai-sdk|vite-hub\\/agent)(?:\\/|$)/u.test(specifier) || (${JSON.stringify(profile)} !== 'vue' && /^(?:vue|@vue)(?:\\/|$)/u.test(specifier))) throw new Error('Unexpected optional integration: '+specifier)
    return next(specifier,context)
}})
globalThis.fetch=async()=>{throw new Error('ISOLATED_NETWORK_DISABLED')}
const {field,defineContentModel,validateData}=await import('@litijs/model')
const {z}=await import('zod')
const model=defineContentModel({name:'notes', fields:{title:field(z.string().min(1))}, authorize:()=>false})
assert.deepEqual(await validateData(model.fields,{title:'Standalone'}),{title:'Standalone'})
await assert.rejects(validateData(model.fields,{title:''}))
${
    profile !== 'model'
        ? `
const blog=await import('@litijs/blog')
const article=blog.defineArticle({name:'articles',authorize:()=>false})
assert.equal((await article.prepare({data:{title:'日本語の記事'}},{action:'save',id:'stable-id',locale:'und',actor:{id:'writer'},previous:null})).data.slug,'日本語の記事-stable-id')
assert.equal(await blog.validateProofreading(${JSON.stringify('Original. `code`')},${JSON.stringify('Reviewed. `code`')}),true)
assert.equal(await blog.validateProofreading(${JSON.stringify('Original. `code`')},${JSON.stringify('Reviewed. `changed`')}),false)
`
        : ''
}
${
    profile === 'vue'
        ? `
const {createSSRApp,h}=await import('vue')
const {renderToString}=await import('vue/server-renderer')
const {ArticleDate}=await import('@litijs/blog/vue')
const html=await renderToString(createSSRApp(()=>h(ArticleDate,{entry:{data:{authoredAt:'2020-01-02'},publication:null},locale:'en'})))
assert.ok(html.includes('datetime="2020-01-02"'))
`
        : ''
}
console.log('PASS isolated ${manager} ${profile}: no Nuxt/Agent/provider import or network execution')
`,
    )
    console.log(run(process.execPath, ['check.mjs'], cwd))
    await writeFile(
        join(cwd, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                target: 'ES2024',
                strict: true,
                skipLibCheck: false,
                noEmit: true,
            },
            include: ['check.ts'],
        }),
    )
    await writeFile(
        join(cwd, 'check.ts'),
        `import {defineContentModel,field,type ModelData} from '@litijs/model';import {z} from 'zod';
const notes=defineContentModel({name:'notes',fields:{title:field(z.string())},authorize:()=>false});
const valid:ModelData<typeof notes>={title:'Typed'};void valid;
// @ts-expect-error inferred required field
const invalid:ModelData<typeof notes>={title:42};void invalid;
${profile !== 'model' ? `import {defineArticle} from '@litijs/blog';const article=defineArticle({name:'articles',authorize:()=>false});const title: string = (null as unknown as ModelData<typeof article>).title;void title;` : ''}
`,
    )
    console.log(run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], cwd))
    console.log(`PASS isolated ${manager} ${profile} strict declarations`)
    assert.equal(
        await readFile(join(cwd, 'package.json'), 'utf8'),
        JSON.stringify(manifest, null, 2),
        'Import/typecheck must not rewrite consumer settings',
    )
}
