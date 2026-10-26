import type { Api } from './apis.ts'
import { STATUS_CODES } from 'node:http'
import { diagnosticPreview, plainDiagnostics } from './auth-diagnostics.ts'
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

/** Capture caller inputs and responses with original values and bounded previews. */
export function callDiagnostics(request: Request, api?: Api, clientAddress = 'unknown') {
  const headerPreview = plainDiagnostics.body(stringify(Object.fromEntries(request.headers)))
  const url = new URL(request.url)
  const query = Object.fromEntries([...new Set(url.searchParams.keys())].map(name => {
    const values = url.searchParams.getAll(name)
    return [name, values.length === 1 ? values[0] : values]
  }))
  const queryPreview = plainDiagnostics.body(stringify(query))
  const address = diagnosticPreview(request.url)
  const trace: CallRequestTrace = {
    method: request.method, path: url.pathname.slice(0, 2000), url: address.text, urlTruncated: address.truncated,
    status: 500, responseType: null,
    headers: headerPreview.text, headersTruncated: headerPreview.truncated,
    query: queryPreview.text, queryTruncated: queryPreview.truncated,
    body: null, bodyTruncated: false, bodyNote: request.method === 'POST' ? '请求体未读取' : null,
    clientAddress: clientAddress.slice(0, 200), api: api ? {
      id: api.id, name: api.name, code: api.code, path: api.path, method: api.method,
      mode: api.mode, auth: api.auth, version: api.version, datasourceId: api.datasourceId,
      authConnectionId: api.authConnectionId, authConnectionName: api.authConnectionName,
      xingchenConnectionId: api.xingchenConnectionId, xingchenConnectionName: api.xingchenConnectionName,
      timeoutSeconds: api.timeoutSeconds, maxRows: api.maxRows, syncAt: api.syncAt,
    } : null,
    steps: [], errorStage: null, responseBody: null, responseBodyTruncated: false, responseBodyNote: '未记录响应正文',
  }
  let stage: CallStage = 'request', stageStarted = performance.now(), finished = false
  return {
    trace,
    error: (message: string) => message.slice(0, 2000),
    captureBody(raw: string) {
      const preview = plainDiagnostics.body(raw)
      trace.body = preview.text; trace.bodyTruncated = preview.truncated; trace.bodyNote = null
      try { if (raw.trim()) parse(raw) } catch { trace.bodyNote = '请求体不是有效的 JSON，以下为原文预览' }
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
      const preview = plainDiagnostics.body(stringify(input))
      trace.parameters = preview.text; trace.parametersTruncated = preview.truncated
      trace.pagination = page !== undefined && pageSize !== undefined ? { page, pageSize } : null
    },
    captureResponseBody(raw: string) {
      const preview = plainDiagnostics.body(raw)
      trace.responseBody = preview.text; trace.responseBodyTruncated = preview.truncated
      trace.responseBodyNote = null; trace.responseBytes = Buffer.byteLength(raw)
    },
    captureResponse(response: Response) {
      trace.status = response.status; trace.statusText = response.statusText || STATUS_CODES[response.status] || ''
      trace.responseType = response.headers.get('content-type')
      const preview = plainDiagnostics.body(stringify(Object.fromEntries(response.headers)))
      trace.responseHeaders = preview.text; trace.responseHeadersTruncated = preview.truncated
      if (trace.responseType?.startsWith('text/event-stream')) trace.responseBodyNote = 'SSE 流式响应：记录接收字节数、已识别事件和结束状态，不缓存完整正文'
      if (request.method === 'HEAD') {
        trace.responseBody = null; trace.responseBodyTruncated = false; trace.responseBytes = 0
        trace.responseBodyNote = 'HEAD 请求不返回响应正文'
      }
    },
    captureStream(summary: CallStreamSummary) {
      trace.stream = { ...summary, lastEvent: summary.lastEvent && summary.lastEvent.slice(0, 80) }
      trace.responseBytes = summary.bytes
    },
  }
}
