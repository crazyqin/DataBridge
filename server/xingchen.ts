import { randomBytes } from 'node:crypto'
import { sm2 } from 'sm-crypto-v2'
import { readAuthResponse } from './auth-diagnostics.ts'
import { bad, forbidden, HttpError } from './errors.ts'
import type { ExternalAuthConfig, QueryIdentity } from './external-auth.ts'
import { body, choice, list, NAME, text } from './input.ts'
import { isObject, parse, stringify, type Json, type JsonObject } from './json.ts'
import { convertOptional, type Field } from './values.ts'

export interface XingchenConfig {
  baseUrl: string
  appId: string
  apiKey: string
  publicKey: string
  staffCodeBinding: string
  inputMappings: { parameter: string; variable: string }[]
  queryParam: string
  conversationParam: string
  responseMode: 'blocking' | 'streaming'
}

export function validatePlatform(value: Json | undefined): { baseUrl: string } {
  const input = body(value ?? null)
  const baseUrl = text(input, 'baseUrl', '星辰平台基础地址', { max: 2000 }).replace(/\/+$/, '')
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch { throw bad('星辰基础地址必须是 HTTP(S) 地址，不能包含凭据、查询参数或片段') }
  return { baseUrl }
}

export function validateXingchen(value: Json | undefined, params: Field[], auth: ExternalAuthConfig | null): XingchenConfig {
  const input = body(value ?? null)
  const { baseUrl } = validatePlatform(input)
  const appId = text(input, 'appId', 'app_id', { max: 200, pattern: /^[A-Za-z0-9_-]+$/ })
  const apiKey = text(input, 'apiKey', 'api_key', { max: 4096, pattern: /^[\x21-\x7e]+$/ })
  const publicKey = text(input, 'publicKey', 'public_key', { max: 130, pattern: /^04[\da-fA-F]{128}$/ })
  try { if (!sm2.verifyPublicKey(publicKey)) throw new Error() } catch { throw bad('public_key 不是有效的 SM2 未压缩公钥') }
  const staffCodeBinding = text(input, 'staffCodeBinding', '工号身份参数', { max: 63 })
  if (!auth?.bindings.some(binding => binding.name === staffCodeBinding && binding.type === 'string')) {
    throw bad('工号必须选用外部身份验证提供的 string 类型身份参数')
  }
  const inputMappings = list(input, 'inputMappings', '智能体入参映射').map(item => {
    const mapping = body(item)
    const parameter = text(mapping, 'parameter', '请求参数名', { max: 63 })
    if (!params.some(param => param.name === parameter)) throw bad('智能体映射引用了未声明的请求参数')
    return { parameter, variable: text(mapping, 'variable', '智能体变量名', { max: 100, pattern: NAME }) }
  })
  if (inputMappings.length > 200 || new Set(inputMappings.map(mapping => mapping.variable)).size !== inputMappings.length) {
    throw bad('智能体变量名不能重复，最多 200 个')
  }
  const readParam = (key: string, label: string) => {
    const name = text(input, key, label, { max: 63, optional: true })
    if (name && !params.some(param => param.name === name && param.type === 'string')) throw bad(`${label}需引用 string 类型请求参数`)
    return name
  }
  const queryParam = readParam('queryParam', '提问参数')
  const conversationParam = readParam('conversationParam', '会话参数')
  if (!queryParam && !inputMappings.length) throw bad('请至少配置提问参数或智能体入参映射')
  if (params.some(param => ![queryParam, conversationParam, ...inputMappings.map(mapping => mapping.parameter)].includes(param.name))) {
    throw bad('存在未用于星辰转发的请求参数')
  }
  return { baseUrl, appId, apiKey, publicKey, staffCodeBinding, inputMappings, queryParam, conversationParam,
    responseMode: choice(input, 'responseMode', '星辰响应方式', ['blocking', 'streaming'] as const, 'blocking') }
}

/** Matches the documented gmssl mode=1 wire format: raw x||y||C3||C2, without the 04 point prefix or ASN.1. */
export function encryptStaffCode(staffCode: string, publicKey: string): string {
  const payload = JSON.stringify({ staff_code: staffCode, iat: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('base64url') })
  const cipher = sm2.doEncrypt(payload, publicKey, 1)
  return `v2.${Buffer.from(cipher, 'hex').toString('base64url')}`
}

export function xingchenBody(config: XingchenConfig, params: Field[], input: JsonObject, mode = config.responseMode): JsonObject {
  if (Object.keys(input).some(key => !params.some(param => param.name === key))) throw bad('包含未定义的请求参数；工号和平台凭据只能由服务端提供')
  const values: JsonObject = Object.create(null)
  for (const param of params) {
    const value = convertOptional(Object.hasOwn(input, param.name) ? input[param.name] : undefined, param)
    if (param.required && (value === null || typeof value === 'string' && !value.trim())) throw bad(`缺少参数 ${param.name}`)
    if (value !== null) values[param.name] = value
  }
  const inputData = Object.fromEntries(config.inputMappings.filter(mapping => Object.hasOwn(values, mapping.parameter))
    .map(mapping => [mapping.variable, values[mapping.parameter]]))
  return { input_data: inputData, query: values[config.queryParam] ?? '', mode,
    conversation_id: values[config.conversationParam] ?? '' }
}

