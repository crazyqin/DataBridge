import { HttpError } from './errors.ts'
import { parse, type Json, type JsonObject } from './json.ts'
import { convertOptional, identity, type Field } from './values.ts'

// Helpers for stored rows (snapshot and manual data), shared by the main thread and the row worker.

export const REMARK_FIELD = '__databridge_remark'

/** Filter key of a missing or null value; matched by a filter whose value is empty. */
export const NULL_KEY = ''
/** Filter key of a value that does not convert to the field type; it never matches. */
const INVALID_KEY = '!'

/** An equality filter of an open call: rows match when their filter key equals key. */
export interface RowFilter { name: string; field: Field; key: string }

/** Identifies what an api_row_filter index was built for; a changed filter field or type makes it stale. */
export function filterSignature(fields: Field[], filters: string[]): string {
  return JSON.stringify(filters.map(name => [name, fields.find(field => field.name === name)?.type ?? null]))
}

/** Values that are equal under the field type share one key ("1.50" and 1.5 for a decimal). */
export function filterKey(value: Json | undefined, field: Field): string {
  if (value === undefined || value === null) return NULL_KEY
  try {
    return identity(convertOptional(value, field))
  } catch {
    return INVALID_KEY
  }
}

export function rowMatches(row: JsonObject, filters: RowFilter[]): boolean {
  return filters.every(filter => filterKey(Object.hasOwn(row, filter.name) ? row[filter.name] : undefined, filter.field) === filter.key)
}

/** Stored row JSON with the platform remark appended, without parsing and re-serialising the row. */
export function rowText(data: string, remark: string): string {
  if (!remark) return data
  if (data.includes(`"${REMARK_FIELD}"`) && Object.hasOwn(parse(data) as JsonObject, REMARK_FIELD)) {
    throw new HttpError(422, `数据字段 ${REMARK_FIELD} 与平台备注冲突`)
  }
  const field = `"${REMARK_FIELD}":${JSON.stringify(remark)}`
  const body = data.trim()
  return /^\{\s*\}$/.test(body) ? `{${field}}` : `${body.slice(0, -1)},${field}}`
}
