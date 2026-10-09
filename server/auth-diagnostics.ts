import { isObject, parse, type Json } from './json.ts'
import type { AuthHeaderValue, ExternalAuthConfig } from './external-auth.ts'

export interface ExternalAuthTrace {
  at: string
  elapsedMs: number
  ok: boolean
  error: string | null
  detail: string | null
  request: { method: string; url: string; headers: Record<string, string>; body: string | null; truncated: boolean } | null
  response: { status: number; statusText: string; headers: Record<string, string>; body: string | null; truncated: boolean } | null
  checks: { path: string; expected: Json; actual: Json | null; exists: boolean; matched: boolean }[]
}

export const AUTH_PREVIEW_BYTES = 8192
const REDACTED = '[REDACTED]'
const sensitive = (name: string) => /authorization|cookie|token|secret|password|passwd|credential|digest|signature|(?:api|service)[_-]?key/i.test(name)

/** Redact before truncating or persisting; opaque configured signing values are never logged. */
export function authRedactor(config: ExternalAuthConfig | null, credential?: string) {
  const secrets = new Set<string>()
  const hiddenHeaders = new Set<string>()
  const visibleValues = new Set(Object.entries(config?.headers ?? {}).filter(([name]) => !sensitive(name)).map(([, value]) => value))
  function secret(value: string | undefined) {
    if (!value) return
    secrets.add(value)
    secrets.add(encodeURIComponent(value))
    secrets.add(new URLSearchParams({ v: value }).toString().slice(2))
    secrets.add(JSON.stringify(value).slice(1, -1))
  }
  function expression(value: AuthHeaderValue) {
    if (value.type === 'literal' && !visibleValues.has(value.value)) secret(value.value)
    if (value.type === 'digest') for (const part of value.parts) expression(part)
  }
  function collect(value: Json, name = '') {
    if (typeof value === 'string' && sensitive(name)) secret(value)
    if (Array.isArray(value)) for (const part of value) collect(part, name)
    else if (isObject(value)) for (const [key, part] of Object.entries(value)) collect(part, key)
  }
  secret(credential)
  if (config) {
    const token = credential?.startsWith(config.inputPrefix) ? credential.slice(config.inputPrefix.length) : undefined
    secret(token)
    if (token) secret(config.tokenPrefix + token)
    if (config.tokenLocation === 'header') hiddenHeaders.add(config.tokenName.toLowerCase())
    for (const [name, value] of Object.entries(config.headers)) if (sensitive(name) || hiddenHeaders.has(name.toLowerCase())) secret(value)
    for (const [name, value] of Object.entries(config.dynamicHeaders ?? {})) {
      expression(value)
      if (value.type !== 'timestamp') hiddenHeaders.add(name.toLowerCase())
    }
    collect(config.body)
  }
  const orderedSecrets = () => [...secrets].sort((a, b) => b.length - a.length)
  function text(value: string): string {
    let result = value
    const pattern = orderedSecrets().map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    if (pattern) result = result.replace(new RegExp(pattern, 'g'), () => REDACTED)
    // Also cover truncated/non-JSON bodies and credential-bearing redirect URLs.
    result = result.replace(/(["']([^"'\r\n]+)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\r\n]+)/g,
      (match, prefix: string, name: string) => sensitive(name) ? prefix + JSON.stringify(REDACTED) : match)
    return result.replace(/([?&\s])([^=\s&]+)=([^&\s<]*)/g,
      (match, prefix: string, name: string) => sensitive(name) || name === config?.tokenName ? `${prefix}${name}=${REDACTED}` : match)
  }
  function json(value: Json, name = '', depth = 0): Json {
    if (sensitive(name) || name === config?.tokenName) return REDACTED
    if (depth > 30) return '[内容过深，已省略]'
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(part => json(part, name, depth + 1))
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, json(part, key, depth + 1)]))
    return value
  }
  function url(value: string): string {
    try {
      const parsed = new URL(value, config?.url)
      for (const key of new Set(parsed.searchParams.keys())) {
        if (sensitive(key) || key === config?.tokenName) parsed.searchParams.set(key, REDACTED)
      }
      return text(parsed.toString())
    } catch { return text(value) }
  }
  function headers(values: Headers, request = false): Record<string, string> {
    if (request) for (const [name, value] of values) if (sensitive(name) || hiddenHeaders.has(name)) secret(value)
    return Object.fromEntries([...values].map(([name, value]) => [name,
      sensitive(name) || hiddenHeaders.has(name) ? REDACTED : name === 'location' ? url(value) : text(value),
    ]))
  }
  function body(value: string, contentType = ''): { text: string; truncated: boolean } {
    let safe: string
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const fields = new URLSearchParams(value)
      safe = [...fields].map(([name, part]) => `${name}=${sensitive(name) || name === config?.tokenName ? REDACTED : text(part)}`).join('&')
    } else {
      try { safe = JSON.stringify(json(parse(value)), null, 2) } catch { safe = text(value) }
    }
    const bytes = Buffer.from(safe)
    return { text: bytes.subarray(0, AUTH_PREVIEW_BYTES).toString('utf8'), truncated: bytes.length > AUTH_PREVIEW_BYTES }
  }
  return { text, json, url, headers, body }
}

/** Bounded reads, including chunked bodies and providers that omit Content-Length. */
export async function readAuthResponse(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = limit - size
      chunks.push(value.subarray(0, remaining))
      size += Math.min(value.byteLength, remaining)
      if (value.byteLength > remaining) { truncated = true; break }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

export function transportDetail(error: unknown): string {
  const details: string[] = []
  function visit(value: unknown, depth = 0) {
    if (!(value instanceof Error) || depth > 5) return
    const code = (value as Error & { code?: unknown }).code
    if (typeof code === 'string') details.push(code)
    if (value.message) details.push(value.message)
    if (value instanceof AggregateError) for (const part of value.errors) visit(part, depth + 1)
    visit(value.cause, depth + 1)
  }
  visit(error)
  return [...new Set(details)].join('；') || '未知连接或响应读取错误'
}
