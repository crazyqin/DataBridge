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
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-copy-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'synthetic-copy-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config), apis = new Apis(db, sources, config)
  const logs = new Logs(db), app = createApp({ config, db, auth, sources, apis, logs })
  return { db, auth, sources, apis, logs, app, async close() {
    apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true })
  } }
}
const manual = { name: 'Manual', code: 'manual', path: '/open/manual', mode: 'MANUAL', auth: 'PUBLIC', enabled: true,
  fields: [{ name: 'id', type: 'string', required: true }], filters: ['id'], maxRows: 200 }

test('copy creates an independent disabled API and preserves the original and its data', async () => {
  const f = fixture()
  try {
    const original = f.apis.save(undefined, manual)
    f.apis.createRow(original.id, { id: 'original-row' })
    f.logs.write({ requestId: 'synthetic-request', at: now(), apiId: original.id, mode: original.mode, elapsedMs: 1, rowCount: 1, ok: true, error: null })
    const copy = f.apis.copy(original.id)
    assert.notEqual(copy.id, original.id)
    assert.equal(copy.enabled, false)
    assert.equal(copy.version, 1)
    assert.equal(copy.auth, original.auth)
    assert.deepEqual(copy.fields, original.fields)
    assert.deepEqual(copy.filters, original.filters)
    assert.equal(copy.maxRows, original.maxRows)
    assert.equal(f.apis.rows(copy.id, 1, 50).total, 0)
    assert.equal(f.logs.list({ apiId: String(copy.id) }).items.length, 0)
    assert.equal(f.apis.findOpen(copy.path, copy.method), undefined)
    const renamed = f.apis.save(copy.id, { ...manual, name: copy.name, path: copy.path, code: 'custom_copy_code', enabled: false, version: copy.version })
    assert.equal(renamed.code, 'custom_copy_code')
    assert.equal(renamed.path, copy.path)
    assert.throws(() => f.apis.save(copy.id, { ...manual, path: copy.path, code: original.code, enabled: false, version: renamed.version }), /接口编码已存在/)
    f.apis.createRow(copy.id, { id: 'copy-row' })
    assert.deepEqual(f.apis.rows(original.id, 1, 50).items[0].data, { id: 'original-row' })
    assert.deepEqual(f.apis.get(original.id), original)
    f.apis.remove(copy.id)
    assert.equal(f.apis.rows(original.id, 1, 50).total, 1)
  } finally { await f.close() }
})

test('copy avoids name, code and route collisions even at maximum field lengths', async () => {
  const f = fixture()
  try {
    const original = f.apis.save(undefined, { ...manual, name: '名'.repeat(100), code: 'a'.repeat(100), path: '/open/' + 'x'.repeat(294) })
    f.apis.save(undefined, { ...manual, name: original.name.slice(0, 96) + '（副本）', code: 'occupied_name', path: '/open/occupied-name' })
    f.apis.save(undefined, { ...manual, name: 'Occupied code', code: original.code.slice(0, 93) + '_copy_2', path: '/open/occupied-code' })
    f.apis.save(undefined, { ...manual, name: 'Occupied route', code: 'occupied_route', path: original.path.slice(0, 293) + '_copy_3' })
    const copies = [f.apis.copy(original.id), f.apis.copy(original.id)]
    assert.match(copies[0].path, /_copy_4$/)
    assert.match(copies[1].path, /_copy_5$/)
    for (const copy of copies) {
      assert.ok(copy.name.length <= 100 && copy.code.length <= 100 && copy.path.length <= 300)
      assert.ok(copy.code.startsWith('a') && copy.path.startsWith('/open/'))
    }
  } finally { await f.close() }
})

test('SQL and snapshot copies preserve configuration, reset synchronization state and stay unscheduled', async () => {
  const f = fixture()
  try {
    const source = f.sources.save(undefined, { name: 'Synthetic', host: '127.0.0.1', port: 1, database: 'unused', username: 'unused', password: 'unused' })
    for (const mode of ['REALTIME', 'SNAPSHOT']) {
      const original = f.apis.save(undefined, { name: mode, code: mode, path: '/open/' + mode, mode, auth: 'API_KEY', enabled: true,
        datasourceId: source.id, sql: mode === 'REALTIME' ? 'SELECT :id AS id' : 'SELECT 1 AS id',
        params: [{ name: 'id', type: 'integer', required: true }], fields: [{ name: 'id', type: 'integer' }],
        keyFields: ['id'], cron: '0 0 0 1 1 *', cronTimezone: 'Asia/Shanghai', allowEmpty: true, timeoutSeconds: 45,
        userAgents: ['SyntheticClient/*'] })
      if (mode === 'SNAPSHOT') {
        f.db.prepare("UPDATE api SET sync_at = ?, sync_status = 'FAILED', sync_count = 1, sync_error = 'synthetic failure' WHERE id = ?").run(now(), original.id)
        f.db.prepare('INSERT INTO api_row (api_id, row_key, data, position, updated_at) VALUES (?, ?, ?, 1, ?)').run(original.id, 'one', '{"id":1}', now())
        f.db.prepare("INSERT INTO sync_log (api_id, started_at, trigger, status) VALUES (?, ?, 'MANUAL', 'FAILED')").run(original.id, now())
      }
      const copy = f.apis.copy(original.id)
      for (const key of ['mode', 'auth', 'datasourceId', 'sql', 'params', 'fields', 'keyFields', 'cron', 'cronTimezone', 'allowEmpty', 'timeoutSeconds', 'userAgents'] as const) {
        assert.deepEqual(copy[key], original[key], key)
      }
      assert.equal(copy.enabled, false)
      assert.equal(copy.syncAt, null); assert.equal(copy.syncStatus, null); assert.equal(copy.syncCount, null); assert.equal(copy.syncError, null)
      if (mode === 'SNAPSHOT') {
        assert.equal(copy.nextSyncAt, null)
        assert.equal(f.apis.rows(copy.id, 1, 50).total, 0)
        assert.equal(f.apis.syncHistory(copy.id).items.length, 0)
        assert.equal(f.apis.rows(original.id, 1, 50).total, 1)
      }
    }
  } finally { await f.close() }
})

test('copy endpoint requires an admin session and CSRF header and handles missing APIs', async () => {
  const f = fixture()
  try {
    const original = f.apis.save(undefined, manual), path = `/admin/apis/${original.id}/copy`
    assert.equal((await f.app.request(path, { method: 'POST', headers: { 'X-Requested-With': 'DataBridge' } })).status, 401)
    await f.auth.bootstrap()
    const token = await f.auth.login('admin', 'synthetic-copy-password', 'test')
    const cookie = `databridge_session=${token}`
    assert.equal((await f.app.request(path, { method: 'POST', headers: { cookie } })).status, 403)
    const headers = { cookie, 'X-Requested-With': 'DataBridge' }
    assert.equal((await f.app.request('/admin/apis/9999/copy', { method: 'POST', headers })).status, 404)
    assert.equal(f.apis.list().length, 1)
    const response = await f.app.request(path, { method: 'POST', headers })
    assert.equal(response.status, 201)
    const copy = await response.json()
    assert.equal(copy.enabled, false)
    assert.notEqual(copy.id, original.id)
    assert.equal(f.apis.list().length, 2)
  } finally { await f.close() }
})
