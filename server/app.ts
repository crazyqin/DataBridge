import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Api, Apis } from './apis.ts'
import { userAgentAllowed } from './apis.ts'
import type { Auth } from './auth.ts'
import type { Config } from './config.ts'
import { now, type Db } from './db.ts'
import { bad, forbidden, HttpError, notFound, unauthorized } from './errors.ts'
import { body, id, integer } from './input.ts'
import { parse, stringify, stringifyForBrowser, type Json, type JsonObject } from './json.ts'
import type { Logs } from './logs.ts'
import { SourceError } from './query.ts'
import type { Sources } from './sources.ts'

type Env = { Variables: { requestId: string; user: string } }
type Ctx = Context<Env>

export interface Services { config: Config; db: Db; auth: Auth; sources: Sources; apis: Apis; logs: Logs }

const COOKIE = 'databridge_session'

function send(c: Ctx, data: unknown, status = 200, forBrowser = false) {
  const text = forBrowser ? stringifyForBrowser(data) : stringify(data)
  return c.body(text, status as 200, { 'Content-Type': 'application/json; charset=utf-8' })
}

async function readJson(c: Ctx): Promise<JsonObject> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  let value: Json
  try {
    value = parse(raw)
  } catch {
    throw bad('请求体不是有效的 JSON')
  }
  return body(value)
}

/** Data-source errors carry PostgreSQL's message; only administrators get to see it. */
function withDetail(error: unknown): never {
  if (error instanceof SourceError) throw new HttpError(error.status, `${error.message}：${error.detail}`)
  throw error
}

