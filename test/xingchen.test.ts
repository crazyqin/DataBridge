import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { sm2 } from 'sm-crypto-v2'
import { Apis } from '../server/apis.ts'
import { createApp } from '../server/app.ts'
import { Auth } from '../server/auth.ts'
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { HttpError } from '../server/errors.ts'
import { parse, type JsonObject } from '../server/json.ts'
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'
import { encryptStaffCode, Xingchen } from '../server/xingchen.ts'

const keys = sm2.generateKeyPairHex()
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected
async function provider(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-xingchen-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'test-admin-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile)
  const auth = new Auth(db, config)
  const sources = new Sources(db, config)
  const apis = new Apis(db, sources, config)
  const logs = new Logs(db)
  const app = createApp({ config, db, auth, sources, apis, logs })
  return { db, auth, sources, apis, app, logs, async close() {
    apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true })
  } }
}
const definition = (url: string): JsonObject => ({
  name: 'test-agent', code: 'test_agent', path: '/open/test-agent', method: 'POST', mode: 'XINGCHEN', auth: 'EXTERNAL', enabled: true,
  externalAuth: { url: `${url}/identity`, method: 'GET', inputHeader: 'Authorization', inputPrefix: 'Bearer ',
    tokenLocation: 'header', tokenName: 'Authorization', tokenPrefix: 'Bearer ', successPath: 'active', successValue: true,
    bindings: [{ name: '_auth_staff_code', path: 'data.staffCode', type: 'string' }] },
  params: [{ name: 'q', type: 'string', required: true }, { name: 'conversation_id', type: 'string', required: false }],
  xingchen: { baseUrl: `${url}/v1`, appId: 'test-app', apiKey: 'synthetic-platform-key', publicKey: keys.publicKey,
    staffCodeBinding: '_auth_staff_code', inputMappings: [{ parameter: 'q', variable: 'q' }], queryParam: 'q',
    conversationParam: 'conversation_id', responseMode: 'blocking' },
})

test('staff token contains UTF-8 JSON, seconds and fresh 16-byte nonces in raw C1C3C2 format', () => {
  const start = Math.floor(Date.now() / 1000)
  const one = encryptStaffCode('00123测试', keys.publicKey)
  const two = encryptStaffCode('00123测试', keys.publicKey)
  assert.match(one, /^v2\.[A-Za-z0-9_-]+$/)
  assert.notEqual(one, two)
  const plain = (token: string) => JSON.parse(sm2.doDecrypt(Buffer.from(token.slice(3), 'base64url').toString('hex'), keys.privateKey, 1, { output: 'string' }))
  const a = plain(one), b = plain(two)
  assert.equal(a.staff_code, '00123测试')
  assert.ok(a.iat >= start && a.iat <= Math.floor(Date.now() / 1000))
  assert.equal(Buffer.from(a.nonce, 'base64url').length, 16)
  assert.notEqual(a.nonce, b.nonce)
  assert.equal(Buffer.from(one.slice(3), 'base64url').length, 96 + Buffer.byteLength(JSON.stringify(a)))
})

