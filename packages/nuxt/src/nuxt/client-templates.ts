import { normalize } from 'pathe'

export interface LitiClientTemplateOptions {
    basePath: string
    managementBase: string
    defaultLocale?: string
    i18n?: boolean
    origin?: string
    auth?: boolean
    aiActions?: boolean
}

/** Generated code contains connection settings, native factory macros and exports only. */
export const litiNuxtClientTemplate = (options: LitiClientTemplateOptions): string => `
import { createUseAsyncData } from '#app/composables/asyncData'
import { createUseFetch } from '#app/composables/fetch'
import { createLitiComposables, litiAiFetchOptions } from 'liti/internal/runtime/composables'
${options.auth ? "import { useUserSession } from '#imports'" : ''}
export const litiAsyncData = createUseAsyncData()
export const litiAiFetch = createUseFetch(litiAiFetchOptions)
const composables = createLitiComposables(${JSON.stringify(options)}, litiAsyncData, litiAiFetch${options.auth ? ', useUserSession' : ''})
export const { useLitiQuery, ${options.aiActions ? 'useAi, ' : ''}litiPublicClientOptions, litiManagementClientOptions, useLitiRoute, litiAttachAsyncData, useLitiAuthScope, litiManagementKey, createNuxtLitiManagementClient, useLitiModels, litiReadModels, useLitiForm } = composables
export type { UseAiOptions, LitiModelOptions, LitiFormOptions, LitiLocaleOptions, LitiBatchRequest, LitiBatchResult } from 'liti/internal/runtime/composables'
`

/** A config path is used only by TypeScript; the app never loads its runtime code. */
export const litiNuxtModelTypes = (
    configPath: string,
    environments: readonly string[] = [],
): string => `import 'liti/client'
import type { InferLitiModels, InferLitiMeta, InferLitiFormModels, InferLitiNamedAiActions, InferLitiPublicModels, ResolvedLitiConfig } from 'liti'
import type { EntryPrepareContext } from 'liti'

declare module '#app' {
  interface RuntimeNuxtHooks {
    'liti:entry:prepare': (context: EntryPrepareContext) => void | Promise<void>
  }
}

type LitiDomainConfig = ResolvedLitiConfig<typeof import(${JSON.stringify(normalize(configPath))}).default, readonly [${environments.map((environment) => JSON.stringify(environment)).join(', ')}]>

declare module 'liti/client' {
  interface LitiClientRegistry {
    managementModels: InferLitiModels<LitiDomainConfig>
    formModels: InferLitiFormModels<LitiDomainConfig>
    modelMeta: InferLitiMeta<LitiDomainConfig>
    namedAiActions: InferLitiNamedAiActions<LitiDomainConfig>
    publicModels: InferLitiPublicModels<LitiDomainConfig>
    publicSummaryModels: InferLitiPublicModels<LitiDomainConfig, 'summary'>
  }
}
export {}
`

export interface LitiSeoTemplateOptions {
    ogImage: boolean
    seo?: boolean
}

/** Only native OG component types and the optional import are generated. */
export const litiNuxtSeoTemplate = (
    options: LitiSeoTemplateOptions,
): string => `import { createSeoMetadata } from 'liti/internal/runtime/seo'
${options.ogImage ? "import { defineOgImage } from '#imports'" : ''}
${
    options.ogImage
        ? `type NativeOgImage = {
  component: Parameters<typeof defineOgImage>[0]
  props?: Parameters<typeof defineOgImage>[1]
  options?: Parameters<typeof defineOgImage>[2]
}`
        : ''
}
export const useLitiSeoMetadata = createSeoMetadata${options.ogImage ? '<NativeOgImage>' : ''}({
  seo: ${options.seo !== false},
  ${options.ogImage ? 'generateImage: image => { defineOgImage(image.component, image.props, image.options) },' : ''}
})
`
