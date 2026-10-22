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

test('call previews redact credentials and preserve exact numeric values and repeated query parameters', async () => {
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
    assert.match(trace.body!, /9007199254740993/)
    assert.match(trace.body!, /1\.10/)
    assert.equal(JSON.parse(trace.headers)['user-agent'], 'SyntheticClient/1')
    assert.equal(JSON.parse(trace.headers)['x-custom-ticket'], '[REDACTED]')
    assert.doesNotMatch(JSON.stringify(trace), /hidden-ticket|hidden-password|hidden-key|synthetic-user-ticket|synthetic-bare-key|synthetic-cookie|synthetic-api-key|synthetic-service-secret/)
    const numeric = callDiagnostics(new Request('https://bridge.example.invalid/open/request-logs', {
      method: 'POST', headers: { 'X-Custom-Ticket': '9007199254740993' },
    }), api)
    numeric.captureBody('{"alias":9007199254740993,"ordinaryNumber":7}')
    assert.deepEqual(JSON.parse(numeric.trace.body!), { alias: '[REDACTED]', ordinaryNumber: 7 })
  } finally { await f.close() }
})

test('previews remain bounded in UTF-8 and malformed JSON is omitted without retaining secrets', () => {
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
  assert.equal(malformed.trace.body, null)
  assert.match(malformed.trace.bodyNote!, /不是有效的 JSON/)
  assert.doesNotMatch(JSON.stringify(malformed.trace), /hidden-malformed-secret/)
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
    assert.equal(last().body, null)
    assert.match(last().bodyNote!, /不是有效的 JSON/)
    f.apis.save(api.id, { ...definition, method: 'POST', auth: 'API_KEY', version: f.apis.get(api.id).version })
    response = await f.app.request('/open/request-logs', { method: 'POST', headers: { 'X-API-Key': 'invalid-synthetic-key' }, body: '{"q":"query-one","alias":"invalid-synthetic-key"}' })
    assert.equal(response.status, 401)
    assert.equal(last().status, 401)
    assert.equal(JSON.parse(last().body!).q, 'query-one')
    assert.doesNotMatch(JSON.stringify(last()), /invalid-synthetic-key/)
    response = await f.app.request('/open/missing?q=missing-input')
    assert.equal(response.status, 404)
    assert.equal(last().status, 404)
    assert.equal(last().path, '/open/missing')
    assert.equal(f.logs.list({}).items[0].apiId, null)
    const stored = JSON.stringify(f.db.prepare('SELECT detail FROM request_detail_log').all())
    assert.doesNotMatch(stored, /invalid-synthetic-key|never-persist/)
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
    assert.equal(JSON.parse((await response.json()).request.query).q, 'admin-only-query')
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
    f.db.exec(`DROP TABLE request_detail_log; ALTER TABLE request_log DROP COLUMN method;
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
