import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sm2 } from 'sm-crypto-v2'
import { Apis } from '../server/apis.ts'
import { createApp } from '../server/app.ts'
import { Auth } from '../server/auth.ts'
import { decrypt, encrypt, loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { HttpError } from '../server/errors.ts'
import { parse, stringify, type JsonObject } from '../server/json.ts'
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'
import type { ExternalAuthConfig } from '../server/external-auth.ts'

const keys = sm2.generateKeyPairHex()
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected
const asJson = (value: unknown) => value as JsonObject
const authSettings = (url = 'http://127.0.0.1:1/identity'): JsonObject => ({
  url, method: 'GET', inputHeader: 'Authorization', inputPrefix: 'Bearer ', tokenLocation: 'header', tokenName: 'Authorization', tokenPrefix: 'Bearer ',
  successPath: 'active', successValue: true, headers: { 'X-Service-Key': 'synthetic-signing-key' },
  bindings: [{ name: '_auth_staff', path: 'staff', type: 'string' }, { name: '_auth_tenant', path: 'tenant', type: 'string' }],
})
const appSettings = (): JsonObject => ({ appId: 'synthetic-app', apiKey: 'synthetic-app-key', publicKey: keys.publicKey,
  staffCodeBinding: '_auth_staff', inputMappings: [{ parameter: 'q', variable: 'q' }], queryParam: 'q', conversationParam: '', responseMode: 'blocking' })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-connections-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'synthetic-admin-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config), apis = new Apis(db, sources, config)
  const app = createApp({ config, db, auth, sources, apis, logs: new Logs(db) })
  return { dir, config, db, auth, sources, apis, app, async close() {
    apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true })
  } }
}
function profiles(f: ReturnType<typeof fixture>, url = 'http://127.0.0.1:1') {
  const auth = f.apis.connections.save(undefined, { kind: 'EXTERNAL_AUTH', name: 'Shared identity', config: authSettings(url + '/identity') })
  const platform = f.apis.connections.save(undefined, { kind: 'XINGCHEN', name: 'Shared platform', config: { baseUrl: url + '/v1/' } })
  return { auth, platform }
}
function apiDefinition(authId: number, platformId: number, suffix = 'one'): JsonObject {
  return { name: 'Agent ' + suffix, code: 'agent_' + suffix, path: '/open/' + suffix, method: 'POST', auth: 'EXTERNAL', mode: 'XINGCHEN',
    authConnectionId: authId, xingchenConnectionId: platformId, xingchen: appSettings(), params: [{ name: 'q', type: 'string', required: true }], enabled: true }
}

