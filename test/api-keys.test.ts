import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Apis } from '../server/apis.ts'
import { createApp } from '../server/app.ts'
import { Auth } from '../server/auth.ts'
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { HttpError } from '../server/errors.ts'
import type { JsonObject } from '../server/json.ts'
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-key-access-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'synthetic-key-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config), apis = new Apis(db, sources, config)
  const logs = new Logs(db), app = createApp({ config, db, auth, sources, apis, logs })
  const api = (code: string, extra: JsonObject = {}) => apis.save(undefined, {
    name: code, code, path: '/open/' + code, method: 'GET', mode: 'MANUAL', auth: 'API_KEY', enabled: true,
    fields: [{ name: 'id', type: 'string' }], ...extra,
  })
  const call = (path: string, key?: string, method = 'GET') => app.request(path, { method, headers: key ? { 'X-API-Key': key } : {} })
  return { config, db, auth, sources, apis, logs, app, api, call, async close() {
    apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true })
  } }
}
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected
const asJson = (value: unknown) => value as JsonObject

// Older databases have no access table; migration must preserve the key but grant nothing.
const legacyKeys = `DROP TRIGGER api_key_access_delete; DROP TRIGGER api_key_access_auth; DROP TABLE api_key_access;
  CREATE TABLE legacy_api_key (id INTEGER PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT);
  INSERT INTO legacy_api_key SELECT id, name, prefix, hash, created_at, last_used_at FROM api_key;
  DROP TABLE api_key; ALTER TABLE legacy_api_key RENAME TO api_key; PRAGMA user_version = 9;`

test('keys authorize exact APIs and HTTP methods, deny missing grants before querying, and log 403', async () => {
  const f = fixture()
  try {
    const a = f.api('a'), b = f.api('b'), post = f.api('a_post', { path: a.path, method: 'POST' })
    f.apis.createRow(a.id, { id: 'allowed-row' })
    const key = f.auth.createKey({ name: 'caller', apiIds: [a.id] })
    for (const credential of [undefined, 'invalid-synthetic-key']) assert.equal((await f.call(a.path, credential)).status, 401)
    assert.equal((await f.call(b.path, key.key)).status, 403)
    assert.equal(f.auth.listKeys()[0].lastUsedAt, null)
    const log = f.logs.list({}).items[0]
    assert.equal(log.status, 403)
    assert.equal(f.logs.detail(log.id).request!.errorStage, 'access')
    assert.equal((await f.call(post.path, key.key, 'POST')).status, 403)
    const response = await f.call(a.path, key.key)
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data, [{ id: 'allowed-row' }])
    assert.ok(f.auth.listKeys()[0].lastUsedAt)
    const next = f.api('new_api')
    const copy = f.apis.copy(a.id)
    f.apis.setEnabled(copy.id, true)
    assert.equal((await f.call(next.path, key.key)).status, 403)
    assert.equal((await f.call(copy.path, key.key)).status, 403)
    const publicApi = f.api('public_api', { auth: 'PUBLIC' })
    assert.equal((await f.call(publicApi.path)).status, 200)
    f.apis.setEnabled(a.id, false)
    assert.equal((await f.call(a.path, key.key)).status, 404)
  } finally { await f.close() }
})

test('grant replacement, clearing and revocation apply immediately without replacing the key', async () => {
  const f = fixture()
  try {
    const a = f.api('a'), b = f.api('b')
    const key = f.auth.createKey({ name: 'caller', apiIds: [a.id] })
    const updated = f.auth.updateKey(key.id, { name: 'renamed', version: key.version, apiIds: [b.id, b.id] })
    assert.deepEqual(updated.apiIds, [b.id])
    assert.equal((await f.call(a.path, key.key)).status, 403)
    assert.equal((await f.call(b.path, key.key)).status, 200)
    assert.throws(() => f.auth.updateKey(key.id, { name: 'stale', version: key.version, apiIds: [a.id] }), status(409))
    const cleared = f.auth.updateKey(key.id, { ...updated, apiIds: [] })
    assert.equal((await f.call(b.path, key.key)).status, 403)
    f.auth.updateKey(key.id, { ...cleared, apiIds: [a.id, b.id] })
    assert.equal((await f.call(a.path, key.key)).status, 200)
    assert.equal((await f.call(b.path, key.key)).status, 200)
    f.auth.deleteKey(key.id)
    assert.equal((await f.call(a.path, key.key)).status, 401)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM api_key_access').get()!.n, 0)
    const replacement = f.auth.createKey({ name: 'replacement', apiIds: [a.id] })
    assert.notEqual(replacement.id, key.id, 'revoked key IDs must not be reused by old editors')
    assert.throws(() => f.auth.updateKey(key.id, { ...cleared, apiIds: [b.id] }), status(404))
  } finally { await f.close() }
})

test('invalid grants roll back changes and never imply global access', async () => {
  const f = fixture()
  try {
    const a = f.api('a'), publicApi = f.api('public_api', { auth: 'PUBLIC' })
    const key = f.auth.createKey({ name: 'caller', apiIds: [a.id] })
    for (const apiIds of [undefined, null, 'all', [0], [-1], ['1'], [1.5], [Number.MAX_SAFE_INTEGER + 1], [9999], [publicApi.id], Array(1001).fill(a.id)]) {
      assert.throws(() => f.auth.createKey(asJson({ name: 'invalid', apiIds })), status(400))
      assert.throws(() => f.auth.updateKey(key.id, asJson({ name: 'invalid', version: key.version, apiIds })), status(400))
      assert.deepEqual(f.auth.listKeys(), [{ id: key.id, name: key.name, prefix: key.prefix, createdAt: key.createdAt,
        lastUsedAt: null, version: key.version, apiIds: [a.id] }])
    }
    const empty = f.auth.createKey({ name: 'pending', apiIds: [] })
    assert.equal((await f.call(a.path, empty.key)).status, 403)
    assert.doesNotMatch(JSON.stringify(f.auth.listKeys()), new RegExp(key.key + '|hash'))
  } finally { await f.close() }
})

