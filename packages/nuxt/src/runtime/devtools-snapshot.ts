import { defineEventHandler } from 'nuxt/server'
import { LitiError } from '../../../liti/src/errors'
import type { FieldDescriptor } from '../../../liti/src/descriptor'
import { useLitiRuntime } from '../nuxt/server'
import { withLitiContext } from './context'

const fields = (source: Record<string, FieldDescriptor>): unknown =>
    Object.fromEntries(
        Object.entries(source).map(([name, field]) => [
            name,
            {
                kind: field.kind,
                required: field.required,
                relation: field.model,
                ...(field.fields ? { fields: fields(field.fields) } : {}),
                ...(field.item ? { item: fields({ item: field.item }) } : {}),
            },
        ]),
    )

export default defineEventHandler((event) =>
    withLitiContext(event.context, async () => {
        const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
        let authorized = false
        try {
            const { getLiti, development } = useLitiRuntime()
            const liti = await getLiti(event)
            const actor = await liti.authorizeRequest(event.req, event)
            liti.assertPermission(actor, 'system', 'diagnostics')
            authorized = true
            const descriptor = liti.descriptorFor(actor)
            const models = Object.fromEntries(
                Object.entries(descriptor.models).map(([name, model]) => [
                    name,
                    {
                        ...model,
                        localized: Object.values(liti.config.models[name]?.fields ?? {}).some((field) => field.i18n),
                        fields: fields(model.fields),
                    },
                ]),
            )
            const [inspection, routes, entries] = await Promise.all([
                liti.inspect(),
                liti.routeSnapshot(),
                liti.listEntries(),
            ])
            const allowed = new Set(Object.keys(models))
            return Response.json(
                {
                    models,
                    database: { ...development, schemaReady: true },
                    assets: {
                        ...inspection.assets,
                        orphanCount: inspection.orphanAssets,
                        storage: liti.config.assets?.storage,
                        cleanup: { minimumAge: liti.config.assets?.cleanup?.minimumAge ?? 86400 },
                        operationLeaseSeconds: liti.config.assets?.operationLeaseSeconds ?? 900,
                    },
                    routes: routes.filter((route) =>
                        entries.some((entry) => allowed.has(entry.model) && entry.id === route.entryId),
                    ),
                    revisions: entries
                        .filter((entry) => allowed.has(entry.model))
                        .map((entry) => ({
                            id: entry.id,
                            model: entry.model,
                            locale: entry.locale,
                            current: entry.currentRevisionId,
                            published: entry.publishedRevisionId,
                            scheduled: entry.scheduledRevisionId,
                        })),
                    diagnostics: [...new Set(inspection.diagnostics.map((item) => item.code))].map((code) => ({
                        code,
                        hint: 'Check the current Model definition, field validation and referenced entries/assets.',
                    })),
                },
                { headers },
            )
        } catch (error) {
            if (authorized && error instanceof LitiError && error.code === 'LITI_MIGRATION_REQUIRED') {
                return Response.json(
                    {
                        database: { ...useLitiRuntime().development, schemaReady: false },
                        diagnostics: [
                            {
                                code: error.code,
                                hint: 'Run liti generate, review drizzle-kit generate output and explicitly apply the migrations.',
                            },
                        ],
                    },
                    { headers },
                )
            }
            return Response.json(
                { error: error instanceof LitiError ? error.code : 'LITI_INSPECTION_FAILED' },
                { status: error instanceof LitiError ? error.status : 500, headers },
            )
        }
    }),
)