test('shared profiles replace duplicated API configuration, encrypt addresses and guard references', async t => {
  const f = fixture()
  try {
    const { auth, platform } = profiles(f)
    const first = f.apis.save(undefined, apiDefinition(auth.id, platform.id))
    const second = f.apis.save(undefined, apiDefinition(auth.id, platform.id, 'two'))
    await t.test('two APIs reference one profile, with per-app credentials and no duplicated address', () => {
      assert.equal(f.apis.connections.list().length, 2)
      assert.equal(f.apis.connections.get(auth.id).usedBy.length, 2)
      const row = f.db.prepare('SELECT external_auth, xingchen, auth_connection_id, xingchen_connection_id FROM api WHERE id = ?').get(first.id) as any
      assert.equal(row.external_auth, null)
      assert.equal(row.auth_connection_id, auth.id)
      assert.equal(row.xingchen_connection_id, platform.id)
      const application = parse(decrypt(f.config.secretKey, row.xingchen)) as JsonObject
      assert.equal(application.baseUrl, undefined)
      assert.equal(application.apiKey, 'synthetic-app-key')
      const encrypted = f.db.prepare('SELECT config FROM connection').all().map(row => row.config).join(' ')
      assert.doesNotMatch(encrypted, /127\.0\.0\.1|synthetic-signing-key|identity/)
      const summary = stringify(f.apis.connections.list())
      assert.doesNotMatch(summary, /127\.0\.0\.1|synthetic-signing-key|baseUrl/)
    })
    await t.test('wrong kinds, missing references and caller-supplied shared overrides are handled', () => {
      assert.throws(() => f.apis.validate(apiDefinition(platform.id, auth.id)), status(400))
      assert.throws(() => f.apis.validate(apiDefinition(9999, platform.id)), status(404))
      const draft = f.apis.validate({ ...apiDefinition(auth.id, platform.id), externalAuth: authSettings('http://forged.example.invalid'),
        xingchen: { ...appSettings(), baseUrl: 'http://forged.example.invalid' } })
      assert.equal(draft.externalAuth!.url, 'http://127.0.0.1:1/identity')
      assert.equal(draft.xingchen!.baseUrl, 'http://127.0.0.1:1/v1')
    })
    await t.test('changes resolve live without re-saving APIs or losing application credentials', () => {
      f.apis.connections.save(platform.id, { kind: 'XINGCHEN', name: platform.name, version: platform.version, config: { baseUrl: 'https://new-platform.example.invalid/v1' } })
      assert.equal(f.apis.get(first.id).xingchen!.baseUrl, 'https://new-platform.example.invalid/v1')
      assert.equal(f.apis.findOpen('/open/two', 'POST')!.xingchen!.baseUrl, 'https://new-platform.example.invalid/v1')
      assert.equal(f.apis.get(first.id).version, first.version)
      assert.equal(f.apis.get(second.id).xingchen!.apiKey, 'synthetic-app-key')
      assert.throws(() => f.apis.connections.save(platform.id, { ...asJson(platform), config: { baseUrl: 'https://stale.example.invalid' } }), status(409))
      assert.throws(() => f.apis.connections.save(platform.id, { kind: 'EXTERNAL_AUTH', name: platform.name, version: 2, config: authSettings() }), status(400))
    })
    await t.test('in-use identity fields cannot disappear or change type; unused fields can be removed', () => {
      const changed = { ...authSettings(), bindings: [{ name: '_auth_staff', path: 'staff', type: 'integer' }] }
      assert.throws(() => f.apis.connections.save(auth.id, { ...asJson(auth), config: changed }), status(409))
      const next = f.apis.connections.save(auth.id, { ...asJson(auth), config: { ...authSettings(), bindings: [{ name: '_auth_staff', path: 'staff', type: 'string' }] } })
      assert.equal((next.config as ExternalAuthConfig).bindings.length, 1)
      assert.throws(() => f.apis.connections.remove(auth.id), status(409))
      f.apis.setEnabled(first.id, false); f.apis.setEnabled(second.id, false)
      assert.throws(() => f.apis.connections.remove(platform.id), status(409), 'disabled APIs still reference profiles')
      f.apis.remove(first.id); f.apis.remove(second.id)
      f.apis.connections.remove(auth.id); f.apis.connections.remove(platform.id)
      assert.equal(f.apis.connections.list().length, 0)
    })
  } finally { await f.close() }
})

test('copying a Xingchen API reuses shared connections and keeps application credentials encrypted', async () => {
  const f = fixture()
  try {
    const { auth, platform } = profiles(f)
    const original = f.apis.save(undefined, apiDefinition(auth.id, platform.id))
    const copy = f.apis.copy(original.id)
    assert.equal(copy.authConnectionId, auth.id)
    assert.equal(copy.xingchenConnectionId, platform.id)
    assert.deepEqual(copy.externalAuth, original.externalAuth)
    assert.deepEqual(copy.xingchen, original.xingchen)
    assert.deepEqual(copy.params, original.params)
    assert.equal(copy.enabled, false)
    assert.equal(f.apis.connections.list().length, 2)
    const row = f.db.prepare('SELECT external_auth, xingchen FROM api WHERE id = ?').get(copy.id)!
    assert.equal(row.external_auth, null)
    assert.doesNotMatch(String(row.xingchen), /synthetic-app-key/)
    assert.equal((parse(decrypt(f.config.secretKey, String(row.xingchen))) as JsonObject).apiKey, 'synthetic-app-key')
    assert.deepEqual(f.apis.get(original.id), original)
  } finally { await f.close() }
})

