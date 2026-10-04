import { bad, HttpError, unauthorized } from './errors.ts'
import { body as object, choice, integer, list, NAME, text } from './input.ts'
import { isObject, parse, stringify, type Json, type JsonObject } from './json.ts'
import { convert, FIELD_TYPES, identity, type FieldType } from './values.ts'

export const AUTH_PARAM_PREFIX = '_auth_'
export const TEST_CREDENTIAL_HEADER = 'X-DataBridge-Test-Credential'
export type QueryIdentity = Record<string, Json>
export interface AuthBinding { name: string; path: string; type: FieldType }
export interface ExternalAuthConfig {
  url: string
  method: 'GET' | 'POST'
  inputHeader: string
  inputPrefix: string
  tokenLocation: 'header' | 'json' | 'form'
  tokenName: string
  tokenPrefix: string
  headers: Record<string, string>
  body: JsonObject
  successStatus: number
  successPath: string
  successValue: Json
  bindings: AuthBinding[]
  timeoutSeconds: number
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive'])
const MAX_RESPONSE_BYTES = 64 * 1024

function headerName(value: string): string {
  if (!HEADER_NAME.test(value) || HOP_HEADERS.has(value.toLowerCase())) throw bad('凭证或附加 Header 名称无效')
  return value
}

function prefix(input: JsonObject, key: string): string {
  const value = input[key] ?? ''
  if (typeof value !== 'string' || value.length > 100 || /[^\x20-\x7e]/.test(value)) throw bad('凭证前缀必须是不超过 100 字符的可打印 ASCII 文本')
  return value
}

function fieldPath(value: string): string {
  if (!value || value.length > 500 || /[\x00-\x1f\x7f]/.test(value) || value.split('.').some(part => !part)) {
    throw bad('响应字段路径无效，请使用 data.user.id 这样的点分路径')
  }
  return value
}

/** Only explicit own properties are traversed; dotted numeric components also work for arrays. */
function readPath(value: Json, path: string): Json | undefined {
  let current: Json | undefined = value
  for (const key of path.split('.')) {
    if ((!isObject(current) && !Array.isArray(current)) || !Object.hasOwn(current, key)) return undefined
    current = (current as JsonObject)[key]
  }
  return current
}

export function validateExternalAuth(value: Json | undefined): ExternalAuthConfig {
  const input = object(value ?? null)
  const url = text(input, 'url', '验证地址', { max: 2000 })
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error()
  } catch {
    throw bad('验证地址必须是 HTTP(S) 地址，不能包含用户名、密码或片段')
  }
  const method = choice(input, 'method', '验证请求方式', ['GET', 'POST'] as const, 'POST')
  const tokenLocation = choice(input, 'tokenLocation', '凭证传递位置', ['header', 'json', 'form'] as const, 'header')
  if (method === 'GET' && tokenLocation !== 'header') throw bad('GET 验证请求需通过 Header 传递凭证')
  const inputHeader = headerName(text({ inputHeader: input.inputHeader ?? 'Authorization' }, 'inputHeader', '来源 Header', { max: 100 }))
  const tokenName = text({ tokenName: input.tokenName ?? 'Authorization' }, 'tokenName', '目标凭证名称', { max: 100 })
  if (tokenLocation === 'header') headerName(tokenName)
  else if (!NAME.test(tokenName)) throw bad('凭证字段名无效')
  const headers = object(input.headers ?? {})
  if (Object.keys(headers).length > 20) throw bad('附加 Header 最多 20 个')
  const normalizedHeaders: Record<string, string> = Object.create(null)
  for (const [name, value] of Object.entries(headers)) {
    const lower = headerName(name).toLowerCase()
    if (Object.hasOwn(normalizedHeaders, lower)) throw bad('附加 Header 名称重复')
    if (typeof value !== 'string' || value.length > 4096 || /[^\x20-\x7e]/.test(value)) throw bad('附加 Header 值必须是可打印 ASCII 文本')
    normalizedHeaders[lower] = value
  }
  const requestBody = object(input.body ?? {})
  if (stringify(requestBody).length > 16_384) throw bad('验证请求体过大')
  if (method === 'GET' && Object.keys(requestBody).length) throw bad('GET 验证请求不能配置请求体')
  if (tokenLocation === 'form' && Object.values(requestBody).some(item => isObject(item) || Array.isArray(item))) {
    throw bad('表单附加字段只支持字符串、数字、布尔值或 null')
  }
  const successPath = text({ successPath: input.successPath ?? 'active' }, 'successPath', '成功判定路径', { max: 500, optional: true })
  if (successPath) fieldPath(successPath)
  const successValue = Object.hasOwn(input, 'successValue') ? input.successValue : true
  if (isObject(successValue) || Array.isArray(successValue)) throw bad('成功判定值必须是 JSON 字符串、数字、布尔值或 null')
  const bindings = list(input, 'bindings', '身份参数映射').map(item => {
    const binding = object(item)
    const name = text(binding, 'name', '身份参数名', { max: 63, pattern: NAME })
    if (!name.startsWith(AUTH_PARAM_PREFIX) || name.length === AUTH_PARAM_PREFIX.length) throw bad(`身份参数名需以 ${AUTH_PARAM_PREFIX} 开头`)
    return {
      name,
      path: fieldPath(text(binding, 'path', '响应字段路径', { max: 500 })),
      type: choice(binding, 'type', '身份参数类型', FIELD_TYPES, 'string'),
    }
  })
  if (bindings.length > 50 || new Set(bindings.map(binding => binding.name)).size !== bindings.length) throw bad('身份参数映射最多 50 条，参数名不能重复')
  return {
    url, method, inputHeader, inputPrefix: prefix(input, 'inputPrefix'), tokenLocation, tokenName,
    tokenPrefix: prefix(input, 'tokenPrefix'), headers: normalizedHeaders, body: requestBody,
    successStatus: integer(input, 'successStatus', '成功 HTTP 状态', 200, 299, 200),
    successPath, successValue, bindings,
    timeoutSeconds: integer(input, 'timeoutSeconds', '验证超时', 1, 30, 5),
  }
}