export function createApp({ config, db, auth, sources, apis, logs }: Services) {
  const app = new Hono<Env>()
  let activeQueries = 0

  const isHttps = (c: Ctx) => config.secureCookies === 'auto'
    ? config.trustProxy && c.req.header('X-Forwarded-Proto') === 'https'
    : config.secureCookies
  const clientAddress = (c: Ctx) => {
    if (config.trustProxy) return c.req.header('X-Forwarded-For')?.split(',')[0].trim() || 'unknown'
    try {
      return getConnInfo(c).remote.address ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }
  const admin = (c: Ctx, data: unknown, status = 200) => send(c, data, status, true)

  app.use(async (c, next) => {
    c.set('requestId', randomUUID())
    await next()
    const headers = c.res.headers
    headers.set('X-Request-ID', c.get('requestId'))
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('X-Frame-Options', 'DENY')
    headers.set('Referrer-Policy', 'no-referrer')
    if (isHttps(c)) headers.set('Strict-Transport-Security', 'max-age=31536000')
    if (headers.get('Content-Type')?.startsWith('text/html')) {
      headers.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
    }
  })

  app.use(bodyLimit({ maxSize: 2 * 1024 * 1024, onError: c => send(c, { code: 41301, message: '请求体过大', request_id: c.get('requestId') }, 413) }))

  app.onError((error, c) => {
    const requestId = c.get('requestId')
    if (error instanceof HttpError) return send(c, { code: error.code, message: error.message, request_id: requestId }, error.status)
    console.error(`request ${requestId} failed:`, error)
    return send(c, { code: 50001, message: '服务器内部错误', request_id: requestId }, 500)
  })

  app.get('/healthz', c => {
    db.prepare('SELECT 1').get()
    return c.json({ ok: true })
  })

  // ---- session ----

  const requireCsrfHeader = (c: Ctx) => {
    if (c.req.method !== 'GET' && c.req.header('X-Requested-With') !== 'DataBridge') throw forbidden('缺少请求头 X-Requested-With')
  }

  app.get('/auth/session', c => admin(c, { username: auth.session(getCookie(c, COOKIE)) ?? null }))

  app.post('/auth/login', async c => {
    requireCsrfHeader(c)
    const input = await readJson(c)
    const username = typeof input.username === 'string' ? input.username : ''
    const password = typeof input.password === 'string' ? input.password : ''
    const token = await auth.login(username, password, clientAddress(c))
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', secure: isHttps(c) })
    return admin(c, { username })
  })

  app.post('/auth/logout', c => {
    requireCsrfHeader(c)
    auth.logout(getCookie(c, COOKIE))
    deleteCookie(c, COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  app.use('/admin/*', async (c, next) => {
    const user = auth.session(getCookie(c, COOKIE))
    if (!user) throw unauthorized()
    requireCsrfHeader(c)
    c.set('user', user)
    await next()
  })

  app.post('/admin/password', async c => {
    const input = await readJson(c)
    await auth.changePassword(c.get('user'), input.currentPassword, input.newPassword)
    deleteCookie(c, COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  // ---- API keys ----

  app.get('/admin/keys', c => admin(c, auth.listKeys()))
  app.post('/admin/keys', async c => admin(c, auth.createKey((await readJson(c)).name), 201))
  app.delete('/admin/keys/:id', c => {
    auth.deleteKey(id(c.req.param('id')))
    return c.body(null, 204)
  })

  // ---- data sources ----

  app.get('/admin/datasources', c => admin(c, sources.list()))
  app.post('/admin/datasources', async c => admin(c, sources.save(undefined, await readJson(c)), 201))
  app.put('/admin/datasources/:id', async c => admin(c, sources.save(id(c.req.param('id')), await readJson(c))))
  app.delete('/admin/datasources/:id', c => {
    sources.remove(id(c.req.param('id')))
    return c.body(null, 204)
  })
  app.post('/admin/datasources/:id/test', async c => admin(c, await sources.test(id(c.req.param('id'))).catch(withDetail)))

  // ---- APIs ----

  app.get('/admin/apis', c => admin(c, apis.list()))
  app.post('/admin/apis', async c => admin(c, apis.save(undefined, await readJson(c)), 201))
  /** Tests the configuration as currently edited, saved or not. */
  app.post('/admin/apis/test', async c => {
    const input = await readJson(c)
    const api = body(input.api ?? null)
    if (api.mode === 'MANUAL') throw bad('手工维护模式没有 SQL')
    // Only the data source, SQL and parameters matter here; the rest may still be unfilled.
    const draft = apis.validate({
      ...api, name: 'draft', code: 'draft', path: '/open/draft', mode: 'REALTIME', params: api.mode === 'REALTIME' ? api.params : [],
    })
    const started = performance.now()
    const rows = await apis.realtime(draft, body(input.params ?? {}), { truncate: true }).catch(withDetail)
    return admin(c, { elapsedMs: Math.round(performance.now() - started), count: rows.length, rows })
  })
  app.get('/admin/apis/:id', c => admin(c, apis.get(id(c.req.param('id')))))
  app.put('/admin/apis/:id', async c => admin(c, apis.save(id(c.req.param('id')), await readJson(c))))
  app.delete('/admin/apis/:id', c => {
    apis.remove(id(c.req.param('id')))
    return c.body(null, 204)
  })
  app.post('/admin/apis/:id/enable', c => admin(c, apis.setEnabled(id(c.req.param('id')), true)))
  app.post('/admin/apis/:id/disable', c => admin(c, apis.setEnabled(id(c.req.param('id')), false)))
  app.post('/admin/apis/:id/sync', async c => admin(c, await apis.sync(id(c.req.param('id'))).catch(withDetail)))

  // ---- stored rows ----

  app.get('/admin/apis/:id/rows', c => {
    const query = { page: Number(c.req.query('page') ?? 1), pageSize: Number(c.req.query('pageSize') ?? 50) }
    const page = integer(query, 'page', '页码', 1, 1_000_000)
    const pageSize = integer(query, 'pageSize', '每页条数', 1, 200)
    return admin(c, apis.rows(id(c.req.param('id')), page, pageSize, c.req.query('search') ?? ''))
  })
  app.post('/admin/apis/:id/rows', async c => admin(c, apis.createRow(id(c.req.param('id')), await readJson(c)), 201))
  app.put('/admin/apis/:id/rows/:key', async c => {
    const input = await readJson(c)
    const version = integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER)
    return admin(c, apis.updateRow(id(c.req.param('id')), c.req.param('key'), version, body(input.data ?? null)))
  })
  app.delete('/admin/apis/:id/rows/:key', c => {
    const version = integer({ version: Number(c.req.query('version')) }, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER)
    apis.deleteRow(id(c.req.param('id')), c.req.param('key'), version)
    return c.body(null, 204)
  })
  app.patch('/admin/apis/:id/rows/:key/remark', async c => {
    const input = await readJson(c)
    const version = integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER)
    return admin(c, apis.updateRemark(id(c.req.param('id')), c.req.param('key'), version, input.remark))
  })
  app.post('/admin/apis/:id/rows/:key/move', async c => {
    const position = integer(await readJson(c), 'position', '位置', 1, Number.MAX_SAFE_INTEGER)
    apis.moveRow(id(c.req.param('id')), c.req.param('key'), position)
    return c.body(null, 204)
  })
  app.delete('/admin/apis/:id/sort', c => {
    apis.resetSort(id(c.req.param('id')))
    return c.body(null, 204)
  })

  app.get('/admin/logs', c => admin(c, logs.list(c.req.query())))

  // ---- open API ----

  function pagination(api: Api, input: JsonObject) {
    const allowed = api.mode === 'REALTIME' ? api.params.map(param => param.name) : api.filters
    const pageKey = Object.hasOwn(input, '_page') && !allowed.includes('_page') ? '_page' : allowed.includes('page') ? null : 'page'
    const sizeKey = Object.hasOwn(input, '_pageSize') && !allowed.includes('_pageSize') ? '_pageSize' : allowed.includes('pageSize') ? null : 'pageSize'
    if (!(pageKey && Object.hasOwn(input, pageKey) || sizeKey && Object.hasOwn(input, sizeKey))) {
      return { input, page: undefined, pageSize: undefined }
    }
    const read = (key: string | null, label: string, fallback: number, max: number) => {
      const value = key ? input[key] : undefined
      if (value === undefined) return fallback
      const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
      return integer({ value: number }, 'value', label, 1, max)
    }
    const page = read(pageKey, '页码', 1, 1_000_000)
    const pageSize = read(sizeKey, '每页条数', Math.min(100, api.maxRows), Math.min(1000, api.maxRows))
    const params = { ...input }
    if (pageKey) delete params[pageKey]
    if (sizeKey) delete params[sizeKey]
    return { input: params, page, pageSize }
  }

  app.all('/open/*', async c => {
    const started = performance.now()
    const at = now()
    const requestId = c.get('requestId')
    const api = apis.findOpen(c.req.path, c.req.method)
    if (!api) throw notFound('接口不存在或未启用')
    let count = 0
    let error: string | null = null
    try {
      if (api.auth === 'API_KEY' && !auth.checkKey(c.req.header('X-API-Key'))) throw unauthorized('API Key 无效')
      if (!userAgentAllowed(api.userAgents, c.req.header('User-Agent'))) throw forbidden('User-Agent 不被允许')
      const input: JsonObject = api.method === 'GET' ? c.req.query() : await readJson(c)
      const paging = pagination(api, input)
      if (api.mode === 'REALTIME' && activeQueries >= config.maxConcurrentQueries) throw new HttpError(503, '服务繁忙，请稍后再试')
      activeQueries++
      let rows
      let total: number | undefined
      try {
        if (paging.page !== undefined && paging.pageSize !== undefined) {
          const result = await apis.queryPage(api, paging.input, paging.page, paging.pageSize)
          rows = result.rows
          total = result.total
        } else {
          rows = await apis.query(api, paging.input)
        }
      } finally {
        activeQueries--
      }
      count = rows.length
      const meta: Record<string, Json> = { count, source: api.mode, request_id: requestId }
      if (api.mode === 'SNAPSHOT') meta.last_sync_time = api.syncAt
      if (total !== undefined) {
        meta.page = paging.page!
        meta.page_size = paging.pageSize!
        meta.total = total
        meta.total_pages = Math.ceil(total / paging.pageSize!)
        meta.has_more = paging.page! * paging.pageSize! < total
      }
      return send(c, { code: 0, message: 'success', data: rows, meta })
    } catch (e) {
      error = e instanceof HttpError ? e.message : '服务器内部错误'
      throw e
    } finally {
      logs.write({ requestId, at, apiId: api.id, mode: api.mode, elapsedMs: performance.now() - started, rowCount: count, ok: error === null, error })
    }
  })

  // ---- admin UI ----

  if (existsSync(config.webDir)) app.use('/*', serveStatic({ root: config.webDir }))

  app.notFound(c => send(c, { code: 40401, message: '资源不存在', request_id: c.get('requestId') }, 404))

  return app
}
