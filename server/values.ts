import { createHash } from 'node:crypto'
import { bad } from './errors.ts'
import { canonicalDecimal, isObject, numberFromText, type Json } from './json.ts'

export const FIELD_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime'] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export interface Field { name: string; type: FieldType; required: boolean }

const INT64_MAX = 2n ** 63n - 1n
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i

function numericText(value: Json): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (JSON.isRawJSON(value)) return value.rawJSON
  if (typeof value === 'string') return value.trim()
  return undefined
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Datetimes with an offset are normalised to UTC ("Z"); without one they stay local. */
function canonicalDatetime(text: string): string | undefined {
  const m = DATETIME.exec(text.trim())
  if (!m) return undefined
  const [year, month, day, hour, minute, second = 0] = m.slice(1, 7).map(part => part === undefined ? undefined : Number(part)) as number[]
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return undefined
  const fraction = (m[7] ?? '').replace(/0+$/, '')
  const suffix = fraction ? `.${fraction}` : ''
  const offset = m[8]
  if (!offset) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(second).padStart(2, '0')}${suffix}`
  let offsetMinutes = 0
  if (offset.toUpperCase() !== 'Z') {
    const digits = offset.slice(1).replace(':', '')
    offsetMinutes = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0)) * (offset[0] === '-' ? -1 : 1)
  }
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000)
  return `${utc.toISOString().slice(0, 19)}${suffix}Z`
}

/** Converts a value to the canonical form of a field type; throws 400 when it does not fit. */
export function convert(value: Json, type: FieldType, name: string): Json {
  const invalid = () => bad(`${name} 不是有效的 ${type} 值`)
  const text = numericText(value)
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (JSON.isRawJSON(value)) return value.rawJSON
      throw invalid()
    case 'integer': {
      if (!text || !/^[+-]?\d+$/.test(text)) throw invalid()
      const canonical = canonicalDecimal(text)!
      const big = BigInt(canonical)
      if (big > INT64_MAX || big < -INT64_MAX - 1n) throw invalid()
      return numberFromText(canonical)
    }
    case 'decimal': {
      const canonical = text && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? canonicalDecimal(text) : undefined
      if (!canonical) throw invalid()
      return numberFromText(canonical)
    }
    case 'boolean':
      if (value === true || value === 'true') return true
      if (value === false || value === 'false') return false
      throw invalid()
    case 'date': {
      const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null
      if (!m || !validDate(Number(m[1]), Number(m[2]), Number(m[3]))) throw invalid()
      return m[0]
    }
    case 'datetime': {
      const canonical = typeof value === 'string' ? canonicalDatetime(value) : undefined
      if (!canonical) throw invalid()
      return canonical
    }
  }
}

/** Like convert, but null/absent (and blank text for non-string types) become null. */
export function convertOptional(value: Json | undefined, field: Field): Json {
  if (value === undefined || value === null) return null
  if (field.type !== 'string' && typeof value === 'string' && value.trim() === '') return null
  return convert(value, field.type, field.name)
}

/** Equal values of the same type share one identity string; numbers compare by value. */
export function identity(value: Json): string {
  const tag = (item: Json): unknown => {
    if (typeof item === 'number' || JSON.isRawJSON(item)) {
      const text = typeof item === 'number' ? String(item) : item.rawJSON
      return { n: canonicalDecimal(text) ?? text }
    }
    if (Array.isArray(item)) return item.map(tag)
    if (isObject(item)) return Object.keys(item).sort().map(key => [key, tag(item[key])])
    return item
  }
  return JSON.stringify(tag(value))
}

export function rowKey(row: Record<string, Json>, fields: string[]): string {
  const values = fields.map(field => {
    const value = row[field]
    if (value === undefined || value === null) throw bad(`唯一键字段 ${field} 缺失或为空`)
    return value
  })
  return createHash('sha256').update(identity(values)).digest('hex')
}
