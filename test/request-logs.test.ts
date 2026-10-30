import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Apis } from '../server/apis.ts'
import { createApp } from '../server/app.ts'
import { Auth } from '../server/auth.ts'
import { loadConfig } from '../server/config.ts'
import { now, openDb } from '../server/db.ts'
import { validateExternalAuth } from '../server/external-auth.ts'
import { Logs } from '../server/logs.ts'
import { callDiagnostics } from '../server/request-diagnostics.ts'
import { Sources } from '../server/sources.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-request-log-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'synthetic-log-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config), apis = new Apis(db, sources, config)
  const logs = new Logs(db), app = createApp({ config, db, auth, sources, apis, logs })
  return { config, db, auth, sources, apis, logs, app, async close() {
    apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true })
  } }
}
const definition = { name: 'Request logs', code: 'request_logs', path: '/open/request-logs', mode: 'MANUAL', auth: 'PUBLIC', enabled: true,
  fields: [{ name: 'q', type: 'string' }, { name: 'id', type: 'integer' }, { name: 'amount', type: 'decimal' }], filters: ['q', 'id', 'amount'] }

test('24-hour stats count every recorded outcome across pagination and preserve exact time boundaries', async t => {
  const end = Date.parse('2026-10-22T04:00:00.123Z'), start = end - 86_400_000
  t.mock.timers.enable({ apis: ['Date'], now: end })
  const f = fixture()
  try {
    const api = f.apis.save(undefined, definition)
    let sequence = 0
    const write = (at: number, ok: boolean, apiId: number | null = null, streaming = false) => {
      const trace = streaming ? callDiagnostics(new Request('http://localhost/open/stream')).trace : undefined
      if (trace) { trace.status = 200; trace.responseType = 'text/event-stream' }
      f.logs.write({ requestId: `stats-${++sequence}`, at: new Date(at).toISOString(), apiId, mode: null,
        elapsedMs: 1, rowCount: 0, ok, error: ok ? null : 'synthetic failure', requestTrace: trace })
    }
    write(start - 1, false)
    write(end + 1, false)
    write(start, false)
    write(end, false)
    write(start + 1, false, null, true) // SSE may fail after sending HTTP 200.
    write(start + 1, true, api.id)
    f.apis.remove(api.id)
    for (let i = 0; i < 600; i++) write(end - 1, true)
    assert.ok(f.logs.list({ limit: '8' }).items.every(item => item.ok))
    assert.equal(f.logs.list({ limit: '1000' }).items.length, 500)
    const stats = f.logs.stats()
    assert.deepEqual(stats, { from: new Date(start).toISOString(), to: new Date(end).toISOString(), total: 604, failed: 3 })
    const failures = f.logs.list({ from: stats.from, to: stats.to, ok: 'false' })
    assert.equal(failures.items.length, stats.failed)
    assert.ok(failures.items.every(item => !item.ok))
  } finally { await f.close() }
})

test('stats require an administrator and report empty, successful and rejected calls correctly', async () => {
  const f = fixture()
  try {
    assert.equal((await f.app.request('/admin/logs/stats')).status, 401)
    await f.auth.bootstrap()
    const token = await f.auth.login('admin', 'synthetic-log-password', 'test')
    const headers = { Cookie: `databridge_session=${token}` }
    const read = async () => {
      const response = await f.app.request('/admin/logs/stats', { headers })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      return await response.json()
    }
    let stats = await read()
    assert.equal(stats.total, 0)
    assert.equal(stats.failed, 0)
    assert.equal(Date.parse(stats.to) - Date.parse(stats.from), 86_400_000)
    f.apis.save(undefined, definition)
    assert.equal((await f.app.request('/open/request-logs')).status, 200)
    assert.equal((await f.app.request('/open/missing')).status, 404)
    stats = await read()
    assert.equal(stats.total, 2)
    assert.equal(stats.failed, 1)
  } finally { await f.close() }
})

