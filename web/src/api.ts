import { ElMessage, ElMessageBox } from 'element-plus'
import { createRequestTrace, type RequestTrace } from './request-trace'

export type FieldType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime'
export interface Field { name: string; type: FieldType; required: boolean }
export type Mode = 'REALTIME' | 'SNAPSHOT' | 'MANUAL'
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
  at: string; elapsedMs: number; ok: boolean; error: string | null; detail: string | null
  request: { method: string; url: string; headers: Record<string, string>; body: string | null; truncated: boolean } | null
  response: { status: number; statusText: string; headers: Record<string, string>; body: string | null; truncated: boolean } | null
  checks: { path: string; expected: unknown; actual: unknown; exists: boolean; matched: boolean }[]
}

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

export interface Api {
  id?: number; name: string; code: string; path: string; method: 'GET' | 'POST'; auth: 'API_KEY' | 'PUBLIC' | 'EXTERNAL'
  externalAuth: ExternalAuthConfig | null
  userAgents: string[]; mode: Mode; datasourceId: number | null; sql: string | null
  params: Field[]; fields: Field[]; filters: string[]; keyFields: string[]; cron: string | null; cronTimezone: string | null; allowEmpty: boolean
  timeoutSeconds: number; maxRows: number; enabled: boolean; version?: number
  syncAt?: string | null; syncStatus?: string | null; syncCount?: number | null; syncError?: string | null; nextSyncAt?: string | null
}

export interface StoredRow { key: string; version: number; sorted: boolean; position: number; remark: string; data: Record<string, unknown> }

export const FIELD_TYPES: FieldType[] = ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime']
export const MODE_LABELS: Record<Mode, string> = { REALTIME: '实时查询', SNAPSHOT: '定时同步', MANUAL: '手工维护' }

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