test('independent OpenSSL implementation decrypts the platform C1C3C2 token', { skip: spawnSync('openssl', ['version']).status !== 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-sm2-'))
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'SM2' })
    writeFileSync(join(dir, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const point = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65).toString('hex')
    const raw = Buffer.from(encryptStaffCode('00042测试', point).slice(3), 'base64url')
    // OpenSSL uses ASN.1; encode the raw wire components without changing their values/order.
    const tlv = (tag: number, bytes: Buffer) => Buffer.concat([Buffer.from([tag, ...(bytes.length < 128 ? [bytes.length] : [0x82, bytes.length >> 8, bytes.length & 255])]), bytes])
    const integer = (bytes: Buffer) => { while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1); return tlv(2, bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes) }
    const der = tlv(0x30, Buffer.concat([integer(raw.subarray(0, 32)), integer(raw.subarray(32, 64)), tlv(4, raw.subarray(64, 96)), tlv(4, raw.subarray(96))]))
    const plain = execFileSync('openssl', ['pkeyutl', '-decrypt', '-inkey', join(dir, 'key.pem')], { input: der })
    assert.equal(JSON.parse(plain.toString()).staff_code, '00042测试')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('saved and draft forwarding authenticate first, encrypt trusted staff, and map input_data.q', async t => {
  const received: { url: string; headers: IncomingMessage['headers']; body: JsonObject }[] = []
  let active = true
  let staff: string | null = '00042'
  let upstreamStatus = 200
  let upstreamType = 'application/json'
  let upstreamBody = JSON.stringify({ event: 'message', answer: '[{"name":"synthetic person"}]', conversation_id: 'conversation-test' })
  const upstream = await provider((req, res) => {
    if (req.url === '/identity') {
      res.setHeader('Content-Type', 'application/json')
      assert.equal(req.headers.authorization, 'Bearer user-test-token')
      res.end(JSON.stringify({ active, data: { staffCode: staff } }))
      return
    }
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      received.push({ url: req.url!, headers: req.headers, body: parse(raw) as JsonObject })
      res.writeHead(upstreamStatus, { 'Content-Type': upstreamType, 'Set-Cookie': 'synthetic-private-cookie', Location: '/must-not-follow' })
      res.end(upstreamBody)
    })
  })
  const f = fixture()
  const api = f.apis.save(undefined, definition(upstream.url))
  const call = (input: unknown, token = 'Bearer user-test-token') => f.app.request('/open/test-agent', {
    method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  try {
    await t.test('encrypted persistence, round trip, updates and stale versions', () => {
      const stored = f.db.prepare('SELECT xingchen FROM api WHERE id = ?').get(api.id) as { xingchen: string }
      for (const secret of [upstream.url, 'synthetic-platform-key', keys.publicKey, 'test-app']) assert.ok(!stored.xingchen.includes(secret))
      assert.deepEqual(f.apis.get(api.id).xingchen, api.xingchen)
      assert.equal(api.datasourceId, null)
      assert.equal(api.sql, null)
      const updated = f.apis.save(api.id, { ...definition(upstream.url), version: api.version })
      assert.equal(updated.version, api.version + 1)
      assert.throws(() => f.apis.save(api.id, { ...definition(upstream.url), version: api.version }), status(409))
    })
    await t.test('blocking response and multi-turn conversation are preserved without platform headers', async () => {
      const response = await call({ q: '示例查询', conversation_id: 'previous-test' })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('cache-control')!, /no-store/)
      assert.equal(response.headers.get('set-cookie'), null)
      assert.equal(response.headers.get('location'), null)
      assert.deepEqual(await response.json(), JSON.parse(upstreamBody))
      const outgoing = received.at(-1)!
      assert.equal(outgoing.url, '/v1/chat-messages/test-app')
      assert.equal(outgoing.headers.authorization, 'Bearer synthetic-platform-key')
      assert.deepEqual(outgoing.body, { input_data: { q: '示例查询' }, query: '示例查询', mode: 'blocking', conversation_id: 'previous-test' })
      const token = outgoing.headers['znt-staff-code'] as string
      assert.equal(JSON.parse(sm2.doDecrypt(Buffer.from(token.slice(3), 'base64url').toString('hex'), keys.privateKey, 1, { output: 'string' })).staff_code, '00042')
      assert.ok(!JSON.stringify(outgoing).includes('user-test-token'))
      const logs = JSON.stringify(f.logs.list({}))
      assert.doesNotMatch(logs, /synthetic-platform-key|00042|示例查询|synthetic person/)
      const detail = f.logs.detail(f.logs.list({}).items[0].id).request!
      assert.equal(detail.status, 200)
      assert.match(detail.body!, /示例查询|previous-test/)
      assert.doesNotMatch(JSON.stringify(detail), /synthetic-platform-key|user-test-token|synthetic person/)
    })
    await t.test('missing credential, rejected identity or missing staff never contacts the platform', async () => {
      const count = received.length
      assert.equal((await call({ q: 'test' }, '')).status, 401)
      active = false
      assert.equal((await call({ q: 'test' })).status, 401)
      active = true; staff = null
      assert.equal((await call({ q: 'test' })).status, 502)
      staff = '00042'
      assert.equal(received.length, count)
    })
    await t.test('spoofed identity, credentials and undeclared parameters are rejected', async () => {
      const count = received.length
      for (const field of ['_auth_staff_code', 'staff_code', 'app_id', 'api_key', 'public_key', 'page']) {
        assert.equal((await call({ q: 'test', [field]: 'spoofed' })).status, 400)
      }
      assert.equal((await call({})).status, 400)
      assert.equal((await call({ q: '  ' })).status, 400)
      assert.equal(received.length, count)
    })
    await t.test('upstream rejections, redirects and invalid content stay generic', async () => {
      for (const code of [401, 403, 302, 500]) {
        upstreamStatus = code; upstreamBody = 'synthetic-platform-key internal.example.invalid'
        const response = await call({ q: 'test' })
        assert.equal(response.status, 502)
        assert.doesNotMatch(await response.text(), /synthetic-platform-key|internal.example.invalid/)
      }
      upstreamStatus = 200; upstreamType = 'text/html'
      assert.equal((await call({ q: 'test' })).status, 502)
      upstreamType = 'application/json'
      assert.equal((await call({ q: 'test' })).status, 502)
      upstreamBody = '{"event":"error","message":"private failure"}'
      assert.equal((await call({ q: 'test' })).status, 502)
    })
    await t.test('GET forwards query parameters and empty search results', async () => {
      const get = { ...definition(upstream.url), code: 'get_agent', path: '/open/get-agent', method: 'GET' }
      f.apis.save(undefined, get)
      upstreamBody = '{"event":"message","answer":"[]"}'
      const response = await f.app.request('/open/get-agent?q=test', { headers: { Authorization: 'Bearer user-test-token' } })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).answer, '[]')
    })
    await t.test('admin test works on unsaved forwarding config and uses blocking without a datasource', async () => {
      await f.auth.bootstrap()
      const login = await f.app.request('/auth/login', { method: 'POST', headers: { 'X-Requested-With': 'DataBridge', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-admin-password' }) })
      const draft = definition(upstream.url)
      ;(draft.xingchen as JsonObject).responseMode = 'streaming'
      const response = await f.app.request('/admin/apis/test', { method: 'POST', headers: {
        Cookie: login.headers.get('set-cookie')!.split(';')[0], 'X-Requested-With': 'DataBridge', 'Content-Type': 'application/json',
        'X-DataBridge-Test-Credential': 'Bearer user-test-token',
      }, body: JSON.stringify({ api: draft, params: { q: 'draft' } }) })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.response.answer, '[]')
      assert.equal(result.externalAuthTrace.ok, true)
      assert.equal(received.at(-1)!.body.mode, 'blocking')
    })
    await t.test('SSE bytes and error events are passed through and final logs reflect stream outcome', async () => {
      const draft = definition(upstream.url)
      ;(draft.xingchen as JsonObject).responseMode = 'streaming'
      f.apis.save(api.id, { ...draft, version: f.apis.get(api.id).version })
      upstreamType = 'text/event-stream'
      upstreamBody = 'data: {"event":"message","answer":"示例"}\n\ndata: {"event":"error","code":"inner_error"}\n\n'
      const response = await call({ q: 'test' })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /text\/event-stream/)
      assert.equal(await response.text(), upstreamBody)
      assert.equal(f.logs.list({}).items[0].ok, false)
      assert.match(f.logs.list({}).items[0].error!, /流内错误/)
      const detail = f.logs.detail(f.logs.list({}).items[0].id).request!
      assert.equal(detail.status, 200)
      assert.match(detail.responseType!, /text\/event-stream/)
      assert.equal(JSON.parse(detail.body!).q, 'test')
      upstreamBody = 'data: {"event":"message_end","conversation_id":"next"}\n\n'
      assert.equal(await (await call({ q: 'test' })).text(), upstreamBody)
      assert.equal(f.logs.list({}).items[0].ok, true)
    })
  } finally { await f.close(); await upstream.close() }
})