test('call previews retain original values, exact numbers and repeated query parameters', async () => {
  const f = fixture()
  try {
    const api = f.apis.save(undefined, definition)
    api.externalAuth = validateExternalAuth({ url: 'https://identity.example.invalid', inputHeader: 'X-Custom-Ticket', inputPrefix: 'Bearer ',
      tokenLocation: 'query', tokenName: 'ticket', headers: { 'X-Service-Key': 'synthetic-service-secret' } })
    const diagnostic = callDiagnostics(new Request('https://bridge.example.invalid/open/request-logs?q=one&q=two&ticket=hidden-ticket&alias=synthetic-bare-key', {
      method: 'POST', headers: { 'X-Custom-Ticket': 'Bearer synthetic-user-ticket', Authorization: 'Bearer synthetic-bare-key',
        'X-API-Key': 'synthetic-api-key', Cookie: 'session=synthetic-cookie', 'User-Agent': 'SyntheticClient/1' },
    }), api)
    diagnostic.captureBody('{"id":9007199254740993,"amount":1.10,"nested":{"password":"hidden-password","api_key":"hidden-key"},"alias":"synthetic-user-ticket","cookieAlias":"synthetic-cookie","keyAlias":"synthetic-api-key","serviceAlias":"synthetic-service-secret"}')
    const trace = diagnostic.trace
    assert.deepEqual(JSON.parse(trace.query).q, ['one', 'two'])
    assert.match(trace.url!, /^https:\/\/bridge\.example\.invalid\/open\/request-logs\?/)
    assert.deepEqual(new URL(trace.url!).searchParams.getAll('q'), ['one', 'two'])
    assert.equal(new URL(trace.url!).searchParams.get('ticket'), 'hidden-ticket')
    assert.match(trace.body!, /9007199254740993/)
    assert.match(trace.body!, /1\.10/)
    assert.equal(JSON.parse(trace.headers)['user-agent'], 'SyntheticClient/1')
    assert.equal(JSON.parse(trace.headers)['x-custom-ticket'], 'Bearer synthetic-user-ticket')
    assert.equal(JSON.parse(trace.headers).authorization, 'Bearer synthetic-bare-key')
    assert.equal(JSON.parse(trace.headers).cookie, 'session=synthetic-cookie')
    assert.equal(JSON.parse(trace.body!).nested.password, 'hidden-password')
    assert.equal(JSON.parse(trace.body!).serviceAlias, 'synthetic-service-secret')
    assert.doesNotMatch(JSON.stringify(trace), /\[REDACTED\]/)
    const numeric = callDiagnostics(new Request('https://bridge.example.invalid/open/request-logs', {
      method: 'POST', headers: { 'X-Custom-Ticket': '9007199254740993' },
    }), api)
    numeric.captureBody('{"alias":9007199254740993,"ordinaryNumber":7}')
    assert.match(numeric.trace.body!, /"alias": 9007199254740993/)
    assert.equal(JSON.parse(numeric.trace.body!).ordinaryNumber, 7)
    assert.doesNotMatch(JSON.stringify(numeric.trace), /\[REDACTED\]/)
  } finally { await f.close() }
})

test('previews remain bounded in UTF-8 and malformed JSON retains its original text', () => {
  const diagnostic = callDiagnostics(new Request('https://bridge.example.invalid/open/test?q=' + '长'.repeat(5000), {
    method: 'POST', headers: { 'User-Agent': '长'.repeat(5000).replaceAll('长', 'abc') },
  }))
  diagnostic.captureBody(JSON.stringify({ q: '长'.repeat(5000), password: 'hidden-password' }))
  for (const key of ['query', 'headers', 'body'] as const) {
    assert.ok(Buffer.byteLength(diagnostic.trace[key]!) <= 8192)
    assert.ok(!diagnostic.trace[key]!.endsWith('\uFFFD'))
  }
  assert.equal(diagnostic.trace.queryTruncated, true)
  assert.equal(diagnostic.trace.headersTruncated, true)
  assert.equal(diagnostic.trace.bodyTruncated, true)
  const malformed = callDiagnostics(new Request('https://bridge.example.invalid/open/test', { method: 'POST' }))
  malformed.captureBody('{"password": "hidden-malformed-secret')
  assert.equal(malformed.trace.body, '{"password": "hidden-malformed-secret')
  assert.match(malformed.trace.bodyNote!, /不是有效的 JSON/)
  malformed.captureBody('{"q":"' + '长'.repeat(5000))
  assert.equal(malformed.trace.bodyTruncated, true)
  assert.ok(Buffer.byteLength(malformed.trace.body!) <= 8192)
  assert.ok(!malformed.trace.body!.endsWith('\uFFFD'))
})