test('identity profiles expose reusable fields, but each API extracts only the ones it consumes', async () => {
  const f = fixture()
  try {
    const { auth, platform } = profiles(f)
    const source = f.sources.save(undefined, { name: 'unused', host: '127.0.0.1', port: 1, database: 'unused', username: 'unused', password: 'unused' })
    const sql = f.apis.save(undefined, { name: 'SQL', code: 'sql', path: '/open/sql', mode: 'REALTIME', datasourceId: source.id,
      auth: 'EXTERNAL', authConnectionId: auth.id, sql: 'SELECT :_auth_staff AS staff' })
    assert.deepEqual(f.apis.identityConfig(sql)!.bindings.map(binding => binding.name), ['_auth_staff'])
    const agent = f.apis.save(undefined, apiDefinition(auth.id, platform.id))
    assert.deepEqual(f.apis.identityConfig(agent)!.bindings.map(binding => binding.name), ['_auth_staff'])
    const manual = f.apis.save(undefined, { name: 'Local', code: 'local', path: '/open/local', mode: 'MANUAL',
      auth: 'EXTERNAL', authConnectionId: auth.id, fields: [{ name: 'id', type: 'string' }] })
    assert.deepEqual(f.apis.identityConfig(manual)!.bindings, [])
    const snapshot = { name: 'Snapshot', code: 'snapshot', path: '/open/snapshot', mode: 'SNAPSHOT', datasourceId: source.id,
      auth: 'EXTERNAL', authConnectionId: auth.id, sql: "SELECT 'one' AS id", keyFields: ['id'], cron: '0 0 * * * *' }
    assert.deepEqual(f.apis.identityConfig(f.apis.save(undefined, snapshot))!.bindings, [])
    assert.throws(() => f.apis.validate({ ...snapshot, sql: 'SELECT :_auth_staff AS id' }), /不能包含参数/,
      'background synchronization has no caller identity even when the published API uses shared authentication')
    assert.throws(() => f.apis.save(undefined, { name: 'Bad SQL', code: 'bad', path: '/open/bad', mode: 'REALTIME', datasourceId: source.id,
      auth: 'EXTERNAL', authConnectionId: auth.id, sql: 'SELECT :_auth_missing AS staff' }), /未定义/)
    assert.throws(() => f.apis.connections.save(auth.id, { ...asJson(auth), config: { ...authSettings(), bindings: [] } }), status(409))
    const initial = f.apis.connections.list().length
    assert.throws(() => f.apis.save(undefined, { ...apiDefinition(auth.id, platform.id), authConnectionId: null, externalAuth: authSettings('http://new.example.invalid/verify') }), status(409))
    assert.equal(f.apis.connections.list().length, initial, 'conflicting API save must roll back auto-created profile')
  } finally { await f.close() }
})

