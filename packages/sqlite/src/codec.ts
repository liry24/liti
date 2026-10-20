import type { LitiConfig } from 'liti/adapter'
import { contentTableName, fieldStorage } from './model'

/** SQL-only projection; content is stored in typed columns, never a second JSON document. */
export const revisionSource = (config: LitiConfig): string => {
    const branches = Object.entries(config.models).map(([name, model]) => {
        const pairs = Object.entries(model.fields).map(([key, field]) => {
            const column = `d.${JSON.stringify(`field_${key}`)}`,
                storage = fieldStorage(field)
            const value =
                storage === 'json'
                    ? column
                    : storage === 'boolean'
                      ? `CASE WHEN ${column}=1 THEN 'true' ELSE 'false' END`
                      : `json_quote(${column})`
            return `('${key.replaceAll("'", "''")}', CASE WHEN ${column} IS NULL THEN NULL ELSE ${value} END)`
        })
        const data = pairs.length
            ? `(SELECT json_group_object(column1,json(column2)) FROM (VALUES ${pairs.join(',')}) WHERE column2 IS NOT NULL)`
            : "'{}'"
        return `WHEN '${name.replaceAll("'", "''")}' THEN (SELECT ${data} FROM ${JSON.stringify(contentTableName(name))} d WHERE d.revision_id=r.id)`
    })
    // VALUES and CASE avoid compound-SELECT limits and keep reads independent of entry count.
    // shortcut: SQL size grows with Model/field count; split by Model if the platform SQL-size ceiling is reached.
    return branches.length
        ? `(SELECT r.*, CASE e.model ${branches.join(' ')} END AS data FROM liti_revisions r JOIN liti_entries e ON e.id=r.entry_id WHERE e.model IN (${Object.keys(
              config.models,
          )
              .map((name) => `'${name.replaceAll("'", "''")}'`)
              .join(',')}))`
        : "(SELECT r.*, '{}' AS data FROM liti_revisions r WHERE 0)"
}
