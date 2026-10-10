export interface RequestTrace {
  at: string
  elapsedMs: number
  completed: boolean
  error: string | null
  request: { method: string; url: string; headers: Record<string, string>; body: string | null }
  response: { status: number; statusText: string; headers: Record<string, string>; body: string | null } | null
}

const HIDDEN = '[REDACTED]'
const sensitive = (key: string) => /authorization|cookie|token|secret|password|passwd|credential|digest|signature|(?:api|service)[_-]?key/i.test(key)
const jsonApi = JSON as typeof JSON & { rawJSON?: (source: string) => object; isRawJSON?: (value: unknown) => boolean }

function parse(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' && context?.source && jsonApi.rawJSON ? jsonApi.rawJSON(context.source) : value)
}

/** Keep editor diagnostics separate from the wire payload, including nested signing secrets. */
export function createRequestTrace(method: string, url: string, headers: Record<string, string>, payload?: string) {
  const started = performance.now()
  const secrets = new Set<string>()
  const credentialNames = new Set<string>()
  function secret(value: string) {
    if (!value) return
    secrets.add(value)
    secrets.add(encodeURIComponent(value))
    secrets.add(new URLSearchParams({ value }).toString().slice(6))
    secrets.add(JSON.stringify(value).slice(1, -1))
  }
  function collect(value: unknown, key = '', depth = 0) {
    if (depth > 30) return
    if (typeof value === 'string' && sensitive(key)) {
      secret(value)
      if (/authorization|credential/i.test(key)) secret(value.replace(/^(Bearer|Basic|Key) /i, ''))
    }
    if (value && typeof value === 'object' && !jsonApi.isRawJSON?.(value)) {
      const object = value as Record<string, unknown>
      if (typeof object.tokenName === 'string') credentialNames.add(object.tokenName.toLowerCase())
      if (object.type === 'literal' && typeof object.value === 'string') secret(object.value)
      for (const [name, part] of Object.entries(object)) collect(part, name, depth + 1)
    }
  }
  collect(headers)
  if (payload) { try { collect(parse(payload)) } catch {} }
  const secretPattern = [...secrets].sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const hiddenKey = (key: string) => sensitive(key) || credentialNames.has(key.toLowerCase())
  function text(value: string) {
    let safe = secretPattern ? value.replace(new RegExp(secretPattern, 'g'), () => HIDDEN) : value
    safe = safe.replace(/(["']([^"'\r\n]+)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\r\n]+)/g,
      (match, prefix: string, key: string) => hiddenKey(key) ? prefix + JSON.stringify(HIDDEN) : match)
    return safe.replace(/([?&\s])([^=\s&]+)=([^&\s<]*)/g,
      (match, prefix: string, key: string) => hiddenKey(key) ? `${prefix}${key}=${HIDDEN}` : match)
  }
  function redact(value: unknown, key = '', depth = 0): unknown {
    if (hiddenKey(key)) return HIDDEN
    if (depth > 30) return '[内容过深，已省略]'
    if (typeof value === 'string') return text(value)
    if (jsonApi.isRawJSON?.(value)) return value
    if (Array.isArray(value)) return value.map(part => redact(part, '', depth + 1))
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      return Object.fromEntries(Object.entries(object).map(([name, part]) => [name,
        object.type === 'literal' && name === 'value' ? HIDDEN : redact(part, name, depth + 1),
      ]))
    }
    return value
  }
  function body(value: string): string {
    try { return JSON.stringify(redact(parse(value)), null, 2) } catch { return text(value) }
  }
  function safeHeaders(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, hiddenKey(key) ? HIDDEN : text(value)]))
  }
  const trace: RequestTrace = { at: new Date().toISOString(), elapsedMs: 0, completed: false, error: null,
    request: { method, url: text(url), headers: safeHeaders(headers), body: payload === undefined ? null : body(payload) }, response: null }
  return {
    trace,
    received(response: Response, content: string | null) {
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => { responseHeaders[key] = value })
      trace.response = { status: response.status, statusText: text(response.statusText),
        headers: safeHeaders(responseHeaders), body: content === null ? null : body(content) }
    },
    finish(error?: unknown) {
      trace.completed = true
      trace.elapsedMs = Math.round(performance.now() - started)
      trace.error = error === undefined ? null : text(error instanceof Error ? error.message : String(error))
      return { ...trace }
    },
  }
}
