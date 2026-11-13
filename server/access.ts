import { bad } from './errors.ts'
import { body, flag, list, text } from './input.ts'
import type { Json, JsonObject } from './json.ts'

export interface DepartmentScope { path: (string | null)[]; descendants: boolean }
export interface AccessRule {
  staffNos: string[]; departments: DepartmentScope[]; employmentUnified: string[]; employmentLocal: string[]; posts: string[]
}
export interface AccessPolicy { enabled: boolean; staffBinding: string; allow: AccessRule[]; deny: AccessRule[] }
export interface StaffMember {
  staffNo: string; name: string; department: (string | null)[]; employmentUnified: string | null; employmentLocal: string | null; posts: string[]
}
export interface AccessDecision {
  allowed: boolean; reason: string; staffNo: string | null; rule: string | null; directoryVersion: number; policyVersion: number | null
}
export const disabledPolicy = (): AccessPolicy => ({ enabled: false, staffBinding: '', allow: [], deny: [] })

function strings(input: JsonObject, key: string): string[] {
  const values = list(input, key, key)
  if (values.length > 1000) throw bad('每个授权条件最多选择 1000 项')
  return [...new Set(values.map(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\x00-\x1f]/.test(value)) throw bad('授权条件必须是非空文本')
    return value.trim()
  }))]
}

export function validatePolicy(value: Json | undefined): AccessPolicy {
  if (value === undefined) return disabledPolicy()
  const input = body(value)
  const enabled = flag(input, 'enabled', '人员授权', false)
  const staffBinding = text({ staffBinding: input.staffBinding || '' }, 'staffBinding', '工号映射', { max: 63, optional: true })
  const rules = (key: string): AccessRule[] => {
    const values = list(input, key, key)
    if (values.length > 100) throw bad('允许和拒绝规则分别最多 100 组')
    return values.map(value => {
      const row = body(value)
      const departments = list(row, 'departments', '部门')
      if (departments.length > 1000) throw bad('每组最多选择 1000 个部门')
      const result: AccessRule = {
        staffNos: strings(row, 'staffNos'), employmentUnified: strings(row, 'employmentUnified'),
        employmentLocal: strings(row, 'employmentLocal'), posts: strings(row, 'posts'),
        departments: departments.map(value => {
          const scope = body(value), path = list(scope, 'path', '部门路径')
          if (!path.length || path.length > 4 || !path.at(-1) || path.some(p => p !== null && (typeof p !== 'string' || !p.trim() || p.length > 300))) throw bad('部门路径无效')
          return { path: path.map(p => typeof p === 'string' ? p.trim() : null), descendants: flag(scope, 'descendants', '包含下级', true) }
        }),
      }
      if (!Object.values(result).some(values => values.length)) throw bad('授权规则至少填写一个条件，空规则不能放行所有人')
      return result
    })
  }
  return { enabled, staffBinding, allow: rules('allow'), deny: rules('deny') }
}

export function matchesRule(person: StaffMember, rule: AccessRule): boolean {
  const selected = (values: string[], actual: string | null) => !values.length || actual !== null && values.includes(actual)
  let depth = person.department.length
  while (depth && person.department[depth - 1] === null) depth--
  return selected(rule.staffNos, person.staffNo) && selected(rule.employmentUnified, person.employmentUnified)
    && selected(rule.employmentLocal, person.employmentLocal)
    && (!rule.posts.length || rule.posts.some(post => person.posts.includes(post)))
    && (!rule.departments.length || rule.departments.some(scope =>
      scope.path.every((part, i) => person.department[i] === part) && (scope.descendants || depth === scope.path.length)))
}