test('GET, POST, rejected authorization and invalid parameters retain request details with actual status', async () => {
  const f = fixture()
  try {
    const api = f.apis.save(undefined, definition)
    f.apis.createRow(api.id, { q: 'query-one', id: 1, amount: '1.10' })
    const last = () => f.logs.detail(f.logs.list({}).items[0].id).request!
    let response = await f.app.request('/open/request-logs?q=query-one&page=1&pageSize=2')
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(last().query), { q: 'query-one', page: '1', pageSize: '2' })
    assert.equal(last().status, 200)
    assert.equal(last().body, null)
    assert.equal(last().url, 'http://localhost/open/request-logs?q=query-one&page=1&pageSize=2')
    assert.equal(last().api!.name, definition.name)
    assert.equal(last().api!.code, definition.code)
    assert.equal(last().api!.version, api.version)
    assert.deepEqual(last().pagination, { page: 1, pageSize: 2 })
    assert.deepEqual(JSON.parse(last().parameters!), { q: 'query-one' })
    const wire = await response.text()
    assert.deepEqual(JSON.parse(last().responseBody!), JSON.parse(wire))
    assert.equal(last().responseBytes, Buffer.byteLength(wire))
    assert.equal(last().statusText, 'OK')
    assert.deepEqual(JSON.parse(last().responseHeaders!), Object.fromEntries(response.headers))
    assert.equal(JSON.parse(last().responseHeaders!)['x-request-id'], f.logs.list({}).items[0].requestId)
    assert.ok(last().steps!.every(step => step.ok && step.elapsedMs >= 0))
    assert.equal(last().errorStage, null)
    assert.equal(f.logs.list({}).items[0].rowCount, 1)
    f.apis.save(api.id, { ...definition, method: 'POST', version: api.version })
    response = await f.app.request('/open/request-logs?context=example', { method: 'POST', body: '{"id":9007199254740993,"amount":1.10}' })
    assert.equal(response.status, 200)
    assert.match(last().body!, /9007199254740993/)
    assert.match(last().body!, /1\.10/)
    assert.equal(JSON.parse(last().query).context, 'example')
    assert.equal((await f.app.request('/open/request-logs', { method: 'POST', body: '{"unknown":"example"}' })).status, 400)
    assert.equal(last().status, 400)
    assert.equal(JSON.parse(last().body!).unknown, 'example')
    assert.equal((await f.app.request('/open/request-logs', { method: 'POST', body: '{"password":"never-persist' })).status, 400)
    assert.equal(last().body, '{"password":"never-persist')
    assert.match(last().bodyNote!, /不是有效的 JSON/)
    f.apis.save(api.id, { ...definition, method: 'POST', auth: 'API_KEY', version: f.apis.get(api.id).version })
    response = await f.app.request('/open/request-logs', { method: 'POST', headers: { 'X-API-Key': 'invalid-synthetic-key' }, body: '{"q":"query-one","alias":"invalid-synthetic-key"}' })
    assert.equal(response.status, 401)
    assert.equal(last().status, 401)
    assert.equal(last().errorStage, 'access')
    assert.equal(last().steps!.at(-1)!.ok, false)
    assert.deepEqual(JSON.parse(last().responseBody!), await response.json())
    assert.deepEqual(JSON.parse(last().responseHeaders!), Object.fromEntries(response.headers))
    assert.equal(JSON.parse(last().body!).q, 'query-one')
    assert.equal(JSON.parse(last().headers)['x-api-key'], 'invalid-synthetic-key')
    assert.equal(JSON.parse(last().body!).alias, 'invalid-synthetic-key')
    response = await f.app.request('/open/missing?q=missing-input')
    assert.equal(response.status, 404)
    assert.equal(last().status, 404)
    assert.equal(last().path, '/open/missing')
    assert.equal(last().errorStage, 'routing')
    assert.equal(last().api, null)
    assert.equal(JSON.parse(last().responseBody!).code, 40401)
    assert.equal(f.logs.list({}).items[0].apiId, null)
    const stored = JSON.stringify(f.db.prepare('SELECT detail FROM request_detail_log').all())
    assert.match(stored, /invalid-synthetic-key/)
    assert.match(stored, /never-persist/)
    assert.doesNotMatch(stored, /\[REDACTED\]/)
    assert.doesNotMatch(JSON.stringify(f.logs.list({})), /query-one|missing-input|9007199254740993/)
  } finally { await f.close() }
})

test('call details require admin access, remain readable after API deletion and follow log retention', async () => {
  const f = fixture()
  try {
    const api = f.apis.save(undefined, definition)
    await f.app.request('/open/request-logs?q=admin-only-query')
    const log = f.logs.list({}).items[0]
    const path = `/admin/logs/${log.id}/details`
    assert.equal((await f.app.request(path)).status, 401)
    await f.auth.bootstrap()
    const token = await f.auth.login('admin', 'synthetic-log-password', 'test')
    const headers = { Cookie: `databridge_session=${token}` }
    f.apis.remove(api.id)
    const response = await f.app.request(path, { headers })
    assert.equal(response.status, 200)
    const detail = (await response.json()).request
    assert.equal(JSON.parse(detail.query).q, 'admin-only-query')
    assert.equal(detail.api.name, definition.name)
    assert.equal(detail.api.code, definition.code)
    assert.equal(detail.api.id, api.id)
    assert.equal(detail.url, 'http://localhost/open/request-logs?q=admin-only-query')
    assert.equal((await f.app.request('/admin/logs/9999/details', { headers })).status, 404)
    f.db.prepare('UPDATE request_log SET at = ?').run('2000-01-01T00:00:00.000Z')
    f.logs.prune(30)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM request_detail_log').get()!.n, 0)
    assert.equal((await f.app.request(path, { headers })).status, 404)
  } finally { await f.close() }
})

