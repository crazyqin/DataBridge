import { ElMessage, ElMessageBox } from 'element-plus'
import { createRequestTrace, type RequestTrace } from './request-trace'

export type FieldType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime'
export interface Field { name: string; type: FieldType; required: boolean }
export type Mode = 'REALTIME' | 'SNAPSHOT' | 'MANUAL' | 'XINGCHEN'
export interface LogWindow { from: string; to: string }
export interface LogStats extends LogWindow { total: number; failed: number }
export type AuthHeaderValue =
  | { type: 'literal'; value: string }
  | { type: 'timestamp'; unit: 'milliseconds' | 'seconds' }
  | { type: 'digest'; algorithm: 'md5' | 'sha256' | 'sha512'; encoding: 'hex' | 'base64'; parts: AuthHeaderValue[] }
export interface ExternalAuthConfig {
  url: string; method: 'GET' | 'POST'; inputHeader: string; inputPrefix: string
  tokenLocation: 'header' | 'query' | 'json' | 'form'; tokenName: string; tokenPrefix: string
  headers: Record<string, string>; dynamicHeaders: Record<string, AuthHeaderValue>; body: Record<string, unknown>
  successStatus: number; successPath: string; successValue: unknown; timeoutSeconds: number
  successConditions: { path: string; value: unknown }[]
  bindings: { name: string; path: string; type: FieldType }[]
}
export const defaultExternalAuth = (): ExternalAuthConfig => ({
  url: '', method: 'POST', inputHeader: 'Authorization', inputPrefix: 'Bearer ',
  tokenLocation: 'header', tokenName: 'Authorization', tokenPrefix: 'Bearer ', headers: {}, dynamicHeaders: {}, body: {},
  successStatus: 200, successPath: 'active', successValue: true, successConditions: [], timeoutSeconds: 5, bindings: [],
})

export interface ExternalAuthTrace {
  redacted?: boolean
  at: string; elapsedMs: number; ok: boolean; error: string | null; detail: string | null
  request: { method: string; url: string; headers: Record<string, string>; body: string | null; truncated: boolean } | null
  response: { status: number; statusText: string; headers: Record<string, string>; body: string | null; truncated: boolean } | null
  checks: { path: string; expected: unknown; actual: unknown; exists: boolean; matched: boolean }[]
}

export type CallStage = 'request' | 'routing' | 'access' | 'identity' | 'query' | 'forward' | 'response' | 'stream'
export interface CallRequestTrace {
  method: string; path: string; status: number; responseType: string | null
  headers: string; headersTruncated: boolean; query: string; queryTruncated: boolean
  body: string | null; bodyTruncated: boolean; bodyNote: string | null
  url?: string; urlTruncated?: boolean; clientAddress?: string
  api?: Pick<Api, 'id' | 'name' | 'code' | 'path' | 'method' | 'mode' | 'auth' | 'version' | 'datasourceId' |
    'authConnectionId' | 'authConnectionName' | 'xingchenConnectionId' | 'xingchenConnectionName' | 'timeoutSeconds' | 'maxRows' | 'syncAt'> | null
  parameters?: string; parametersTruncated?: boolean; pagination?: { page: number; pageSize: number } | null
  steps?: { stage: CallStage; elapsedMs: number; ok: boolean }[]; errorStage?: CallStage | null
  statusText?: string; responseHeaders?: string; responseHeadersTruncated?: boolean
  responseBody?: string | null; responseBodyTruncated?: boolean; responseBodyNote?: string | null; responseBytes?: number
  stream?: { bytes: number; events: number; lastEvent: string | null }
}

export interface CallDetails { request: CallRequestTrace | null; externalAuth: ExternalAuthTrace | null }

export class RequestError extends Error {
  readonly externalAuthTrace?: ExternalAuthTrace

  constructor(message: string, externalAuthTrace?: ExternalAuthTrace) {
    super(message)
    this.externalAuthTrace = externalAuthTrace
  }
}

export interface Datasource {
  id: number; name: string; host: string; port: number; database: string; username: string
  ssl: 'disable' | 'require' | 'verify'; enabled: boolean; version: number
}

