/** Fixed, authenticated forwarding. Task bodies never enter generic request diagnostics. */
import type { Config } from './config.ts'
import type { Connections } from './connections.ts'
import type { ExternalAuth } from './external-auth.ts'
import { bad, HttpError } from './errors.ts'
import { isObject, parse, stringify, type JsonObject } from './json.ts'

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const RESERVED = ['actor', 'staff_code', '_auth_staff_code', 'user_id', 'submitted_by_user_id', 'username', 'provider', 'request_id']

export class DataSkill {
  private active = 0
  private readonly config: Config
  private readonly connections: Connections
  private readonly auth: ExternalAuth
  constructor(config: Config, connections: Connections, auth: ExternalAuth) {
    this.config = config; this.connections = connections; this.auth = auth
  }

  async forward(request: Request, requestId: string): Promise<Response> {
    const config = this.connections.dataSkill()
    if (!config) throw new HttpError(503, '请在连接管理中配置并启用 DataSkill Studio')
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/open\/dataskill\//, '')
    let target = ''
    if (request.method === 'POST' && ['feedback', 'skill-check'].includes(path)) target = path
    else if (request.method === 'GET' && new RegExp(`^feedback/${UUID}$`).test(path)) target = path + '/status'
    else if (request.method === 'POST' && new RegExp(`^feedback/${UUID}/withdraw$`).test(path)) target = path
    else if (request.method === 'GET' && new RegExp(`^skill-download/${UUID}$`).test(path)) target = path
    else throw new HttpError(404, '反馈接口不存在')
    if (url.search) throw bad('反馈接口不接受查询参数')
    const auth = this.connections.auth(config.authConnectionId)
    const binding = auth.bindings.find(b => b.name === config.staffCodeBinding && b.type === 'string')
    if (!binding) throw new HttpError(503, '反馈身份服务缺少 string 工号映射')
    const identity = await this.auth.verify({ ...auth, bindings: [binding] }, request.headers.get(auth.inputHeader) ?? undefined)
    const staff = identity[config.staffCodeBinding]
    if (typeof staff !== 'string' || !staff.trim() || staff.length > 64) throw new HttpError(502, '身份服务返回无效工号')
    let payload: JsonObject = {}
    if (request.method === 'POST') {
      const raw = await request.text()
      if (Buffer.byteLength(raw) > 512 * 1024) throw new HttpError(413, '反馈正文超过 512 KiB')
      try { const value = parse(raw || '{}'); if (!isObject(value)) throw new Error(); payload = value }
      catch { throw bad('反馈必须是 JSON 对象') }
      if (RESERVED.some(name => Object.hasOwn(payload, name))) throw bad('身份字段只能由 DataBridge 注入')
    }
    if (this.active >= this.config.maxConcurrentQueries) throw new HttpError(503, '反馈转发繁忙')
    this.active++
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const timer = setTimeout(abort, 60_000)
    try {
      const response = await fetch(`${config.baseUrl}/api/integrations/databridge/${target}`, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${config.serviceToken}`, 'Content-Type': 'application/json' },
        body: stringify({ actor: { provider: config.identityProvider, staff_code: staff }, request_id: requestId, payload }),
      })
      // An upstream service authentication failure is not the person's UAP expiry.
      if (response.status === 401 || response.status >= 500 || response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new HttpError(502, 'Studio 集成服务暂不可用，请检查服务授权和连接')
      }
      const download = target.startsWith('skill-download/') && response.ok
      const maximum = download ? 64 * 1024 * 1024 : 1024 * 1024
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maximum) throw new HttpError(502, 'Studio 响应超过大小限制')
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => {}) }
      }
      const bytes = Buffer.concat(chunks)
      if (download) {
        if (!response.headers.get('content-type')?.startsWith('application/zip')) throw new HttpError(502, 'Studio 未返回 Skill 压缩包')
        return new Response(bytes, { headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'private, no-store' } })
      }
      let result: JsonObject
      try { const value = parse(bytes.toString()); if (!isObject(value)) throw new Error(); result = value }
      catch { throw new HttpError(502, 'Studio 返回无效 JSON') }
      if (!response.ok) {
        // Never relay arbitrary exception bodies, validation inputs or internal URLs.
        const detail = isObject(result.detail) ? result.detail : {}
        const code = typeof detail.code === 'string' && /^[a-z_]{1,80}$/.test(detail.code) ? detail.code : 'studio_request_rejected'
        return new Response(JSON.stringify({ detail: { code }, request_id: requestId }), {
          status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
      }
      return new Response(stringify(result), { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } })
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(controller.signal.aborted ? 504 : 502, 'Studio 转发超时或连接失败')
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', abort); this.active--
    }
  }
}
