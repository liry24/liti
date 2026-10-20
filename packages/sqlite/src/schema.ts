import type { LitiConfig } from 'liti/adapter'
import { contentTableName, fieldStorage, validateContentNames } from './model'

export interface SqliteColumn {
    name: string
    type: 'text' | 'integer' | 'real'
    notNull?: boolean
    primary?: boolean
    mode?: 'json' | 'boolean'
    default?: string | number
    references?: { table: string; column: string; onDelete: 'cascade' | 'restrict' }
}

export interface SqliteTable {
    name: string
    columns: Record<string, SqliteColumn>
    primaryKey?: string[]
    indexes?: Array<{ name: string; columns: string[]; unique?: boolean; where?: string }>
}

const text = (name: string, required = false): SqliteColumn => ({ name, type: 'text', notNull: required })
const integer = (name: string): SqliteColumn => ({ name, type: 'integer', notNull: true })
const primary = (name: string): SqliteColumn => ({ ...text(name), primary: true })
const reference = (name: string, table: string, onDelete: 'cascade' | 'restrict' = 'cascade'): SqliteColumn => ({
    ...text(name, true),
    references: { table, column: 'id', onDelete },
})
const locale = (): SqliteColumn => ({ ...text('locale', true), default: '' })
const revision = (): SqliteColumn => reference('revision_id', 'revisions')

/** One physical plan feeds all supported SQLite emitters and runtime compatibility checks. */
export const baseSchema: Record<string, SqliteTable> = {
    entries: {
        name: 'liti_entries',
        columns: {
            id: primary('id'),
            model: text('model', true),
            default_locale: { ...text('default_locale', true), default: '' },
            current_revision_id: text('current_revision_id'),
            published_revision_id: text('published_revision_id'),
            scheduled_revision_id: text('scheduled_revision_id'),
            scheduled_at: text('scheduled_at'),
            sort_order: { name: 'sort_order', type: 'real' },
            version: { ...integer('version'), default: 0 },
            created_at: text('created_at', true),
            updated_at: text('updated_at', true),
            published_at: text('published_at'),
            first_published_at: text('first_published_at'),
        },
        indexes: [
            { name: 'liti_entries_model', columns: ['model'] },
            { name: 'liti_entries_schedule', columns: ['scheduled_at'], where: 'scheduled_revision_id IS NOT NULL' },
        ],
    },
    revisions: {
        name: 'liti_revisions',
        columns: {
            id: primary('id'),
            entry_id: reference('entry_id', 'entries'),
            actor_id: text('actor_id'),
            created_at: text('created_at', true),
        },
        indexes: [{ name: 'liti_revisions_entry', columns: ['entry_id', 'created_at'] }],
    },
    assets: {
        name: 'liti_assets',
        columns: {
            id: primary('id'),
            storage: text('storage', true),
            key: text('key', true),
            content_type: text('content_type', true),
            size: integer('size'),
            checksum: text('checksum'),
            metadata: { ...text('metadata', true), default: '{}' },
            state: text('state', true),
            operation_token: text('operation_token'),
            lease_expires_at: text('lease_expires_at'),
            created_at: text('created_at', true),
            updated_at: text('updated_at', true),
        },
        indexes: [
            { name: 'liti_assets_key', columns: ['storage', 'key'], unique: true },
            { name: 'liti_assets_gc', columns: ['state', 'created_at'] },
        ],
    },
    relations: {
        name: 'liti_relations',
        columns: {
            revision_id: revision(),
            locale: locale(),
            field_path: text('field_path', true),
            target_entry_id: reference('target_entry_id', 'entries', 'restrict'),
            position: integer('position'),
            required: integer('required'),
        },
        primaryKey: ['revision_id', 'locale', 'field_path', 'position'],
        indexes: [{ name: 'liti_relations_target', columns: ['target_entry_id'] }],
    },
    assetRefs: {
        name: 'liti_asset_refs',
        columns: {
            revision_id: revision(),
            locale: locale(),
            field_path: text('field_path', true),
            asset_id: reference('asset_id', 'assets', 'restrict'),
            position: integer('position'),
        },
        primaryKey: ['revision_id', 'locale', 'field_path', 'position'],
        indexes: [{ name: 'liti_asset_refs_asset', columns: ['asset_id'] }],
    },
    routes: {
        name: 'liti_routes',
        columns: {
            path: text('path', true),
            locale: locale(),
            entry_id: reference('entry_id', 'entries'),
            revision_id: { ...revision(), notNull: false },
            kind: text('kind', true),
            target_path: text('target_path'),
            status: { name: 'status', type: 'integer' },
            created_at: text('created_at', true),
        },
        primaryKey: ['locale', 'path'],
        indexes: [{ name: 'liti_routes_entry', columns: ['entry_id'] }],
    },
    meta: { name: 'liti_meta', columns: { key: primary('key'), value: text('value', true) } },
    translations: {
        name: 'liti_translations',
        columns: {
            revision_id: revision(),
            locale: text('locale', true),
            data: { ...text('data', true), mode: 'json' },
        },
        primaryKey: ['revision_id', 'locale'],
    },
    search: {
        name: 'liti_search',
        columns: {
            revision_id: revision(),
            locale: text('locale', true),
            part: integer('part'),
            value: text('value', true),
        },
        primaryKey: ['revision_id', 'locale', 'part'],
    },
}

export const physicalSchema = (config: LitiConfig): Record<string, SqliteTable> => {
    validateContentNames(config)
    return {
        ...baseSchema,
        ...Object.fromEntries(
            Object.entries(config.models).map(([name, model]) => [
                `content_${Array.from(new TextEncoder().encode(name), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
                {
                    name: contentTableName(name),
                    columns: {
                        revisionId: { ...revision(), notNull: false, primary: true },
                        ...Object.fromEntries(
                            Object.entries(model.fields).map(([key, field]) => {
                                const storage = fieldStorage(field)
                                return [
                                    key,
                                    {
                                        name: `field_${key}`,
                                        type: storage === 'json' ? 'text' : storage === 'boolean' ? 'integer' : storage,
                                        notNull: Boolean(field.required),
                                        ...(storage === 'json' || storage === 'boolean' ? { mode: storage } : {}),
                                    } satisfies SqliteColumn,
                                ]
                            }),
                        ),
                    },
                } satisfies SqliteTable,
            ]),
        ),
    }
}

export { contentTableName, fieldStorage, validateContentNames } from './model'