export interface XingchenConfig {
  baseUrl: string; appId: string; apiKey: string; publicKey: string; staffCodeBinding: string
  inputMappings: { parameter: string; variable: string }[]
  queryParam: string; conversationParam: string; responseMode: 'blocking' | 'streaming'
}
export const defaultXingchen = (): XingchenConfig => ({
  baseUrl: '', appId: '', apiKey: '', publicKey: '', staffCodeBinding: '_auth_staff_code',
  inputMappings: [{ parameter: 'q', variable: 'q' }], queryParam: 'q', conversationParam: 'conversation_id', responseMode: 'blocking',
})

export type ConnectionKind = 'EXTERNAL_AUTH' | 'XINGCHEN'
export interface ConnectionSummary {
  id: number; kind: ConnectionKind; name: string; version: number; createdAt: string; updatedAt: string
  usedBy: { id: number; name: string }[]; bindings: ExternalAuthConfig['bindings']; inputHeader: string; inputPrefix: string
}
export interface Connection extends Omit<ConnectionSummary, 'bindings' | 'inputHeader' | 'inputPrefix'> {
  config: ExternalAuthConfig | { baseUrl: string }
}
export const CONNECTION_LABELS: Record<ConnectionKind, string> = { EXTERNAL_AUTH: '身份服务', XINGCHEN: '星辰平台' }

export interface Api {
  id?: number; name: string; code: string; path: string; method: 'GET' | 'POST'; auth: 'API_KEY' | 'PUBLIC' | 'EXTERNAL'
  authConnectionId: number | null
  xingchenConnectionId: number | null
  authConnectionName?: string | null
  xingchenConnectionName?: string | null
  externalAuth: ExternalAuthConfig | null
  xingchen: XingchenConfig | null
  userAgents: string[]; mode: Mode; datasourceId: number | null; sql: string | null
  params: Field[]; fields: Field[]; filters: string[]; keyFields: string[]; cron: string | null; cronTimezone: string | null; allowEmpty: boolean
  timeoutSeconds: number; maxRows: number; enabled: boolean; version?: number
  syncAt?: string | null; syncStatus?: string | null; syncCount?: number | null; syncError?: string | null; nextSyncAt?: string | null
}

export interface StoredRow { key: string; version: number; sorted: boolean; position: number; remark: string; data: Record<string, unknown> }

export const FIELD_TYPE_LABELS: Record<FieldType, string> = { string: '文本 string', integer: '整数 integer', decimal: '小数 decimal', boolean: '布尔 boolean', date: '日期 date', datetime: '时间 datetime' }
export const FIELD_TYPES: FieldType[] = ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime']
export const MODE_LABELS: Record<Mode, string> = { REALTIME: '实时查询', SNAPSHOT: '定时同步', MANUAL: '手工维护', XINGCHEN: '星辰智能体转发' }

interface Options { method?: string; body?: unknown; rawBody?: string; silent?: boolean; headers?: Record<string, string>; onTrace?: (trace: RequestTrace) => void }

/** Calls the admin API; failures show a message and reject. */
export async function request<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body, rawBody, silent = false } = options
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
  const headers = { 'X-Requested-With': 'DataBridge', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers }
  const recorder = options.onTrace ? createRequestTrace(method, new URL(path, window.location.href).toString(), headers, payload) : undefined
  if (recorder) options.onTrace?.({ ...recorder.trace })
  let failure: unknown
  try {
    const response = await fetch(path, { method, credentials: 'same-origin', headers, body: payload })
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('auth-expired'))
    recorder?.received(response, null)
    const content = await response.text()
    recorder?.received(response, content)
    let result
    try { result = content ? JSON.parse(content) : undefined } catch {}
    if (!response.ok) {
      const message = result?.message || `请求失败 (${response.status})`
      if (!silent) ElMessage.error(message)
      throw new RequestError(message, result?.externalAuthTrace)
    }
    if (response.status === 204) return undefined as T
    if (result === undefined) {
      const message = '服务器返回的内容不是有效的 JSON'
      if (!silent) ElMessage.error(message)
      throw new RequestError(message)
    }
    return result as T
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (recorder) options.onTrace?.(recorder.finish(failure))
  }
}

export const formatTime = (value?: string | null) => value ? new Date(value).toLocaleString() : ''
export const formatTimeInZone = (value: string, timeZone: string) => new Intl.DateTimeFormat('zh-CN', {
  timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(new Date(value))

export function display(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** Resolves to false instead of rejecting when the user cancels. */
export function confirm(message: string, title: string): Promise<boolean> {
  return ElMessageBox.confirm(message, title, { type: 'warning' }).then(() => true, () => false)
}