/** Calls an administrator-configured verifier and maps trusted response fields to SQL parameters. */
export class ExternalAuth {
  private active = 0
  private readonly maxConcurrent: number

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent
  }

  async verify(config: ExternalAuthConfig | null, credential: string | undefined): Promise<QueryIdentity> {
    if (!config) throw new HttpError(503, '尚未配置外部身份验证')
    if (!credential || !credential.startsWith(config.inputPrefix)) throw unauthorized('缺少或无效的身份凭证')
    const token = credential.slice(config.inputPrefix.length)
    if (!token || token.length > 4096 || /[\s,\x00-\x1f\x7f]/.test(token)) throw unauthorized('缺少或无效的身份凭证')
    if (this.active >= this.maxConcurrent) throw new HttpError(503, '身份验证繁忙，请稍后再试')
    this.active++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000)
    let response: Response | undefined
    try {
      const headers = new Headers(config.headers)
      if (!headers.has('Accept')) headers.set('Accept', 'application/json')
      const outgoing = config.tokenPrefix + token
      let requestBody: string | undefined
      if (config.tokenLocation === 'header') {
        headers.set(config.tokenName, outgoing)
        if (config.method === 'POST' && Object.keys(config.body).length) {
          headers.set('Content-Type', 'application/json')
          requestBody = stringify(config.body)
        }
      } else {
        const values = { ...config.body, [config.tokenName]: outgoing }
        if (config.tokenLocation === 'json') {
          headers.set('Content-Type', 'application/json')
          requestBody = stringify(values)
        } else {
          headers.set('Content-Type', 'application/x-www-form-urlencoded')
          requestBody = new URLSearchParams(Object.entries(values).map(([key, value]) =>
            [key, value === null ? '' : JSON.isRawJSON(value) ? value.rawJSON : String(value)])).toString()
        }
      }
      response = await fetch(config.url, {
        method: config.method, headers, body: requestBody,
        redirect: 'error', // Credentials must not be forwarded to a redirect target.
        signal: controller.signal,
      })
      if (response.status === 401 || response.status === 403) throw unauthorized('身份凭证无效或已过期')
      if (response.status !== config.successStatus) throw new HttpError(502, '外部身份验证服务异常')
      if (!config.successPath && !config.bindings.length) return {}
      if (Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES || !response.body) throw new HttpError(502, '外部身份验证响应无效')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_RESPONSE_BYTES) throw new HttpError(502, '外部身份验证响应过大')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const result = parse(Buffer.concat(chunks).toString('utf8'))
      if (config.successPath) {
        const actual = readPath(result, config.successPath)
        if (actual === undefined) throw new HttpError(502, '外部身份验证响应缺少成功判定字段')
        if (identity(actual) !== identity(config.successValue)) throw unauthorized('身份凭证未通过验证')
      }
      const bindings: QueryIdentity = Object.create(null)
      for (const binding of config.bindings) {
        const value = readPath(result, binding.path)
        if (value === undefined || value === null || typeof value === 'string' && !value.trim()) {
          throw new HttpError(502, '外部身份验证响应缺少必要身份字段')
        }
        try {
          bindings[binding.name] = convert(value, binding.type, binding.name)
        } catch {
          throw new HttpError(502, '外部身份验证响应的身份字段类型无效')
        }
      }
      return { ...bindings }
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError(504, '外部身份验证超时')
      if (error instanceof HttpError) throw error
      throw new HttpError(502, '外部身份验证服务异常')
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      clearTimeout(timer)
      this.active--
    }
  }
}
