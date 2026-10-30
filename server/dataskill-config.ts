import { bad } from './errors.ts'
import { body, flag, integer, text } from './input.ts'
import type { Json } from './json.ts'

export interface DataSkillConfig {
  baseUrl: string
  serviceToken: string
  authConnectionId: number
  staffCodeBinding: string
  identityProvider: string
  enabled: boolean
}

export function validateDataSkill(value: Json | undefined, previous?: DataSkillConfig): DataSkillConfig {
  const input = body(value ?? null)
  const baseUrl = text(input, 'baseUrl', 'Studio 根地址', { max: 2000 }).replace(/\/+$/, '')
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch { throw bad('Studio 根地址必须是 HTTP(S) 地址，不能包含凭据、查询参数或片段') }
  const tokenInput = input.serviceToken
  // Editing other settings never clears or returns the saved credential.
  const serviceToken = tokenInput === undefined || tokenInput === '' ? previous?.serviceToken : tokenInput
  if (typeof serviceToken !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(serviceToken)) {
    throw bad('Studio 服务凭据需为 32 到 4096 个可打印字符，新建时必须填写')
  }
  return {
    baseUrl, serviceToken,
    authConnectionId: integer(input, 'authConnectionId', 'UAP 身份服务连接', 1, Number.MAX_SAFE_INTEGER),
    staffCodeBinding: text(input, 'staffCodeBinding', '工号映射', { max: 63 }),
    identityProvider: text(input, 'identityProvider', '身份服务标识', { max: 64 }),
    enabled: flag(input, 'enabled', '启用反馈入口', false),
  }
}