test('v1.2.1 logs upgrade without losing summaries and remain explicitly without input previews', async () => {
  const f = fixture()
  try {
    f.logs.write({ requestId: 'legacy-request', at: now(), apiId: null, mode: 'MANUAL', elapsedMs: 3, rowCount: 2, ok: true, error: null })
    f.db.exec(`DROP TRIGGER api_key_access_delete; DROP TRIGGER api_key_access_auth; DROP TABLE api_key_access;
      DROP TABLE api_project; DROP TABLE project; ALTER TABLE api DROP COLUMN project_version;
      DROP TABLE request_detail_log; ALTER TABLE request_log DROP COLUMN method;
      ALTER TABLE request_log DROP COLUMN path; ALTER TABLE request_log DROP COLUMN status; PRAGMA user_version = 7;`)
    const upgraded = openDb(f.config.dbFile)
    try {
      const logs = new Logs(upgraded), item = logs.list({}).items[0]
      assert.equal(item.requestId, 'legacy-request')
      assert.equal(item.rowCount, 2)
      assert.equal(item.hasRequest, false)
      assert.equal(item.status, null)
      assert.deepEqual(logs.detail(item.id), { request: null, externalAuth: null })
    } finally { upgraded.close() }
    assert.equal((await f.app.request('/open/new-request')).status, 404)
    assert.equal(f.logs.list({}).items[0].hasRequest, true)
  } finally { await f.close() }
})


test('response previews preserve exact numbers and cross-field copies and bound every stored preview', () => {
  const diagnostic = callDiagnostics(new Request('https://bridge.example.invalid/open/test?alias=request-secret', {
    method: 'POST', headers: { 'X-Alias': 'request-secret' },
  }))
  diagnostic.captureBody('{"password":"request-secret","alias":"response-secret","id":9007199254740993}')
  diagnostic.captureResponseBody('{"id":9007199254740993,"amount":1.10,"token":"response-secret","alias":"response-secret","nested":{"password":"nested-secret"},"requestAlias":"request-secret","text":"' + '长'.repeat(5000) + '"}')
  diagnostic.captureResponse(new Response(null, { status: 200, headers: {
    'Content-Type': 'application/json', 'Set-Cookie': 'session=response-cookie; HttpOnly', 'X-Echo': 'request-secret',
  } }))
  assert.match(diagnostic.trace.responseBody!, /9007199254740993/)
  assert.match(diagnostic.trace.responseBody!, /1\.10/)
  assert.match(diagnostic.trace.responseBody!, /response-secret/)
  assert.match(diagnostic.trace.responseBody!, /nested-secret/)
  assert.equal(JSON.parse(diagnostic.trace.body!).password, 'request-secret')
  assert.equal(JSON.parse(diagnostic.trace.headers)['x-alias'], 'request-secret')
  assert.equal(new URL(diagnostic.trace.url!).searchParams.get('alias'), 'request-secret')
  assert.doesNotMatch(JSON.stringify(diagnostic.trace), /\[REDACTED\]/)
  assert.equal(diagnostic.trace.responseBodyTruncated, true)
  assert.equal(JSON.parse(diagnostic.trace.responseHeaders!)['set-cookie'], 'session=response-cookie; HttpOnly')
  for (const key of ['url','query','headers','body','responseHeaders','responseBody'] as const) {
    assert.ok(Buffer.byteLength(diagnostic.trace[key]!) <= 8192)
    assert.ok(!diagnostic.trace[key]!.endsWith('\uFFFD'))
  }
})

test('client address respects proxy trust and stored API snapshots do not follow later edits', async () => {
  const f = fixture()
  try {
    const api = f.apis.save(undefined, definition)
    const request = () => f.app.request('https://bridge.example.invalid/open/request-logs?q=example', {
      headers: { 'X-Forwarded-For': '203.0.113.42, 10.0.0.8', 'User-Agent': 'SyntheticCaller/2' },
    })
    await request()
    const first = f.logs.list({}).items[0]
    assert.equal(f.logs.detail(first.id).request!.clientAddress, 'unknown')
    f.config.trustProxy = true
    await request()
    assert.equal(f.logs.detail(f.logs.list({}).items[0].id).request!.clientAddress, '203.0.113.42')
    f.apis.save(api.id, { ...definition, name: 'Renamed interface', code: 'renamed_interface', version: api.version })
    assert.equal(f.logs.detail(first.id).request!.api!.name, definition.name)
    assert.equal(f.logs.detail(first.id).request!.api!.code, definition.code)
  } finally { await f.close() }
})
