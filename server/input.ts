import { bad } from './errors.ts'
import { isObject, type Json, type JsonObject } from './json.ts'

// Strict readers for JSON request bodies: wrong types are rejected rather than coerced.

export function body(value: Json): JsonObject {
  if (!isObject(value)) throw bad('请求体必须是 JSON 对象')
  return value
}

export function text(input: JsonObject, key: string, label: string, options: { max: number; optional?: boolean; pattern?: RegExp }): string {
  const value = input[key]
  if ((value === undefined || value === null || value === '') && options.optional) return ''
  if (typeof value !== 'string' || !value.trim()) throw bad(`请填写${label}`)
  const trimmed = value.trim()
  if (trimmed.length > options.max) throw bad(`${label}不能超过 ${options.max} 个字符`)
  if (options.pattern && !options.pattern.test(trimmed)) throw bad(`${label}格式不正确`)
  return trimmed
}

export function flag(input: JsonObject, key: string, label: string, fallback: boolean): boolean {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw bad(`${label}必须是布尔值`)
  return value
}

export function integer(input: JsonObject, key: string, label: string, min: number, max: number, fallback?: number): number {
  const value = input[key]
  if ((value === undefined || value === null) && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw bad(`${label}必须是 ${min} 到 ${max} 之间的整数`)
  }
  return value
}

export function choice<T extends string>(input: JsonObject, key: string, label: string, options: readonly T[], fallback?: T): T {
  const value = input[key]
  if ((value === undefined || value === null) && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !options.includes(value as T)) throw bad(`${label}必须是 ${options.join(' / ')} 之一`)
  return value as T
}

export function list(input: JsonObject, key: string, label: string): Json[] {
  const value = input[key]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw bad(`${label}必须是数组`)
  return value
}

export function names(input: JsonObject, key: string, label: string): string[] {
  const values = list(input, key, label)
  if (values.some(value => typeof value !== 'string' || !NAME.test(value))) throw bad(`${label}包含无效的字段名`)
  if (new Set(values).size !== values.length) throw bad(`${label}包含重复的字段名`)
  return values as string[]
}

export const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

export function id(value: string | undefined): number {
  if (!value || !/^\d{1,15}$/.test(value)) throw bad('ID 无效')
  return Number(value)
}