test('HTTP runtime uses shared identity and platform changes for all APIs, with authenticated management', async () => {
  const calls: string[] = []
  const provider = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url!.includes('/identity')) {
      calls.push(req.url!)
      assert.equal(req.headers.authorization, 'Bearer synthetic-user-token')
      // tenant is intentionally missing: these APIs only require staff.
      res.end('{"active":true,"staff":"00042"}')
      return
    }
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      calls.push(req.url!)
      assert.equal(JSON.parse(raw).input_data.q, 'test')
      const staff = req.headers['znt-staff-code'] as string
      assert.equal(JSON.parse(sm2.doDecrypt(Buffer.from(staff.slice(3), 'base64url').toString('hex'), keys.privateKey, 1, { output: 'string' })).staff_code, '00042')
      res.end('{"event":"message","answer":"[]"}')
    })
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const f = fixture()
  try {
    const { auth, platform } = profiles(f, url)
    for (const suffix of ['one', 'two']) f.apis.save(undefined, apiDefinition(auth.id, platform.id, suffix))
    for (const path of ['/admin/connections', `/admin/connections/${auth.id}`]) assert.equal((await f.app.request(path)).status, 401)
    const invoke = (suffix: string) => f.app.request('/open/' + suffix, { method: 'POST', headers: { Authorization: 'Bearer synthetic-user-token', 'Content-Type': 'application/json' }, body: '{"q":"test"}' })
    assert.equal((await invoke('one')).status, 200)
    f.apis.connections.save(auth.id, { ...asJson(auth), config: { ...authSettings(url + '/identity-v2'), bindings: [{ name: '_auth_staff', path: 'staff', type: 'string' }] } })
    f.apis.connections.save(platform.id, { ...asJson(platform), config: { baseUrl: url + '/new/v1' } })
    for (const suffix of ['one', 'two']) assert.equal((await invoke(suffix)).status, 200)
    assert.deepEqual(calls, ['/identity', '/v1/chat-messages/synthetic-app', '/identity-v2', '/new/v1/chat-messages/synthetic-app', '/identity-v2', '/new/v1/chat-messages/synthetic-app'])
    await f.auth.bootstrap()
    const token = await f.auth.login('admin', 'synthetic-admin-password', 'test')
    const headers = { Cookie: `databridge_session=${token}`, 'Content-Type': 'application/json', 'X-Requested-With': 'DataBridge' }
    const summaries = await f.app.request('/admin/apis', { headers })
    assert.doesNotMatch(await summaries.text(), /synthetic-app-key|127\.0\.0\.1|synthetic-signing-key/)
    const testAuth = await f.app.request('/admin/external-auth/test', { method: 'POST', headers: { ...headers, 'X-DataBridge-Test-Credential': 'Bearer synthetic-user-token' }, body: JSON.stringify({ connectionId: auth.id }) })
    assert.equal(testAuth.status, 200)
    const testDraft = await f.app.request('/admin/apis/test', { method: 'POST', headers: { ...headers, 'X-DataBridge-Test-Credential': 'Bearer synthetic-user-token' }, body: JSON.stringify({ api: apiDefinition(auth.id, platform.id), params: { q: 'test' } }) })
    assert.equal(testDraft.status, 200)
    const refused = await f.app.request(`/admin/connections/${auth.id}`, { method: 'DELETE', headers })
    assert.equal(refused.status, 409)
    const csrf = await f.app.request('/admin/connections', { method: 'POST', headers: { Cookie: headers.Cookie }, body: '{}' })
    assert.equal(csrf.status, 403)
    const created = await f.app.request('/admin/connections', { method: 'POST', headers, body: JSON.stringify({ kind: 'XINGCHEN', name: 'Temporary', config: { baseUrl: url + '/v1' } }) })
    assert.equal(created.status, 201)
    const extra = await created.json()
    assert.equal((await f.app.request(`/admin/connections/${extra.id}`, { method: 'PUT', headers, body: JSON.stringify({ ...extra, name: 'Renamed' }) })).status, 200)
    assert.equal((await f.app.request(`/admin/connections/${extra.id}`, { method: 'PUT', headers, body: JSON.stringify(extra) })).status, 409)
    assert.equal((await f.app.request(`/admin/connections/${extra.id}`, { method: 'DELETE', headers })).status, 204)
  } finally { await f.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())) }
})

test('legacy verifier migration merges compatible field subsets and keeps conflicting mappings separate', async () => {
  const f = fixture()
  try {
    const bindings = [
      [{ name: '_auth_staff', path: 'staff', type: 'string' }],
      [{ name: '_auth_tenant', path: 'tenant', type: 'string' }],
      [{ name: '_auth_staff', path: 'employee.code', type: 'string' }],
    ]
    const ids = bindings.map((fields, index) => {
      const api = f.apis.save(undefined, { name: `Legacy ${index}`, code: `legacy_${index}`, path: `/open/legacy-${index}`,
        mode: 'MANUAL', auth: 'PUBLIC', fields: [{ name: 'id', type: 'string' }] })
      f.db.prepare("UPDATE api SET auth = 'EXTERNAL', external_auth = ? WHERE id = ?")
        .run(encrypt(f.config.secretKey, stringify({ ...authSettings(), bindings: fields })), api.id)
      return api.id
    })
    f.apis.connections.migrateLegacy()
    const [staff, tenant, conflicting] = ids.map(id => f.apis.get(id))
    assert.equal(staff.authConnectionId, tenant.authConnectionId)
    assert.notEqual(staff.authConnectionId, conflicting.authConnectionId)
    assert.deepEqual(staff.externalAuth!.bindings.map(field => field.name), ['_auth_staff', '_auth_tenant'])
    assert.equal(conflicting.externalAuth!.bindings[0].path, 'employee.code')
    assert.equal(f.apis.connections.list().length, 2)
  } finally { await f.close() }
})

