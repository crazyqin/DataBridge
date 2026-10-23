import type { Api } from './apis.ts'
import { STATUS_CODES } from 'node:http'
import { authRedactor } from './auth-diagnostics.ts'
import { parse, stringify, type JsonObject } from './json.ts'

export type CallStage = 'request' | 'routing' | 'access' | 'identity' | 'query' | 'forward' | 'response' | 'stream'
export interface CallStreamSummary { bytes: number; events: number; lastEvent: string | null }

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
  // Optional for compatibility with previously persisted traces.
  url?: string
  urlTruncated?: boolean
  clientAddress?: string
  api?: Pick<Api, 'id' | 'name' | 'code' | 'path' | 'method' | 'mode' | 'auth' | 'version' | 'datasourceId' |
    'authConnectionId' | 'authConnectionName' | 'xingchenConnectionId' | 'xingchenConnectionName' | 'timeoutSeconds' | 'maxRows' | 'syncAt'> | null
  parameters?: string
  parametersTruncated?: boolean
  pagination?: { page: number; pageSize: number } | null
  steps?: { stage: CallStage; elapsedMs: number; ok: boolean }[]
  errorStage?: CallStage | null
  statusText?: string
  responseHeaders?: string
  responseHeadersTruncated?: boolean
  responseBody?: string | null
  responseBodyTruncated?: boolean
  responseBodyNote?: string | null
  responseBytes?: number
  stream?: CallStreamSummary
}

/** Capture caller inputs once; only bounded, redacted previews may be persisted. */
export function callDiagnostics(request: Request, api?: Api, clientAddress = 'unknown') {
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
  safe.remember(query)
  const queryPreview = safe.body(stringify(query))
  const trace: CallRequestTrace = {
    method: request.method, path: safe.text(url.pathname).slice(0, 2000), status: 500, responseType: null,
    headers: headerPreview.text, headersTruncated: headerPreview.truncated,
    query: queryPreview.text, queryTruncated: queryPreview.truncated,
    body: null, bodyTruncated: false, bodyNote: request.method === 'POST' ? '请求体未读取' : null,
    clientAddress: safe.text(clientAddress).slice(0, 200), api: api ? {
      id: api.id, name: safe.text(api.name), code: safe.text(api.code), path: safe.text(api.path), method: api.method,
      mode: api.mode, auth: api.auth, version: api.version, datasourceId: api.datasourceId,
      authConnectionId: api.authConnectionId, authConnectionName: api.authConnectionName && safe.text(api.authConnectionName),
      xingchenConnectionId: api.xingchenConnectionId, xingchenConnectionName: api.xingchenConnectionName && safe.text(api.xingchenConnectionName),
      timeoutSeconds: api.timeoutSeconds, maxRows: api.maxRows, syncAt: api.syncAt,
    } : null,
    steps: [], errorStage: null, responseBody: null, responseBodyTruncated: false, responseBodyNote: '未记录响应正文',
  }
  let stage: CallStage = 'request', stageStarted = performance.now(), finished = false
  // A later body may reveal a credential also copied into the URL or another header.
  function refreshRequest() {
    const address = safe.url(request.url)
    const bytes = Buffer.from(address)
    trace.url = new TextDecoder().decode(bytes.subarray(0, 8192), { stream: true })
    trace.urlTruncated = bytes.length > 8192
    trace.path = safe.text(url.pathname).slice(0, 2000)
    const h = safe.body(stringify(safe.headers(request.headers, true))), q = safe.body(stringify(query))
    trace.headers = h.text; trace.headersTruncated = h.truncated
    trace.query = q.text; trace.queryTruncated = q.truncated
    // Redact earlier previews again after collecting newly discovered secrets.
    if (trace.body !== null) {
      const preview = safe.body(trace.body)
      trace.body = preview.text; trace.bodyTruncated ||= preview.truncated
    }
    if (trace.parameters !== undefined) {
      const preview = safe.body(trace.parameters)
      trace.parameters = preview.text; trace.parametersTruncated ||= preview.truncated
    }
  }
  refreshRequest()
  return {
    trace,
    error: (message: string) => safe.text(message).slice(0, 2000),
    captureBody(raw: string) {
      // Malformed JSON cannot be reliably redacted structurally, so retain the failure without its raw bytes.
      try { if (raw.trim()) safe.remember(parse(raw)) } catch {
        trace.bodyNote = '请求体不是有效的 JSON，未保存原文'
        return
      }
      const preview = safe.body(raw)
      trace.body = preview.text; trace.bodyTruncated = preview.truncated; trace.bodyNote = null
      refreshRequest()
    },
    stage(next: CallStage) {
      if (finished) return
      trace.steps!.push({ stage, elapsedMs: Math.round(performance.now() - stageStarted), ok: true })
      stage = next; stageStarted = performance.now()
    },
    finish(failed: boolean) {
      if (finished) return
      trace.steps!.push({ stage, elapsedMs: Math.round(performance.now() - stageStarted), ok: !failed })
      trace.errorStage = failed ? stage : null
      finished = true
    },
    parameters(input: JsonObject, page?: number, pageSize?: number) {
      safe.remember(input)
      const preview = safe.body(stringify(input))
      trace.parameters = preview.text; trace.parametersTruncated = preview.truncated
      trace.pagination = page !== undefined && pageSize !== undefined ? { page, pageSize } : null
      refreshRequest()
    },
    captureResponseBody(raw: string) {
      safe.remember(parse(raw))
      const preview = safe.body(raw)
      trace.responseBody = preview.text; trace.responseBodyTruncated = preview.truncated
      trace.responseBodyNote = null; trace.responseBytes = Buffer.byteLength(raw)
      refreshRequest()
    },
    captureResponse(response: Response) {
      trace.status = response.status; trace.statusText = response.statusText || STATUS_CODES[response.status] || ''
      trace.responseType = response.headers.get('content-type')
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]
        safe.remember({ cookie: pair.slice(pair.indexOf('=') + 1) })
      }
      const preview = safe.body(stringify(safe.headers(response.headers, true)))
      trace.responseHeaders = preview.text; trace.responseHeadersTruncated = preview.truncated
      if (trace.responseBody !== null && trace.responseBody !== undefined) {
        const body = safe.body(trace.responseBody)
        trace.responseBody = body.text; trace.responseBodyTruncated ||= body.truncated
      }
      if (trace.responseType?.startsWith('text/event-stream')) trace.responseBodyNote = 'SSE 流式响应：记录接收字节数、已识别事件和结束状态，不缓存完整正文'
      if (request.method === 'HEAD') {
        trace.responseBody = null; trace.responseBodyTruncated = false; trace.responseBytes = 0
        trace.responseBodyNote = 'HEAD 请求不返回响应正文'
      }
      refreshRequest()
    },
    captureStream(summary: CallStreamSummary) {
      trace.stream = { ...summary, lastEvent: summary.lastEvent && safe.text(summary.lastEvent).slice(0, 80) }
      trace.responseBytes = summary.bytes
    },
  }
}
