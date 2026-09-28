import { ElMessage, ElMessageBox } from 'element-plus'

export type FieldType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime'
export interface Field { name: string; type: FieldType; required: boolean }
export type Mode = 'REALTIME' | 'SNAPSHOT' | 'MANUAL'

export interface Datasource {
  id: number; name: string; host: string; port: number; database: string; username: string
  ssl: 'disable' | 'require' | 'verify'; enabled: boolean; version: number
}

export interface Api {
  id?: number; name: string; code: string; path: string; method: 'GET' | 'POST'; auth: 'API_KEY' | 'PUBLIC'
  userAgents: string[]; mode: Mode; datasourceId: number | null; sql: string | null
  params: Field[]; fields: Field[]; filters: string[]; keyFields: string[]; cron: string | null; cronTimezone: string | null; allowEmpty: boolean
  timeoutSeconds: number; maxRows: number; enabled: boolean; version?: number
  syncAt?: string | null; syncStatus?: string | null; syncCount?: number | null; syncError?: string | null; nextSyncAt?: string | null
}

export interface StoredRow { key: string; version: number; sorted: boolean; position: number; remark: string; data: Record<string, unknown> }

export const FIELD_TYPES: FieldType[] = ['string', 'integer', 'decimal', 'boolean', 'date', 'datetime']
export const MODE_LABELS: Record<Mode, string> = { REALTIME: '实时查询', SNAPSHOT: '定时同步', MANUAL: '手工维护' }

interface Options { method?: string; body?: unknown; rawBody?: string; silent?: boolean }

/** Calls the admin API; failures show a message and reject. */
export async function request<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body, rawBody, silent = false } = options
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'DataBridge', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: payload,
  })
  if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('auth-expired'))
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const message = error.message || `请求失败 (${response.status})`
    if (!silent) ElMessage.error(message)
    throw new Error(message)
  }
  return response.status === 204 ? undefined as T : response.json()
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