type ForwardApi = { xingchen: XingchenConfig | null; params: Field[]; timeoutSeconds: number }
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Streams with backpressure; capacity and deadlines cover the entire body, including slow SSE responses. */
export class Xingchen {
  private active = 0
  private readonly maxConcurrent: number
  constructor(maxConcurrent: number) { this.maxConcurrent = maxConcurrent }

  async forward(api: ForwardApi, input: JsonObject, identity: QueryIdentity | undefined,
    options: { signal?: AbortSignal; blocking?: boolean; onStreamDone?: (error: string | null) => void } = {}): Promise<Response> {
    const config = api.xingchen
    if (!config) throw new HttpError(503, '尚未配置星辰转发')
    const staff = identity && Object.hasOwn(identity, config.staffCodeBinding) ? identity[config.staffCodeBinding] : undefined
    if (typeof staff !== 'string' || !staff.trim() || staff.length > 256) throw forbidden('缺少有效的已验证工号')
    const outgoing = xingchenBody(config, api.params, input, options.blocking ? 'blocking' : config.responseMode)
    if (this.active >= this.maxConcurrent) throw new HttpError(503, '星辰转发繁忙，请稍后再试')
    this.active++
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const timer = setTimeout(abort, api.timeoutSeconds * 1000)
    let released = false
    const release = () => {
      if (released) return
      released = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      this.active--
    }
    let response: Response | undefined
    let streaming = false
    const failure = (error: unknown) => error instanceof HttpError ? error
      : new HttpError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? '星辰转发超时或请求已取消' : '星辰平台连接或响应异常')
    try {
      response = await fetch(`${config.baseUrl}/chat-messages/${encodeURIComponent(config.appId)}`, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`,
          'Znt-Staff-Code': encryptStaffCode(staff, config.publicKey), Accept: outgoing.mode === 'streaming' ? 'text/event-stream' : 'application/json' },
        body: stringify(outgoing),
      })
      // Never reflect upstream error bodies/headers: they can contain credentials or internal addresses.
      if (!response.ok) throw new HttpError(502, `星辰平台返回 HTTP ${response.status}，请检查平台配置及请求参数`)
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (outgoing.mode === 'blocking') {
        if (contentType !== 'application/json') throw new HttpError(502, '星辰平台未返回 JSON')
        const content = await readAuthResponse(response, MAX_RESPONSE_BYTES)
        if (content.truncated) throw new HttpError(502, '星辰平台响应超过 8 MiB')
        let result: Json
        try { result = parse(content.text) } catch { throw new HttpError(502, '星辰平台返回无效 JSON') }
        if (!isObject(result) || result.event === 'error' || typeof result.answer !== 'string') throw new HttpError(502, '星辰智能体执行失败或响应缺少 answer')
        return new Response(stringify(result), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } })
      }
      if (contentType !== 'text/event-stream' || !response.body) throw new HttpError(502, '星辰平台未返回 SSE 流')
      const reader = response.body.getReader()
      let size = 0
      let streamError: string | null = null
      // Observe only event type for logging; never retain or log personal response data.
      const decoder = new TextDecoder()
      let pending = ''
      const observe = (chunk: Uint8Array) => {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data:')) {
            try { if (JSON.parse(line.slice(5)).event === 'error') streamError = '星辰智能体返回流内错误' } catch {}
          }
        }
        if (pending.length > 65_536) pending = ''
      }
      let ended = false
      let canceled = false
      const done = (error: string | null) => {
        if (ended) return
        ended = true
        release()
        options.onStreamDone?.(error)
      }
      // A slow client may stop reading with one buffered chunk. Release the slot at the deadline even then.
      controller.signal.addEventListener('abort', () => done('星辰转发超时或请求已取消'), { once: true })
      const stream = new ReadableStream<Uint8Array>({
        async pull(sink) {
          try {
            const chunk = await reader.read()
            if (canceled) return
            if (chunk.done) { sink.close(); done(streamError); return }
            size += chunk.value.byteLength
            if (size > MAX_RESPONSE_BYTES) throw new HttpError(502, '星辰平台响应超过 8 MiB')
            observe(chunk.value)
            sink.enqueue(chunk.value)
          } catch (error) {
            if (canceled) return
            const message = failure(error).message
            sink.enqueue(new TextEncoder().encode(`\n\ndata: ${JSON.stringify({ event: 'error', code: 'databridge_forward_error', message })}\n\n`))
            sink.close()
            done(message)
            controller.abort()
            await reader.cancel().catch(() => {})
          }
        },
        async cancel() {
          canceled = true
          done('调用方取消星辰转发')
          controller.abort()
          await reader.cancel().catch(() => {})
        },
      })
      streaming = true
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', 'Cache-Control': 'private, no-store' } })
    } catch (error) { throw failure(error) } finally {
      if (!streaming) {
        release()
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      }
    }
  }
}
