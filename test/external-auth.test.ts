import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Apis } from '../server/apis.ts'
import { createApp } from '../server/app.ts'
import { Auth } from '../server/auth.ts'
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { HttpError } from '../server/errors.ts'
import { parse, stringify, type JsonObject } from '../server/json.ts'
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'
import { ExternalAuth, validateExternalAuth } from '../server/external-auth.ts'

async function provider(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}/verify`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

function fixture(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-identity-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'test-admin-password', WEB_DIR: join(dir, 'none'), ...env })
  const db = openDb(config.dbFile)
  const auth = new Auth(db, config)
  const sources = new Sources(db, config)
  const apis = new Apis(db, sources, config)
  const app = createApp({ config, db, auth, sources, apis, logs: new Logs(db) })
  return {
    config, db, auth, sources, apis, app,
    async close() {
      apis.stopSchedules()
      await sources.closeAll()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const authConfig = (url: string, overrides: JsonObject = {}): JsonObject => ({
  url, inputHeader: 'X-Access-Token', tokenName: 'X-Access-Token', successPath: 'active', successValue: true,
  bindings: [{ name: '_auth_subject', path: 'subject', type: 'string' }], ...overrides,
})

const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected

test('external verification supports configurable requests and typed response mappings', async t => {
  const received: { method?: string; headers: IncomingMessage['headers']; body: string }[] = []
  let result = '{"code":0,"data":{"user":{"id":"00123"},"tenant":{"id":9007199254740993},"enabled":false,"groups":[{"id":"g1"}]}}'
  let responseStatus = 200
  const upstream = await provider((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(responseStatus, { 'Content-Type': 'application/json' })
      res.end(result)
    })
  })
  const verifier = new ExternalAuth(20)
  const base = authConfig(upstream.url, {
    inputHeader: 'Authorization', inputPrefix: 'Bearer ', tokenName: 'X-Identity', tokenPrefix: 'Key ',
    headers: { 'X-Client-Id': 'client-a', 'X-Identity': 'must-be-overwritten' },
    successPath: 'code', successValue: 0,
    bindings: [
      { name: '_auth_subject', path: 'data.user.id', type: 'string' },
      { name: '_auth_tenant', path: 'data.tenant.id', type: 'integer' },
      { name: '_auth_enabled', path: 'data.enabled', type: 'boolean' },
      { name: '_auth_group', path: 'data.groups.0.id', type: 'string' },
    ],
  })
  try {
    await t.test('GET uses configured headers and prefixes; mapped identifiers retain precision', async () => {
      const settings = validateExternalAuth({ ...base, method: 'GET' })
      const identity = await verifier.verify(settings, 'Bearer a+b/c=')
      assert.equal(identity._auth_subject, '00123')
      assert.equal(stringify(identity._auth_tenant), '9007199254740993')
      assert.equal(identity._auth_enabled, false)
      assert.equal(identity._auth_group, 'g1')
      assert.equal(received.at(-1)!.method, 'GET')
      assert.equal(received.at(-1)!.headers['x-identity'], 'Key a+b/c=')
      assert.equal(received.at(-1)!.headers['x-client-id'], 'client-a')
      assert.equal(received.at(-1)!.headers.authorization, undefined)
      assert.equal(received.at(-1)!.body, '')
      await assert.rejects(verifier.verify(settings, 'a+b/c='), status(401))
    })
    await t.test('POST JSON forwards configured fields and binds the actual credential last', async () => {
      const settings = validateExternalAuth({ ...base, method: 'POST', tokenLocation: 'json', tokenName: 'token', tokenPrefix: '',
        body: { token: 'must-be-overwritten', audience: 'orders', context: { locale: 'en' } } })
      await verifier.verify(settings, 'Bearer a+b/c=')
      assert.deepEqual(JSON.parse(received.at(-1)!.body), { token: 'a+b/c=', audience: 'orders', context: { locale: 'en' } })
      assert.match(String(received.at(-1)!.headers['content-type']), /application\/json/)
    })
    await t.test('POST form correctly encodes credentials and preserves static numeric precision', async () => {
      const settings = validateExternalAuth({ ...base, method: 'POST', tokenLocation: 'form', tokenName: 'access_token', tokenPrefix: '',
        body: parse('{"audience":"orders","counter":9007199254740993,"enabled":false}') })
      await verifier.verify(settings, 'Bearer a+b/c=')
      const fields = new URLSearchParams(received.at(-1)!.body)
      assert.equal(fields.get('access_token'), 'a+b/c=')
      assert.equal(fields.get('counter'), '9007199254740993')
      assert.equal(fields.get('enabled'), 'false')
      assert.match(String(received.at(-1)!.headers['content-type']), /application\/x-www-form-urlencoded/)
    })
    await t.test('success predicates use explicit values and missing fields fail closed', async () => {
      const settings = validateExternalAuth(base)
      result = '{"code":"0"}'
      await assert.rejects(verifier.verify(settings, 'Bearer token'), status(401))
      result = '{"other":0}'
      await assert.rejects(verifier.verify(settings, 'Bearer token'), status(502))
      result = '{"code":0,"data":{"user":{"id":"00123"}}}'
      await assert.rejects(verifier.verify(settings, 'Bearer token'), status(502))
      result = '{"status":"ok","principal":{"id":"A01"}}'
      const alternative = validateExternalAuth({ ...base, successPath: 'status', successValue: 'ok',
        bindings: [{ name: '_auth_account', path: 'principal.id', type: 'string' }] })
      assert.deepEqual(await verifier.verify(alternative, 'Bearer token'), { _auth_account: 'A01' })
      const inherited = validateExternalAuth({ ...base, successPath: 'toString', bindings: [] })
      await assert.rejects(verifier.verify(inherited, 'Bearer token'), status(502))
    })
    await t.test('HTTP-only verification supports empty responses and explicit success status', async () => {
      responseStatus = 204
      result = ''
      const settings = validateExternalAuth({ ...base, successStatus: 204, successPath: '', bindings: [] })
      assert.deepEqual(await verifier.verify(settings, 'Bearer token'), {})
      responseStatus = 200
      await assert.rejects(verifier.verify(settings, 'Bearer token'), status(502))
    })
  } finally {
    await upstream.close()
  }
})

test('external verification rejects invalid request and mapping configurations before saving', () => {
  const base = authConfig('https://identity.example.com/verify')
  const invalid: JsonObject[] = [
    { url: 'file:///private' }, { url: 'https://user:pass@example.com/verify' },
    { method: 'GET', tokenLocation: 'json' }, { method: 'GET', body: { audience: 'data' } },
    { inputHeader: 'Bad\r\nHeader' }, { tokenName: 'Host' }, { headers: { 'Content-Length': '1000' } },
    { headers: { 'X-Key': 'one', 'x-key': 'two' } }, { inputPrefix: '\n' },
    { tokenLocation: 'form', body: { nested: {} } }, { successValue: {} }, { successPath: 'data..status' },
    { successStatus: 302 }, { timeoutSeconds: 31 },
    { bindings: [{ name: 'subject', path: 'sub', type: 'string' }] },
    { bindings: [{ name: '_auth_subject', path: 'sub', type: 'invalid' }] },
    { bindings: [{ name: '_auth_subject', path: 'sub', type: 'string' }, { name: '_auth_subject', path: 'id', type: 'string' }] },
  ]
  for (const changes of invalid) assert.throws(() => validateExternalAuth({ ...base, ...changes }), status(400))
})

test('external verification trusts only a valid active response and never follows redirects', async t => {
  let calls = 0
  let mode = 'valid'
  let upstreamBody: unknown = { active: true, subject: '00123' }
  const received: { method?: string; token?: string; cookie?: string }[] = []
  const upstream = await provider((req, res) => {
    calls++
    received.push({ method: req.method, token: req.headers['x-access-token'] as string, cookie: req.headers.cookie })
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); res.end(); return }
    if (mode === 'unauthorized') { res.writeHead(401); res.end('secret upstream message'); return }
    if (mode === 'forbidden') { res.writeHead(403); res.end(); return }
    if (mode === 'error') { res.writeHead(500); res.end('secret upstream message'); return }
    if (mode === 'slow') return
    if (mode === 'invalid-json') { res.end('secret upstream message'); return }
    if (mode === 'oversized') { res.end('x'.repeat(70_000)); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(upstreamBody))
  })
  const f = fixture()
  const verifier = new ExternalAuth(1)
  const settings = validateExternalAuth(authConfig(upstream.url, { timeoutSeconds: 1 }))
  const verify = (token: string | undefined) => verifier.verify(settings, token)
  try {
    await t.test('verified subject identifiers keep leading zeros; only the token is forwarded', async () => {
      assert.deepEqual(await verify('test-token'), { _auth_subject: '00123' })
      assert.deepEqual(received[0], { method: 'POST', token: 'test-token', cookie: undefined })
    })
    await t.test('missing and duplicate credentials fail before contacting the provider', async () => {
      const before = calls
      for (const value of [undefined, '', 'one,two', 'has space', 'x'.repeat(4097)]) {
        await assert.rejects(verify(value), status(401))
      }
      assert.equal(calls, before)
    })
    await t.test('malformed or incomplete success cannot become an identity', async () => {
      for (const value of [null, [], {}, { active: true },
        { active: true, subject: [] }, { active: true, subject: '' },
        { active: true, subject: {} }, { active: true, subject: '   ' }]) {
        upstreamBody = value
        await assert.rejects(verify('test-token'), status(502))
      }
      upstreamBody = { active: false, subject: '00123' }
      await assert.rejects(verify('test-token'), status(401))
      upstreamBody = { active: 'true', subject: '00123' }
      await assert.rejects(verify('test-token'), status(401))
    })
    await t.test('rejection, server failure and malformed bodies stay closed without exposing details', async () => {
      for (const [next, expected] of [['unauthorized', 401], ['forbidden', 401], ['error', 502],
        ['invalid-json', 502], ['oversized', 502]] as const) {
        mode = next
        await assert.rejects(verify('test-token'), error => {
          assert.ok(status(expected)(error))
          assert.doesNotMatch(String(error), /secret upstream|test-token/)
          return true
        })
      }
    })
    await t.test('redirects cannot forward credentials to another endpoint', async () => {
      mode = 'redirect'
      const before = calls
      await assert.rejects(verify('test-token'), status(502))
      assert.equal(calls, before + 1)
    })
    await t.test('timeouts and concurrent verification limits do not fall back to anonymous access', async () => {
      mode = 'slow'
      const pending = assert.rejects(verify('test-token'), status(504))
      await assert.rejects(verify('second-token'), status(503))
      await pending
      mode = 'valid'
      upstreamBody = { active: true, subject: '00123' }
      assert.deepEqual(await verify('test-token'), { _auth_subject: '00123' })
    })
    await t.test('every call is revalidated so revocation takes effect on the next request', async () => {
      upstreamBody = { active: false }
      await assert.rejects(verify('test-token'), status(401))
    })
  } finally {
    await f.close()
    await upstream.close()
  }
})

test('identity-scoped APIs validate configuration and reject missing identity without querying data', async () => {
  const f = fixture()
  try {
    const source = f.sources.save(undefined, { name: 'unused', host: '127.0.0.1', port: 1, database: 'unused', username: 'unused', password: 'unused' })
    const base: JsonObject = {
      name: 'scoped', code: 'scoped', path: '/open/scoped', mode: 'REALTIME', auth: 'EXTERNAL',
      datasourceId: source.id, sql: 'SELECT :_auth_subject AS subject', enabled: true,
      externalAuth: authConfig('http://127.0.0.1:1/verify', { headers: { 'X-Service-Key': 'private-service-key' } }),
    }
    assert.throws(() => f.apis.save(undefined, { ...base, sql: "SELECT ':_auth_subject' AS literal -- :_auth_subject" }), /没有在 SQL 中使用/)
    assert.throws(() => f.apis.save(undefined, { ...base, params: [{ name: '_auth_subject', type: 'string' }] }), /不能声明/)
    assert.throws(() => f.apis.save(undefined, { ...base, mode: 'MANUAL', fields: [{ name: 'id', type: 'string' }] }), /只支持实时/)
    assert.throws(() => f.apis.save(undefined, { ...base, mode: 'SNAPSHOT', cron: '0 0 0 * * *', keyFields: ['id'] }), /只支持实时/)
    const api = f.apis.save(undefined, base)
    assert.equal(f.apis.get(api.id).auth, 'EXTERNAL')
    assert.equal(f.apis.get(api.id).externalAuth!.headers['x-service-key'], 'private-service-key')
    const stored = f.db.prepare('SELECT external_auth FROM api WHERE id = ?').get(api.id) as { external_auth: string }
    assert.doesNotMatch(stored.external_auth, /private-service-key|verify|_auth_subject/)
    const edited = f.apis.save(api.id, { ...base, version: api.version })
    assert.equal(edited.externalAuth!.bindings[0].name, '_auth_subject')
    assert.throws(() => f.apis.save(api.id, { ...base, version: api.version }), status(409))
    await assert.rejects(f.apis.query(api, {}), status(403))
    await assert.rejects(f.apis.queryPage(api, {}, 1, 10), status(403))
    assert.equal((await f.app.request('/open/scoped')).status, 401)
    assert.equal((await f.app.request('/open/scoped?X-Access-Token=fake&subject=someone')).status, 401)
    assert.equal((await f.app.request('/open/scoped', { headers: { 'X-Access-Token': 'test-token' } })).status, 502)
    const key = f.auth.createKey('legacy-client')
    assert.equal((await f.app.request('/open/scoped', { headers: { 'X-API-Key': key.key } })).status, 401)
    const old = f.apis.save(undefined, {
      name: 'legacy', code: 'legacy', path: '/open/legacy', mode: 'MANUAL', auth: 'PUBLIC', enabled: true,
      fields: [{ name: 'name', type: 'string' }],
    })
    f.apis.createRow(old.id, { name: 'public row' })
    assert.equal((await f.app.request('/open/legacy')).status, 200)
    f.apis.save(old.id, { ...old, auth: 'API_KEY' } as unknown as JsonObject)
    assert.equal((await f.app.request('/open/legacy')).status, 401)
    assert.equal((await f.app.request('/open/legacy', { headers: { 'X-API-Key': key.key } })).status, 200)
    f.db.prepare('UPDATE api SET auth = ? WHERE id = ?').run('UNSUPPORTED', old.id)
    assert.equal((await f.app.request('/open/legacy')).status, 503)
    f.db.prepare('UPDATE api SET external_auth = NULL WHERE id = ?').run(api.id)
    assert.equal((await f.app.request('/open/scoped', { headers: { 'X-Access-Token': 'test-token' } })).status, 503)
  } finally {
    await f.close()
  }
})

test('external identity reaches SQL, paging and admin previews without accepting a client-supplied subject',
  { skip: !process.env.TEST_PG_URL && 'set TEST_PG_URL to run integration tests' }, async t => {
    let calls = 0
    let revoked = false
    const injection = "00123' OR '1'='1"
    const upstream = await provider((req, res) => {
      calls++
      const token = req.headers['x-access-token']
      const subject = token === 'alice-token' ? '00123' : token === 'bob-token' ? '00456' : token === 'injection-token' ? injection : undefined
      res.setHeader('Content-Type', 'application/json')
      if (token === 'outage-token') { res.writeHead(500); res.end('private provider details'); return }
      if (revoked || !subject) { res.writeHead(401); res.end(); return }
      res.end(JSON.stringify({ code: 0, data: { user: { id: subject }, tenant: { id: token === 'bob-token' ? 't2' : 't1' } } }))
    })
    const f = fixture()
    let cookie = ''
    async function call(path: string, token?: string, value?: unknown, headers: Record<string, string> = {}) {
      const response = await f.app.request(path, {
        method: value === undefined ? 'GET' : 'POST',
        headers: { 'X-Requested-With': 'DataBridge', cookie,
          ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token === undefined ? {} : { [path === '/admin/apis/test' ? 'X-DataBridge-Test-Credential' : 'X-Access-Token']: token }), ...headers },
        body: value === undefined ? undefined : JSON.stringify(value),
      })
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
      return { status: response.status, headers: response.headers, body: await response.json() }
    }
    try {
      const url = new URL(process.env.TEST_PG_URL!)
      const source = f.sources.save(undefined, {
        name: 'identity-test', host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
        username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) || 'unused',
      })
      // The business field differs from the reserved parameter and is not returned to the caller.
      // A separate permission relation also allows one subject to see several owners' rows.
      const sql = `WITH orders(id, owner_id, item) AS (
          VALUES (1, 'owner-a', 'A1'), (2, 'owner-a', 'A2'), (3, 'owner-b', 'B1'), (4, 'owner-c', 'C1')
        ), permissions(subject_id, owner_id, tenant_id) AS (
          VALUES ('00123', 'owner-a', 't1'), ('00456', 'owner-b', 't2'), ('00456', 'owner-c', 't2'), ('00123', 'owner-b', 't2')
        )
        SELECT o.id, o.item FROM orders o
        JOIN permissions p ON p.owner_id = o.owner_id
        WHERE p.subject_id = :_auth_subject AND p.tenant_id = :_auth_tenant AND (:item IS NULL OR o.item = :item)
        ORDER BY o.id`
      const definition: JsonObject = {
        name: 'orders', code: 'orders', path: '/open/orders', mode: 'REALTIME', auth: 'EXTERNAL',
        externalAuth: authConfig(upstream.url, { successPath: 'code', successValue: 0, bindings: [
          { name: '_auth_subject', path: 'data.user.id', type: 'string' },
          { name: '_auth_tenant', path: 'data.tenant.id', type: 'string' },
        ] }), datasourceId: source.id, sql, params: [{ name: 'item', type: 'string' }], enabled: true,
      }
      f.apis.save(undefined, definition)
      f.apis.save(undefined, { ...definition, name: 'orders-post', code: 'orders_post', path: '/open/orders-post', method: 'POST' })
      await t.test('different tokens bind different identities, including leading zeros and permission joins', async () => {
        const alice = await call('/open/orders', 'alice-token')
        const bob = await call('/open/orders', 'bob-token')
        assert.equal(alice.status, 200)
        assert.equal(bob.status, 200)
        assert.deepEqual(alice.body.data, [{ id: 1, item: 'A1' }, { id: 2, item: 'A2' }])
        assert.deepEqual(bob.body.data, [{ id: 3, item: 'B1' }, { id: 4, item: 'C1' }])
        assert.match(alice.headers.get('cache-control')!, /no-store/)
        const filtered = await call('/open/orders?item=B1', 'alice-token')
        assert.deepEqual(filtered.body.data, [])
        assert.deepEqual((await call('/open/orders', 'injection-token')).body.data, [])
      })
      await t.test('GET and POST reject attempts to overwrite the trusted placeholder', async () => {
        assert.equal((await call('/open/orders?_auth_subject=00456', 'alice-token')).status, 400)
        assert.equal((await call('/open/orders?_auth_subject=00123&_auth_subject=00456', 'alice-token')).status, 400)
        assert.equal((await call('/open/orders-post', 'alice-token', { _auth_subject: '00456' })).status, 400)
        assert.equal((await call('/open/orders-post', 'alice-token', { _auth_subject: null })).status, 400)
        assert.equal((await call('/open/orders?_auth_tenant=t2', 'alice-token')).status, 400)
        const forged = await call('/open/orders', 'alice-token', undefined, { 'X-Subject-Id': '00456' })
        assert.equal(forged.body.data[0].id, 1)
      })
      await t.test('pagination totals use the same subject and verify only once per request', async () => {
        const before = calls
        const page = await call('/open/orders?page=2&pageSize=1', 'alice-token')
        assert.equal(calls, before + 1)
        assert.deepEqual(page.body.data, [{ id: 2, item: 'A2' }])
        assert.equal(page.body.meta.total, 2)
        assert.equal(page.body.meta.total_pages, 2)
        assert.equal(page.body.meta.has_more, false)
        const post = await call('/open/orders-post', 'bob-token', { page: 1, pageSize: 1 })
        assert.deepEqual(post.body.data, [{ id: 3, item: 'B1' }])
        assert.equal(post.body.meta.total, 2)
        assert.deepEqual((await call('/open/orders?page=3&pageSize=1', 'alice-token')).body.data, [])
      })
      await t.test('missing, revoked and unavailable verification never return business data', async () => {
        assert.equal((await call('/open/orders')).status, 401)
        assert.equal((await call('/open/orders', 'invalid-token')).status, 401)
        const outage = await call('/open/orders', 'outage-token')
        assert.equal(outage.status, 502)
        assert.equal(outage.body.data, undefined)
        revoked = true
        assert.equal((await call('/open/orders', 'alice-token')).status, 401)
        revoked = false
      })
      await t.test('admin SQL previews use the same verifier and bad tokens do not expire the admin session', async () => {
        await f.auth.bootstrap()
        assert.equal((await call('/auth/login', undefined, { username: 'admin', password: 'test-admin-password' })).status, 200)
        const preview = await call('/admin/apis/test', 'alice-token', { api: definition, params: { item: 'A1' } })
        assert.equal(preview.status, 200)
        assert.deepEqual(preview.body.rows, [{ id: 1, item: 'A1' }])
        assert.equal((await call('/admin/apis/test', 'invalid-token', { api: definition })).status, 400)
        assert.equal((await call('/auth/session')).body.username, 'admin')
        assert.equal((await call('/admin/apis/test', 'alice-token', { api: definition, params: { _auth_subject: '00456' } })).status, 400)
        const logs = await call('/admin/logs')
        assert.doesNotMatch(JSON.stringify(logs.body), /alice-token|bob-token|private provider details/)
      })
      await t.test('external verification can gate stored APIs without SQL bindings', async () => {
        const api = f.apis.save(undefined, {
          name: 'shared', code: 'shared', path: '/open/shared', mode: 'MANUAL', auth: 'EXTERNAL', enabled: true,
          externalAuth: authConfig(upstream.url, { successPath: 'code', successValue: 0, bindings: [] }),
          fields: [{ name: 'name', type: 'string' }],
        })
        f.apis.createRow(api.id, { name: 'shared data' })
        assert.equal((await call('/open/shared')).status, 401)
        assert.deepEqual((await call('/open/shared', 'alice-token')).body.data, [{ name: 'shared data' }])
      })
    } finally {
      await f.close()
      await upstream.close()
    }
  })