test('v1.1 databases migrate atomically, deduplicate shared settings and preserve application identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-legacy-connections-'))
  const config = loadConfig({ DATA_DIR: dir })
  let db = openDb(config.dbFile)
  let sources = new Sources(db, config)
  let apis = new Apis(db, sources, config)
  try {
    const originalIds: number[] = []
    for (const suffix of ['one', 'two']) {
      const original = { ...apiDefinition(1, 1, suffix), authConnectionId: null, xingchenConnectionId: null,
        externalAuth: { ...authSettings(), bindings: [{ name: '_auth_staff', path: 'staff', type: 'string' }] },
        xingchen: { ...appSettings(), appId: 'app-' + suffix, baseUrl: 'https://old-platform.example.invalid/v1' } }
      const api = apis.save(undefined, original)
      originalIds.push(api.id)
      db.prepare('UPDATE api SET external_auth = ?, xingchen = ?, auth_connection_id = NULL, xingchen_connection_id = NULL WHERE id = ?')
        .run(encrypt(config.secretKey, stringify(api.externalAuth)), encrypt(config.secretKey, stringify(api.xingchen)), api.id)
    }
    // Recreate the authoritative v1.1 schema boundary before opening with the new migration.
    db.exec(`DROP INDEX api_auth_connection; DROP INDEX api_xingchen_connection;
      ALTER TABLE api DROP COLUMN auth_connection_id; ALTER TABLE api DROP COLUMN xingchen_connection_id;
      DROP TABLE connection; PRAGMA user_version = 6;`)
    await sources.closeAll(); db.close()
    db = openDb(config.dbFile); sources = new Sources(db, config); apis = new Apis(db, sources, config)
    assert.equal(apis.connections.list().length, 2)
    const first = apis.get(originalIds[0]), second = apis.get(originalIds[1])
    assert.equal(first.authConnectionId, second.authConnectionId)
    assert.equal(first.xingchenConnectionId, second.xingchenConnectionId)
    assert.equal(first.xingchen!.appId, 'app-one')
    assert.equal(second.xingchen!.appId, 'app-two')
    assert.equal(first.xingchen!.baseUrl, 'https://old-platform.example.invalid/v1')
    assert.equal(db.prepare('SELECT count(*) AS n FROM api WHERE external_auth IS NOT NULL').get()!.n, 0)
    assert.equal(first.enabled, true)
    const version = first.version
    apis.connections.migrateLegacy()
    assert.equal(apis.get(first.id).version, version)
    assert.equal(apis.connections.list().length, 2)
    // The next migration failure rolls back every row, not just the failing one.
    db.prepare('UPDATE api SET external_auth = ?, auth_connection_id = NULL WHERE id = ?').run(encrypt(config.secretKey, stringify(authSettings('https://new-identity.example.invalid'))), first.id)
    db.prepare('UPDATE api SET external_auth = ?, auth_connection_id = NULL WHERE id = ?').run(encrypt(config.secretKey, '{}'), second.id)
    const count = apis.connections.list().length
    assert.throws(() => apis.connections.migrateLegacy(), status(400))
    assert.equal(apis.connections.list().length, count)
    assert.equal(db.prepare('SELECT count(*) AS n FROM api WHERE external_auth IS NOT NULL').get()!.n, 2)
  } finally { apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true }) }
})