test('deletion and auth changes remove grants and invalidate stale permission edits', async () => {
  const f = fixture()
  try {
    const a = f.api('a'), b = f.api('b')
    const key = f.auth.createKey({ name: 'caller', apiIds: [a.id, b.id] })
    f.apis.remove(b.id)
    assert.deepEqual(f.auth.listKeys()[0].apiIds, [a.id])
    const replacement = f.api('replacement')
    assert.equal((await f.call(replacement.path, key.key)).status, 403)
    assert.throws(() => f.auth.updateKey(key.id, { ...key, apiIds: [a.id, replacement.id] }), status(409))
    const beforeChange = f.auth.listKeys()[0]
    const changed = f.apis.save(a.id, asJson({ ...a, auth: 'PUBLIC' }))
    assert.deepEqual(f.auth.listKeys()[0].apiIds, [])
    assert.equal((await f.call(a.path)).status, 200)
    f.apis.save(a.id, asJson({ ...changed, auth: 'API_KEY' }))
    assert.equal((await f.call(a.path, key.key)).status, 403)
    assert.throws(() => f.auth.updateKey(key.id, { ...beforeChange, apiIds: [a.id] }), status(409))
  } finally { await f.close() }
})

test('old keys retain their hashes but are denied until explicitly authorized, including after restart', async () => {
  const f = fixture()
  try {
    const a = f.api('a')
    const key = f.auth.createKey({ name: 'legacy', apiIds: [a.id] })
    f.apis.createRow(a.id, { id: 'legacy-data' })
    const hash = f.db.prepare('SELECT hash FROM api_key WHERE id = ?').get(key.id)!.hash
    f.db.exec(legacyKeys)
    let upgraded = openDb(f.config.dbFile)
    try {
      let auth = new Auth(upgraded, f.config)
      assert.equal(upgraded.prepare('SELECT hash FROM api_key WHERE id = ?').get(key.id)!.hash, hash)
      const current = auth.listKeys()[0]
      assert.deepEqual(current.apiIds, [])
      assert.equal(current.prefix, key.prefix)
      assert.throws(() => auth.authorizeKey(key.key, a.id), status(403))
      auth.updateKey(key.id, { ...current, apiIds: [a.id] })
      auth.authorizeKey(key.key, a.id)
      upgraded.close(); upgraded = openDb(f.config.dbFile); auth = new Auth(upgraded, f.config)
      auth.authorizeKey(key.key, a.id)
      assert.deepEqual(auth.listKeys()[0].apiIds, [a.id])
      assert.deepEqual(f.apis.rows(a.id, 1, 10).items[0].data, { id: 'legacy-data' })
      assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), [])
    } finally { upgraded.close() }
  } finally { await f.close() }
})

test('key management requires admin and CSRF, returns permissions and never exposes stored credentials', async () => {
  const f = fixture()
  try {
    const a = f.api('a')
    for (const [path, method] of [['/admin/keys', 'GET'], ['/admin/keys', 'POST'], ['/admin/keys/1', 'PUT'], ['/admin/keys/1', 'DELETE']]) {
      assert.equal((await f.app.request(path, { method })).status, 401)
    }
    await f.auth.bootstrap()
    const token = await f.auth.login('admin', 'synthetic-key-password', 'test')
    const cookie = `databridge_session=${token}`
    for (const [path, method] of [['/admin/keys', 'POST'], ['/admin/keys/1', 'PUT'], ['/admin/keys/1', 'DELETE']]) {
      assert.equal((await f.app.request(path, { method, headers: { cookie }, body: '{}' })).status, 403)
    }
    const headers = { cookie, 'X-Requested-With': 'DataBridge', 'Content-Type': 'application/json' }
    const create = await f.app.request('/admin/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'caller', apiIds: [a.id] }) })
    assert.equal(create.status, 201)
    const key = await create.json()
    assert.match(key.key, /^dbk_/)
    assert.deepEqual(key.apiIds, [a.id])
    const edit = await f.app.request('/admin/keys/' + key.id, { method: 'PUT', headers, body: JSON.stringify({ name: 'caller', apiIds: [], version: key.version }) })
    assert.equal(edit.status, 200)
    const edited = await edit.json()
    assert.equal(edited.key, undefined)
    assert.equal(edited.hash, undefined)
    assert.deepEqual(edited.apiIds, [])
    assert.equal((await f.call(a.path, key.key)).status, 403)
    const stale = await f.app.request('/admin/keys/' + key.id, { method: 'PUT', headers, body: JSON.stringify(key) })
    assert.equal(stale.status, 409)
    const list = await f.app.request('/admin/keys', { headers })
    assert.equal(list.headers.get('Cache-Control'), 'no-store')
    assert.ok(!(await list.text()).includes(key.key))
    assert.equal((await f.app.request('/admin/keys/' + key.id, { method: 'DELETE', headers })).status, 204)
    assert.equal((await f.call(a.path, key.key)).status, 401)
  } finally { await f.close() }
})
