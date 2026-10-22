import type { Api } from './apis.ts'
import { authRedactor } from './auth-diagnostics.ts'
import { parse, stringify } from './json.ts'

export interface CallRequestTrace {
  method: string
  path: string
  status: number
  responseType: string | null
  headers: string
  headersTruncated: boolean
  query: string
  queryTruncated: boolean
  body: string | null
  bodyTruncated: boolean
  bodyNote: string | null
}

/** Capture caller inputs once; only bounded, redacted previews may be persisted. */
export function callDiagnostics(request: Request, api?: Api) {
  const credential = api?.externalAuth ? request.headers.get(api.externalAuth.inputHeader) ?? undefined : undefined
  const authorization = request.headers.get('authorization') ?? ''
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(part => part.slice(part.indexOf('=') + 1).trim())
  const safe = authRedactor(api?.externalAuth ?? null, credential, [
    authorization.replace(/^\S+\s+/, ''), ...cookies, api?.xingchen?.apiKey ?? '',
  ])
  // Collect credential-bearing headers before processing query/body aliases of the same values.
  const headers = safe.headers(request.headers, true)
  if (api?.externalAuth && request.headers.has(api.externalAuth.inputHeader)) headers[api.externalAuth.inputHeader.toLowerCase()] = '[REDACTED]'
  const headerPreview = safe.body(stringify(headers))
  const url = new URL(request.url)
  const query = Object.fromEntries([...new Set(url.searchParams.keys())].map(name => {
    const values = url.searchParams.getAll(name)
    return [name, values.length === 1 ? values[0] : values]
  }))
  const queryPreview = safe.body(stringify(query))
  const trace: CallRequestTrace = {
    method: request.method, path: safe.text(url.pathname).slice(0, 2000), status: 500, responseType: null,
    headers: headerPreview.text, headersTruncated: headerPreview.truncated,
    query: queryPreview.text, queryTruncated: queryPreview.truncated,
    body: null, bodyTruncated: false, bodyNote: request.method === 'POST' ? '请求体未读取' : null,
  }
  return {
    trace,
    error: (message: string) => safe.text(message).slice(0, 2000),
    captureBody(raw: string) {
      // Malformed JSON cannot be reliably redacted structurally, so retain the failure without its raw bytes.
      try { if (raw.trim()) parse(raw) } catch {
        trace.bodyNote = '请求体不是有效的 JSON，未保存原文'
        return
      }
      const preview = safe.body(raw)
      trace.body = preview.text; trace.bodyTruncated = preview.truncated; trace.bodyNote = null
    },
  }
}
