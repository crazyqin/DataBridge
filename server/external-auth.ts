import { createHash } from 'node:crypto'
import { bad, HttpError, unauthorized } from './errors.ts'
import { body as object, choice, integer, list, NAME, text } from './input.ts'
import { isObject, parse, stringify, type Json, type JsonObject } from './json.ts'
import { convert, FIELD_TYPES, identity, type FieldType } from './values.ts'
import { AUTH_PREVIEW_BYTES, authRedactor, readAuthResponse, transportDetail, type ExternalAuthTrace } from './auth-diagnostics.ts'

export const AUTH_PARAM_PREFIX = '_auth_'
export const TEST_CREDENTIAL_HEADER = 'X-DataBridge-Test-Credential'
export type QueryIdentity = Record<string, Json>
export interface AuthBinding { name: string; path: string; type: FieldType }
export interface AuthCondition { path: string; value: Json }
export type AuthHeaderValue =
  | { type: 'literal'; value: string }
  | { type: 'timestamp'; unit: 'milliseconds' | 'seconds' }
  | { type: 'digest'; algorithm: 'md5' | 'sha256' | 'sha512'; encoding: 'hex' | 'base64'; parts: AuthHeaderValue[] }
export interface ExternalAuthConfig {
  url: string
  method: 'GET' | 'POST'
  inputHeader: string
  inputPrefix: string
  tokenLocation: 'header' | 'query' | 'json' | 'form'
  tokenName: string
  tokenPrefix: string
  headers: Record<string, string>
  dynamicHeaders: Record<string, AuthHeaderValue>
  body: JsonObject
  successStatus: number
  successPath: string
  successValue: Json
  successConditions: AuthCondition[]
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

/** A bounded expression tree, with no script execution or access to request fields. */
function headerValue(value: Json, budget: { count: number }, depth = 0): AuthHeaderValue {
  if (depth > 6 || ++budget.count > 100) throw bad('动态 Header 表达式过于复杂')
  const input = object(value)
  const type = choice(input, 'type', '动态 Header 值类型', ['literal', 'timestamp', 'digest'] as const)
  if (type === 'literal') {
    if (typeof input.value !== 'string' || input.value.length > 4096) throw bad('动态 Header 固定文本必须是不超过 4096 字符的字符串')
    return { type, value: input.value } // Preserve whitespace and UTF-8 before hashing.
  }
  if (type === 'timestamp') return { type, unit: choice(input, 'unit', '时间戳单位', ['milliseconds', 'seconds'] as const, 'milliseconds') }
  const parts = list(input, 'parts', '摘要拼接项')
  if (!parts.length || parts.length > 20) throw bad('摘要拼接项需有 1～20 项')
  return {
    type, algorithm: choice(input, 'algorithm', '摘要算法', ['md5', 'sha256', 'sha512'] as const),
    encoding: choice(input, 'encoding', '摘要编码', ['hex', 'base64'] as const, 'hex'),
    parts: parts.map(part => headerValue(part, budget, depth + 1)),
  }
}

function renderHeaderValue(value: AuthHeaderValue, now: number): string {
  if (value.type === 'literal') return value.value
  if (value.type === 'timestamp') return String(value.unit === 'seconds' ? Math.floor(now / 1000) : now)
  const hash = createHash(value.algorithm)
  for (const part of value.parts) hash.update(renderHeaderValue(part, now), 'utf8')
  return hash.digest(value.encoding)
}

function validHeaderText(value: string): boolean {
  return value.length <= 4096 && !/[^\x20-\x7e]/.test(value)
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
  const tokenLocation = choice(input, 'tokenLocation', '凭证传递位置', ['header', 'query', 'json', 'form'] as const, 'header')
  if (method === 'GET' && !['header', 'query'].includes(tokenLocation)) throw bad('GET 验证请求需通过 Header 或查询参数传递凭证')
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
    if (typeof value !== 'string' || !validHeaderText(value)) throw bad('附加 Header 值必须是可打印 ASCII 文本')
    normalizedHeaders[lower] = value
  }
  const dynamicHeaders = object(input.dynamicHeaders ?? {})
  if (Object.keys(dynamicHeaders).length > 20 || stringify(dynamicHeaders).length > 16_384) throw bad('动态 Header 最多 20 个，配置不能超过 16 KiB')
  const normalizedDynamic: Record<string, AuthHeaderValue> = Object.create(null)
  const budget = { count: 0 }
  for (const [name, value] of Object.entries(dynamicHeaders)) {
    const lower = headerName(name).toLowerCase()
    if (Object.hasOwn(normalizedDynamic, lower)) throw bad('动态 Header 名称重复')
    if (tokenLocation === 'header' && lower === tokenName.toLowerCase()) throw bad('动态 Header 不能与目标凭证 Header 同名')
    const expression = headerValue(value, budget)
    if (!validHeaderText(renderHeaderValue(expression, Date.now()))) throw bad('动态 Header 结果必须是不超过 4096 字符的可打印 ASCII 文本')
    normalizedDynamic[lower] = expression
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
  const successConditions = list(input, 'successConditions', '附加成功条件').map(item => {
    const condition = object(item)
    const value = condition.value
    if (value === undefined || isObject(value) || Array.isArray(value)) throw bad('附加成功条件的判定值必须是 JSON 字符串、数字、布尔值或 null')
    return { path: fieldPath(text(condition, 'path', '附加成功条件的字段路径', { max: 500 })), value }
  })
  const conditionPaths = [...(successPath ? [successPath] : []), ...successConditions.map(condition => condition.path)]
  if (successConditions.length > 20 || new Set(conditionPaths).size !== conditionPaths.length) throw bad('附加成功条件最多 20 条，字段路径不能重复')
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
    tokenPrefix: prefix(input, 'tokenPrefix'), headers: normalizedHeaders, dynamicHeaders: normalizedDynamic, body: requestBody,
    successStatus: integer(input, 'successStatus', '成功 HTTP 状态', 200, 299, 200),
    successPath, successValue, successConditions, bindings,
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

  async verify(config: ExternalAuthConfig | null, credential: string | undefined,
    diagnostic?: (trace: ExternalAuthTrace) => void): Promise<QueryIdentity> {
    const started = performance.now()
    const trace: ExternalAuthTrace = { at: new Date().toISOString(), elapsedMs: 0, ok: false, error: null, detail: null,
      request: null, response: null, checks: [] }
    const redact = authRedactor(config, credential)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = false
    let response: Response | undefined
    try {
      if (!config) throw new HttpError(503, '尚未配置外部身份验证')
      if (!credential || !credential.startsWith(config.inputPrefix)) {
        trace.detail = `请求未提供有效凭证，请检查来源 Header ${config.inputHeader} 和来源前缀配置`
        throw unauthorized('缺少或无效的身份凭证')
      }
      const token = credential.slice(config.inputPrefix.length)
      if (!token || token.length > 4096 || /[\s,\x00-\x1f\x7f]/.test(token)) throw unauthorized('缺少或无效的身份凭证')
      if (this.active >= this.maxConcurrent) throw new HttpError(503, '身份验证繁忙，请稍后再试')
      this.active++
      active = true
      timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000)
      const headers = new Headers(config.headers)
      const now = Date.now()
      // Legacy saved configurations have no dynamicHeaders; they retain their behavior.
      for (const [name, expression] of Object.entries(config.dynamicHeaders ?? {})) {
        headers.set(name, renderHeaderValue(expression, now))
      }
      if (!headers.has('Accept')) headers.set('Accept', 'application/json')
      const outgoing = config.tokenPrefix + token
      const url = new URL(config.url)
      let requestBody: string | undefined
      if (config.tokenLocation === 'header' || config.tokenLocation === 'query') {
        if (config.tokenLocation === 'header') headers.set(config.tokenName, outgoing)
        else url.searchParams.set(config.tokenName, outgoing)
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
      if (diagnostic) {
        const safeHeaders = redact.headers(headers, true)
        const safeBody = requestBody === undefined ? null : redact.body(requestBody, headers.get('Content-Type') ?? '')
        trace.request = { method: config.method, url: redact.url(url.toString()), headers: safeHeaders,
          body: safeBody?.text ?? null, truncated: safeBody?.truncated ?? false }
      }
      response = await fetch(url, {
        method: config.method, headers, body: requestBody,
        redirect: 'manual', // Record the redirect response without forwarding credentials.
        signal: controller.signal,
      })
      trace.response = { status: response.status, statusText: redact.text(response.statusText), headers: diagnostic ? redact.headers(response.headers) : {},
        body: null, truncated: false }
      const conditions = [
        ...(config.successPath ? [{ path: config.successPath, value: config.successValue }] : []),
        ...(config.successConditions ?? []),
      ]
      const needsJson = response.status === config.successStatus && !!(conditions.length || config.bindings.length)
      let raw = ''
      let oversized = Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES
      if (needsJson || diagnostic) {
        try {
          const content = await readAuthResponse(response, needsJson ? MAX_RESPONSE_BYTES : AUTH_PREVIEW_BYTES)
          raw = content.text
          oversized ||= content.truncated
          if (diagnostic) {
            const preview = redact.body(raw, response.headers.get('Content-Type') ?? '')
            trace.response.body = preview.text
            trace.response.truncated = content.truncated || preview.truncated
          }
        } catch (error) {
          trace.detail = redact.text(`验证服务响应体读取失败：${transportDetail(error)}`)
          // Diagnostics must not change HTTP-only verification or a known rejection.
          if (needsJson) throw error
        }
      }
      if (response.status === 401 || response.status === 403) {
        trace.detail = `验证服务返回 HTTP ${response.status}，拒绝了本次鉴权`
        throw unauthorized('身份凭证无效或已过期')
      }
      if (response.status !== config.successStatus) {
        trace.detail = `验证服务返回 HTTP ${response.status}，配置要求 HTTP ${config.successStatus}`
        if (response.status >= 300 && response.status < 400) trace.detail += '；未跟随重定向，请检查验证地址和响应 Location'
        throw new HttpError(502, '外部身份验证服务异常')
      }
      if (!needsJson) { trace.ok = true; return {} }
      if (oversized) {
        trace.detail = '验证服务响应超过 64 KiB 上限'
        throw new HttpError(502, '外部身份验证响应过大')
      }
      if (!response.body) throw new HttpError(502, '外部身份验证响应无效')
      let result: Json
      try { result = parse(raw) } catch {
        trace.detail = '验证服务返回的内容不是有效 JSON，请查看响应内容和 Content-Type'
        throw new HttpError(502, '外部身份验证响应不是有效的 JSON')
      }
      if (diagnostic) trace.checks = conditions.map(condition => {
        const actual = readPath(result, condition.path)
        return { path: condition.path, expected: redact.json(condition.value, condition.path),
          actual: actual === undefined ? null : redact.json(actual, condition.path), exists: actual !== undefined,
          matched: actual !== undefined && identity(actual) === identity(condition.value) }
      })
      for (const condition of conditions) {
        const actual = readPath(result, condition.path)
        if (actual === undefined) {
          trace.detail = `响应缺少成功判定字段 ${condition.path}`
          throw new HttpError(502, '外部身份验证响应缺少成功判定字段')
        }
        if (identity(actual) !== identity(condition.value)) {
          trace.detail = `成功条件 ${condition.path} 不匹配，请检查判定值和 JSON 类型`
          throw unauthorized('身份凭证未通过验证')
        }
      }
      const bindings: QueryIdentity = Object.create(null)
      for (const binding of config.bindings) {
        const value = readPath(result, binding.path)
        if (value === undefined || value === null || typeof value === 'string' && !value.trim()) {
          trace.detail = `响应缺少身份字段 ${binding.path}，无法映射到 ${binding.name}`
          throw new HttpError(502, '外部身份验证响应缺少必要身份字段')
        }
        try {
          bindings[binding.name] = convert(value, binding.type, binding.name)
        } catch {
          trace.detail = `身份字段 ${binding.path} 无法转换为 ${binding.type}`
          throw new HttpError(502, '外部身份验证响应的身份字段类型无效')
        }
      }
      trace.ok = true
      return { ...bindings }
    } catch (error) {
      const failure = error instanceof HttpError ? error : controller.signal.aborted ? new HttpError(504, '外部身份验证超时')
        : new HttpError(502, '外部身份验证服务异常')
      trace.error = failure.message
      if (failure.status === 504) trace.detail = `验证请求在 ${config?.timeoutSeconds} 秒内未完成`
      else if (!trace.detail) trace.detail = error instanceof HttpError ? error.message : `验证服务连接或读取失败：${transportDetail(error)}`
      trace.detail = redact.body(trace.detail).text
      throw failure
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      clearTimeout(timer)
      if (active) this.active--
      trace.elapsedMs = Math.round(performance.now() - started)
      diagnostic?.(trace)
    }
  }
}
