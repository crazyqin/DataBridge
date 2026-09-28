import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import pg from 'pg'
import { Apis } from '../server/apis.ts'
import { createApp } from '../server/app.ts'
import { Auth } from '../server/auth.ts'
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'

// Needs a disposable PostgreSQL, e.g. TEST_PG_URL=postgres://postgres:x@127.0.0.1:5432/postgres.
// The tests create and drop the schema "databridge_test" there.
const PG_URL = process.env.TEST_PG_URL

describe('DataBridge', { skip: !PG_URL && 'set TEST_PG_URL to run integration tests' }, () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'databridge-'))
  const config = loadConfig({ DATA_DIR: dataDir, ADMIN_PASSWORD: 'initial-password-1', TZ: 'Asia/Shanghai', WEB_DIR: join(dataDir, 'none') })
  const db = openDb(config.dbFile)
  const auth = new Auth(db, config)
  const sources = new Sources(db, config)
  const apis = new Apis(db, sources, config)
  const app = createApp({ config, db, auth, sources, apis, logs: new Logs(db) })
  const source = new pg.Client(PG_URL)
  let cookie = ''
  let apiKey = ''
  let datasourceId = 0

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await app.request(path, {
      method,
      headers: { 'X-Requested-With': 'DataBridge', cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    const text = await response.text()
    return { status: response.status, text, json: text ? JSON.parse(text) : undefined, headers: response.headers }
  }

  const open = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    call(init.method ?? 'GET', path, init.body, { 'X-API-Key': apiKey, ...init.headers })

  async function createApi(config: Record<string, unknown>) {
    const response = await call('POST', '/admin/apis', { method: 'GET', auth: 'API_KEY', enabled: true, datasourceId, ...config })
    assert.equal(response.status, 201, response.text)
    return response.json
  }

  before(async () => {
    await auth.bootstrap()
    await source.connect()
    await source.query(`
      DROP SCHEMA IF EXISTS databridge_test CASCADE;
      CREATE SCHEMA databridge_test;
      CREATE TABLE databridge_test.item (id int8 PRIMARY KEY, name text, price numeric, seen timestamptz);
      INSERT INTO databridge_test.item VALUES
        (1, 'one', 1.50, '2026-09-25 10:00:00+08'), (2, 'two', 2.00, '2026-09-25 11:00:00+08'), (3, 'three', NULL, NULL);`)
  })

  after(async () => {
    apis.stopSchedules()
    await sources.closeAll()
    await source.query('DROP SCHEMA IF EXISTS databridge_test CASCADE')
    await source.end()
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  test('admin session requires login and the CSRF header', async () => {
    assert.equal((await call('GET', '/admin/apis')).status, 401)
    assert.equal((await call('POST', '/auth/login', { username: 'admin', password: 'wrong-password' })).status, 401)
    assert.equal((await call('POST', '/auth/login', { username: 'admin', password: 'initial-password-1' }, { 'X-Requested-With': '' })).status, 403)
    assert.equal((await call('POST', '/auth/login', { username: 'admin', password: 'initial-password-1' })).status, 200)
    assert.equal((await call('GET', '/admin/apis')).status, 200)
    assert.equal((await call('POST', '/admin/keys', { name: 'x' }, { 'X-Requested-With': '' })).status, 403)
  })

  test('data sources use optimistic versions', async () => {
    const url = new URL(PG_URL!)
    const created = await call('POST', '/admin/datasources', {
      name: 'test', host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
      username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) || 'unused',
    })
    assert.equal(created.status, 201, created.text)
    assert.equal(created.json.password, undefined)
    datasourceId = created.json.id
    assert.equal((await call('POST', `/admin/datasources/${datasourceId}/test`)).status, 200)
    const stale = created.json
    assert.equal((await call('PUT', `/admin/datasources/${datasourceId}`, { ...stale, enabled: false })).status, 200)
    const overwrite = await call('PUT', `/admin/datasources/${datasourceId}`, { ...stale, name: 'renamed' })
    assert.equal(overwrite.status, 409)
    const current = (await call('GET', '/admin/datasources')).json[0]
    assert.equal(current.enabled, false)
    assert.equal((await call('PUT', `/admin/datasources/${datasourceId}`, { ...current, enabled: true })).status, 200)
    assert.equal((await call('PUT', `/admin/datasources/${datasourceId}`, { ...current, enabled: 'false' })).status, 400)
  })

  test('API keys are shown once and can be revoked', async () => {
    const created = await call('POST', '/admin/keys', { name: 'client' })
    assert.equal(created.status, 201)
    apiKey = created.json.key
    assert.match(apiKey, /^dbk_/)
    assert.equal(JSON.stringify((await call('GET', '/admin/keys')).json).includes(apiKey), false)
  })

  test('realtime queries bind typed parameters and keep exact values', async () => {
    await createApi({
      name: 'types', code: 'types', path: '/open/types', mode: 'REALTIME',
      params: [{ name: 'n', type: 'integer', required: false }],
      sql: `SELECT 9007199254740993::int8 AS big, 1.50::numeric AS money, TIME '10:20:30.123456' AS t,
        TIMETZ '10:20:30.123456+08:00' AS tz, TIMESTAMPTZ '2026-09-25 10:00:00.5+08' AS ts,
        ARRAY[TIMESTAMPTZ '2026-09-25 10:00:00+08', NULL] AS tss, ARRAY[TIME '01:02:03.5'] AS times,
        '{"nested":1.10}'::jsonb AS j, '{"k":1}'::jsonb ? 'k' AS has, $$a:b$$ AS dollar, E'it\\'s' AS esc,
        :n IS NULL AS missing`,
    })
    const response = await open('/open/types')
    assert.equal(response.status, 200, response.text)
    assert.match(response.text, /"big":9007199254740993,"money":1.50,/)
    assert.match(response.text, /"j":\{"nested":1.10\}/)
    const row = response.json.data[0]
    assert.deepEqual(
      { t: row.t, tz: row.tz, ts: row.ts, tss: row.tss, times: row.times, has: row.has, dollar: row.dollar, esc: row.esc, missing: row.missing },
      { t: '10:20:30.123456', tz: '10:20:30.123456+08:00', ts: '2026-09-25T10:00:00.5+08:00', tss: ['2026-09-25T10:00:00+08:00', null],
        times: ['01:02:03.5'], has: true, dollar: 'a:b', esc: "it's", missing: true })
    assert.equal((await open('/open/types?n=5')).json.data[0].missing, false)
    assert.equal((await open('/open/types?n=abc')).status, 400)
    assert.equal((await open('/open/types?other=1')).status, 400)
  })

  test('open calls check key, User-Agent, row limit and hide SQL errors', async () => {
    await createApi({
      name: 'items', code: 'items', path: '/open/items', method: 'POST', mode: 'REALTIME', maxRows: 2, userAgents: ['Client/*'],
      params: [{ name: 'id', type: 'integer', required: true }],
      sql: 'SELECT id, name FROM databridge_test.item WHERE id = :id OR :id = 0 ORDER BY id',
    })
    const ua = { 'User-Agent': 'Client/1' }
    assert.equal((await open('/open/items', { method: 'POST', body: { id: 1 }, headers: { 'X-API-Key': 'bad', ...ua } })).status, 401)
    assert.equal((await open('/open/items', { method: 'POST', body: { id: 1 }, headers: { 'User-Agent': 'Other' } })).status, 403)
    assert.equal((await open('/open/items', { method: 'POST', body: {}, headers: ua })).status, 400)
    const one = await open('/open/items', { method: 'POST', body: { id: 1 }, headers: ua })
    assert.deepEqual(one.json.data, [{ id: 1, name: 'one' }])
    assert.equal(one.headers.get('X-Request-ID'), one.json.meta.request_id)
    assert.equal((await open('/open/items', { method: 'POST', body: { id: 0 }, headers: ua })).status, 422)
    const secondPage = await open('/open/items', { method: 'POST', body: { id: 0, page: 2, pageSize: 2 }, headers: ua })
    assert.equal(secondPage.status, 200, secondPage.text)
    assert.deepEqual(secondPage.json.data, [{ id: 3, name: 'three' }])
    assert.equal(secondPage.json.meta.total, 3)
    assert.equal(secondPage.json.meta.has_more, false)
    assert.equal((await open('/open/items')).status, 404)

    const broken = await createApi({ name: 'broken', code: 'broken', path: '/open/broken', mode: 'REALTIME', sql: "SELECT 'secret-value'::int AS x" })
    const failed = await open('/open/broken')
    assert.equal(failed.status, 502)
    assert.doesNotMatch(failed.text, /secret-value/)
    const tested = await call('POST', '/admin/apis/test', { api: broken, params: {} })
    assert.match(tested.json.message, /secret-value/)
  })

  test('SQL runs read-only and must be one SELECT', async () => {
    const draft = { name: 'd', code: 'd', path: '/open/d', mode: 'REALTIME', datasourceId }
    const write = await call('POST', '/admin/apis/test', { api: { ...draft, sql: 'WITH gone AS (DELETE FROM databridge_test.item RETURNING id) SELECT * FROM gone' } })
    assert.equal(write.status, 400, write.text)
    assert.equal((await call('POST', '/admin/apis', { ...draft, sql: 'SELECT 1; DROP TABLE x' })).status, 400)
    assert.equal((await call('POST', '/admin/apis', { ...draft, sql: 'SELECT :missing' })).status, 400)
    const draftTest = await call('POST', '/admin/apis/test', { api: { ...draft, sql: 'SELECT :v AS v', params: [{ name: 'v', type: 'integer' }] }, params: '§' })
    assert.equal(draftTest.status, 400)
    const exact = await call('POST', '/admin/apis/test', '{"api":' + JSON.stringify({ ...draft, sql: 'SELECT :v AS v', params: [{ name: 'v', type: 'integer' }] }) + ',"params":{"v":9007199254740993}}')
    assert.equal(exact.json.rows[0].v, '9007199254740993')
  })

  test('API configuration uses optimistic versions and validates cron', async () => {
    const api = await createApi({ name: 'versioned', code: 'versioned', path: '/open/versioned', mode: 'REALTIME', sql: 'SELECT 1 AS one' })
    assert.equal((await call('PUT', `/admin/apis/${api.id}`, { ...api, auth: 'PUBLIC' })).status, 200)
    assert.equal((await call('PUT', `/admin/apis/${api.id}`, { ...api, name: 'stale' })).status, 409)
    assert.equal((await call('GET', `/admin/apis/${api.id}`)).json.auth, 'PUBLIC')
    const never = await call('POST', '/admin/apis', {
      name: 's', code: 'never', path: '/open/never', mode: 'SNAPSHOT', datasourceId, sql: 'SELECT 1 AS id', keyFields: ['id'], cron: '0 0 0 31 2 *',
    })
    assert.equal(never.status, 400)
    assert.equal((await call('POST', '/admin/apis', { ...api, code: 'dupe' })).status, 409)
  })

  test('snapshots sync atomically, keep manual order and filter by type', async () => {
    const api = await createApi({
      name: 'snap', code: 'snap', path: '/open/snap', mode: 'SNAPSHOT', cron: '0 0 3 * * *', keyFields: ['id'],
      fields: [{ name: 'seen', type: 'datetime' }, { name: 'price', type: 'decimal' }], filters: ['seen', 'price'],
      sql: 'SELECT id, name, price, seen FROM databridge_test.item ORDER BY id',
    })
    assert.ok(api.nextSyncAt)
    assert.equal((await call('POST', `/admin/apis/${api.id}/sync`)).json.count, 3)
    const firstSync = await call('GET', `/admin/apis/${api.id}/sync-history`)
    assert.equal(firstSync.status, 200)
    assert.deepEqual(firstSync.json.items.map((item: { trigger: string; status: string; rowCount: number }) =>
      [item.trigger, item.status, item.rowCount]), [['MANUAL', 'SUCCESS', 3]])
    const byTime = await open('/open/snap?seen=2026-09-25T10:00:00%2B08:00')
    assert.deepEqual(byTime.json.data.map((row: { id: number }) => row.id), [1])
    assert.deepEqual((await open('/open/snap?price=1.5')).json.data.map((row: { id: number }) => row.id), [1])
    assert.deepEqual((await open('/open/snap')).json.data.map((row: { id: number }) => row.id), [1, 2, 3])
    assert.equal((await open('/open/snap?name=one')).status, 400)

    const rows = (await call('GET', `/admin/apis/${api.id}/rows`)).json.items
    const noted = await call('PATCH', `/admin/apis/${api.id}/rows/${rows[2].key}/remark`, { version: rows[2].version, remark: '重点复核' })
    assert.equal(noted.status, 200, noted.text)
    assert.equal((await call('PATCH', `/admin/apis/${api.id}/rows/${rows[2].key}/remark`, { version: rows[2].version, remark: '旧备注' })).status, 409)
    assert.equal((await call('PATCH', `/admin/apis/${api.id}/rows/${rows[2].key}/remark`, { version: noted.json.version, remark: 'x'.repeat(2001) })).status, 400)
    assert.equal((await call('GET', `/admin/apis/${api.id}/rows?search=${encodeURIComponent('重点复核')}`)).json.items[0].key, rows[2].key)
    assert.equal((await open('/open/snap?page=2&pageSize=2')).json.data[0].__databridge_remark, '重点复核')
    assert.equal((await call('POST', `/admin/apis/${api.id}/rows/${rows[2].key}/move`, { position: 1 })).status, 204)
    await source.query("INSERT INTO databridge_test.item VALUES (4, 'four', 4, NULL)")
    await call('POST', `/admin/apis/${api.id}/sync`)
    assert.deepEqual((await open('/open/snap')).json.data.map((row: { id: number }) => row.id), [3, 1, 2, 4])
    assert.equal((await open('/open/snap')).json.data[0].__databridge_remark, '重点复核')
    assert.equal((await call('GET', `/admin/apis/${api.id}/rows`)).json.items[0].version, noted.json.version)
    const cleared = await call('PATCH', `/admin/apis/${api.id}/rows/${rows[2].key}/remark`, { version: noted.json.version, remark: '  ' })
    assert.equal(cleared.json.remark, '')
    assert.equal((await open('/open/snap')).json.data[0].__databridge_remark, undefined)

    // Duplicate keys by value ("1.0" vs "1.00") keep the previous snapshot.
    const current = (await call('GET', `/admin/apis/${api.id}`)).json
    const dupes = await call('PUT', `/admin/apis/${api.id}`, { ...current, keyFields: ['k'], fields: [], filters: [], sql: 'SELECT 1.0::numeric AS k UNION ALL SELECT 1.00::numeric' })
    assert.equal(dupes.status, 200, dupes.text)
    assert.equal((await call('POST', `/admin/apis/${api.id}/sync`)).status, 400)
    assert.equal((await open('/open/snap')).json.data.length, 4)
    assert.equal((await call('GET', `/admin/apis/${api.id}`)).json.syncStatus, 'FAILED')
    const failedSync = await call('GET', `/admin/apis/${api.id}/sync-history`)
    assert.equal(failedSync.json.items[0].status, 'FAILED')
    assert.match(failedSync.json.items[0].error, /唯一键重复/)
    assert.equal((await call('GET', `/admin/apis/${api.id}/sync-history?before=nope`)).status, 400)

    // An empty result is refused unless allowed.
    const empty = (await call('PUT', `/admin/apis/${api.id}`, { ...dupes.json, sql: 'SELECT 1 AS k WHERE false' })).json
    assert.equal((await call('POST', `/admin/apis/${api.id}/sync`)).status, 400)
    assert.equal((await call('PUT', `/admin/apis/${api.id}`, { ...empty, allowEmpty: true })).status, 200)
    assert.equal((await call('POST', `/admin/apis/${api.id}/sync`)).json.count, 0)
  })

  test('a sync is discarded when its API or data source changes meanwhile', async () => {
    const api = await createApi({
      name: 'slow', code: 'slow', path: '/open/slow', mode: 'SNAPSHOT', cron: '0 0 3 * * *', keyFields: ['id'],
      sql: 'SELECT id FROM databridge_test.item, pg_sleep(0.3)',
    })
    const sourceChange = apis.sync(api.id)
    await new Promise(resolve => setTimeout(resolve, 100))
    const ds = (await call('GET', '/admin/datasources')).json[0]
    assert.equal((await call('PUT', `/admin/datasources/${datasourceId}`, { ...ds, name: 'renamed-during-sync' })).status, 200)
    await assert.rejects(sourceChange, /数据源配置已变更/)

    const scheduled = apis.sync(api.id, api.version)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await call('POST', `/admin/apis/${api.id}/disable`)).status, 200)
    await assert.rejects(scheduled, /API 配置已变更/)
    assert.equal((await call('GET', `/admin/apis/${api.id}/rows`)).json.total, 0)
    assert.deepEqual(await apis.sync(api.id, api.version), { count: 0 })
  })

  test('manual rows are versioned and migrate with their fields', async () => {
    const api = await createApi({
      name: 'manual', code: 'manual', path: '/open/manual', auth: 'PUBLIC', mode: 'MANUAL', datasourceId: null,
      fields: [{ name: 'code', type: 'string', required: true }, { name: 'toString', type: 'string' }, { name: 'n', type: 'integer' }],
      filters: ['n', 'code'],
    })
    const rowsUrl = `/admin/apis/${api.id}/rows`
    const a = (await call('POST', rowsUrl, { code: '001', n: null })).json
    await call('POST', rowsUrl, { code: '002', n: 5, toString: 'x' })
    assert.equal((await call('POST', rowsUrl, { n: 1 })).status, 400)
    assert.equal((await call('POST', rowsUrl, { code: 'x', extra: 1 })).status, 400)
    assert.deepEqual((await call('GET', '/open/manual', undefined, { 'X-API-Key': '' })).json.data[0], { code: '001', toString: null, n: null })
    assert.equal((await call('POST', '/open/manual', { n: null })).status, 404)
    const filtered = await call('GET', '/open/manual?code=002')
    assert.deepEqual(filtered.json.data.map((row: { code: string }) => row.code), ['002'])

    const note = await call('PATCH', `${rowsUrl}/${a.key}/remark`, { version: a.version, remark: '人工确认' })
    assert.equal(note.status, 200, note.text)
    assert.equal((await open('/open/manual?code=001')).json.data[0].__databridge_remark, '人工确认')
    const updated = await call('PUT', `${rowsUrl}/${a.key}`, { version: note.json.version, data: { code: '001', n: 7 } })
    assert.equal(updated.status, 200)
    assert.equal((await open('/open/manual?n=7')).json.data[0].__databridge_remark, '人工确认')
    assert.equal((await call('PUT', `${rowsUrl}/${a.key}`, { version: a.version, data: { code: 'stale' } })).status, 409)
    assert.equal((await call('DELETE', `${rowsUrl}/${a.key}?version=${a.version}`)).status, 409)

    // Changing "code" to integer rewrites "001" → 1 and bumps the row version.
    const current = (await call('GET', `/admin/apis/${api.id}`)).json
    const migrated = await call('PUT', `/admin/apis/${api.id}`, { ...current, fields: [{ name: 'code', type: 'integer', required: true }, { name: 'n', type: 'integer' }], filters: ['n'] })
    assert.equal(migrated.status, 200, migrated.text)
    const after = (await call('GET', rowsUrl)).json.items[0]
    assert.deepEqual(after.data, { code: 1, n: 7 })
    assert.equal(after.remark, '人工确认')
    assert.equal(after.version, updated.json.version + 1)
    assert.equal((await call('PUT', `${rowsUrl}/${a.key}`, { version: updated.json.version, data: { code: 3 } })).status, 409)
    assert.equal((await call('DELETE', `${rowsUrl}/${a.key}?version=${after.version}`)).status, 204)

    const incompatible = await call('PUT', `/admin/apis/${api.id}`, { ...migrated.json, fields: [{ name: 'code', type: 'boolean' }], filters: [] })
    assert.equal(incompatible.status, 409)
  })

  test('null filters match missing values on POST', async () => {
    const api = await createApi({
      name: 'nulls', code: 'nulls', path: '/open/nulls', method: 'POST', auth: 'PUBLIC', mode: 'MANUAL', datasourceId: null,
      fields: [{ name: 'n', type: 'integer' }, { name: 's', type: 'string' }], filters: ['n', 's'],
    })
    await call('POST', `/admin/apis/${api.id}/rows`, { n: null, s: null })
    await call('POST', `/admin/apis/${api.id}/rows`, { n: 1, s: 'null' })
    assert.equal((await call('POST', '/open/nulls', { n: null })).json.data.length, 1)
    assert.deepEqual((await call('POST', '/open/nulls', { s: null })).json.data, [{ n: null, s: null }])
    assert.deepEqual((await call('POST', '/open/nulls', { s: 'null' })).json.data, [{ n: 1, s: 'null' }])
  })

  test('logs, unknown routes and password change', async () => {
    const from = new Date(Date.now() - 60_000).toISOString().replace('Z', '+00:00')
    const logs = await call('GET', `/admin/logs?from=${encodeURIComponent(from)}&ok=false`)
    assert.equal(logs.status, 200)
    assert.ok(logs.json.items.length > 0)
    assert.ok(logs.json.items.every((item: { ok: boolean }) => !item.ok))
    assert.equal((await call('GET', '/admin/logs?from=2026-01-01T00:00:00')).status, 400)
    const missing = await call('GET', '/admin/nothing-here')
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('X-Request-ID'), missing.json.request_id)
    assert.equal((await call('GET', '/missing-asset.js')).status, 404)
    assert.equal((await call('DELETE', `/admin/datasources/${datasourceId}`)).status, 409)
    const snapshotDraft = { mode: 'SNAPSHOT', datasourceId, sql: 'SELECT 1 AS id' }
    assert.equal((await call('POST', '/admin/apis/test', { api: snapshotDraft })).json.count, 1)

    assert.equal((await call('POST', '/admin/password', { currentPassword: 'initial-password-1', newPassword: 'short' })).status, 400)
    assert.equal((await call('POST', '/admin/password', { currentPassword: 'initial-password-1', newPassword: 'a-new-password-2' })).status, 204)
    assert.equal((await call('GET', '/admin/apis')).status, 401)
    assert.equal((await call('POST', '/auth/login', { username: 'admin', password: 'a-new-password-2' })).status, 200)
  })
})