test('forwarding validates public keys, identity and parameter mappings without accepting a public API', async () => {
  const f = fixture()
  try {
    const draft = definition('http://127.0.0.1')
    assert.throws(() => f.apis.validate({ ...draft, auth: 'PUBLIC' }), status(400))
    const change = (value: JsonObject) => ({ ...draft, xingchen: { ...draft.xingchen as JsonObject, ...value } })
    for (const value of [
      { publicKey: '04' + '0'.repeat(128) }, { publicKey: keys.publicKey.slice(2) }, { baseUrl: 'https://user:pass@example.com/v1' },
      { baseUrl: 'file:///tmp/test' }, { appId: '../test' }, { apiKey: 'key\r\ninjected: yes' }, { staffCodeBinding: 'q' },
      { queryParam: 'unknown' }, { inputMappings: [{ parameter: 'unknown', variable: 'q' }] },
      { inputMappings: [{ parameter: 'q', variable: 'q' }, { parameter: 'q', variable: 'q' }] },
    ] as JsonObject[]) assert.throws(() => f.apis.validate(change(value)), status(400))
    assert.throws(() => f.apis.validate({ ...draft, params: [{ name: '_auth_fake', type: 'string' }] }), status(400))
  } finally { await f.close() }
})

test('timeouts, cancellation and response bounds release forwarding capacity', async t => {
  const f = fixture()
  let behavior = 'slow'
  const upstream = await provider((_req, res) => {
    if (behavior === 'slow') return
    if (behavior === 'large') { res.setHeader('Content-Type', 'application/json'); res.end('x'.repeat(8 * 1024 * 1024 + 1)); return }
    if (behavior === 'stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"event":"message","answer":"first"}\n\n'); return }
    res.setHeader('Content-Type', 'application/json'); res.end('{"event":"message","answer":"[]"}')
  })
  try {
    const api = f.apis.validate(definition(upstream.url))
    const forward = new Xingchen(1)
    const identity = { _auth_staff_code: '00042' }
    await t.test('timeout and abort during headers', async () => {
      const pending = forward.forward({ ...api, timeoutSeconds: 0.05 }, { q: 'test' }, identity)
      await assert.rejects(forward.forward(api, { q: 'test' }, identity), status(503))
      await assert.rejects(pending, status(504))
      const abort = new AbortController()
      const canceled = forward.forward(api, { q: 'test' }, identity, { signal: abort.signal })
      abort.abort()
      await assert.rejects(canceled, status(504))
    })
    await t.test('oversized body is bounded', async () => {
      behavior = 'large'
      await assert.rejects(forward.forward(api, { q: 'test' }, identity), status(502))
    })
    await t.test('stream timeout yields an error event; caller cancellation releases capacity', async () => {
      behavior = 'stream'
      const streaming = { ...api, xingchen: { ...api.xingchen!, responseMode: 'streaming' as const }, timeoutSeconds: 0.05 }
      const response = await forward.forward(streaming, { q: 'test' }, identity)
      assert.match(await response.text(), /databridge_forward_error/)
      const canceled = await forward.forward({ ...streaming, timeoutSeconds: 5 }, { q: 'test' }, identity)
      await canceled.body!.cancel()
      behavior = 'normal'
      assert.equal((await forward.forward(api, { q: 'test' }, identity)).status, 200)
    })
    await t.test('cancel during a pending read and a stalled consumer do not leak capacity', async () => {
      behavior = 'stream'
      const streaming = { ...api, xingchen: { ...api.xingchen!, responseMode: 'streaming' as const }, timeoutSeconds: 0.1 }
      const response = await forward.forward(streaming, { q: 'test' }, identity)
      const reader = response.body!.getReader()
      await reader.read()
      const pending = reader.read()
      await reader.cancel()
      assert.equal((await pending).done, true)
      const stalled = await forward.forward(streaming, { q: 'test' }, identity)
      await delay(150)
      behavior = 'normal'
      assert.equal((await forward.forward(api, { q: 'test' }, identity)).status, 200)
      assert.match(await stalled.text(), /databridge_forward_error/)
    })
    await assert.rejects(forward.forward(api, { q: 'test' }, {}), status(403))
  } finally { await f.close(); await upstream.close() }
})
