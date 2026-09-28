import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Apis } from '../server/apis.ts'
import { createApp } from '../server/app.ts'
import { Auth } from '../server/auth.ts'
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'

test('existing row databases gain an empty remark without losing records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-migrate-'))
  const file = join(dir, 'old.db')
  const old = new DatabaseSync(file)
  try {
    old.exec(`CREATE TABLE api_row (api_id INTEGER, row_key TEXT, data TEXT, position INTEGER,
      sort INTEGER, version INTEGER DEFAULT 1, updated_at TEXT); PRAGMA user_version = 1;`)
    old.prepare('INSERT INTO api_row (api_id, row_key, data, position, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(1, 'old', '{"name":"kept"}', 0, '2026-01-01')
  } finally {
    old.close()
  }
  const upgraded = openDb(file)
  try {
    assert.deepEqual({ ...upgraded.prepare('SELECT row_key, data, remark FROM api_row').get() },
      { row_key: 'old', data: '{"name":"kept"}', remark: '' })
  } finally {
    upgraded.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stored search and sorting use global positions; open API pages large manual data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-page-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'test-password-123', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile)
  const auth = new Auth(db, config)
  const sources = new Sources(db, config)
  const apis = new Apis(db, sources, config)
  const app = createApp({ config, db, auth, sources, apis, logs: new Logs(db) })
  let cookie = ''
  async function call(method: string, path: string, value?: unknown) {
    const response = await app.request(path, {
      method,
      headers: { 'X-Requested-With': 'DataBridge', cookie, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: value === undefined ? undefined : JSON.stringify(value),
    })
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
    const body = await response.text()
    return { status: response.status, json: body ? JSON.parse(body) : undefined }
  }
  try {
    await auth.bootstrap()
    assert.equal((await call('POST', '/auth/login', { username: 'admin', password: 'test-password-123' })).status, 200)
    const manual = apis.save(undefined, {
      name: 'manual', code: 'manual', path: '/open/manual', mode: 'MANUAL', auth: 'PUBLIC', enabled: true,
      fields: [{ name: 'name', type: 'string' }], maxRows: 2,
    })
    for (let i = 0; i < 5; i++) apis.createRow(manual.id, { name: `item-${i}` })
    assert.equal((await call('GET', '/open/manual')).status, 422)
    const paged = await call('GET', '/open/manual?page=2&pageSize=2')
    assert.equal(paged.status, 200)
    assert.deepEqual(paged.json.data.map((row: { name: string }) => row.name), ['item-2', 'item-3'])
    assert.deepEqual(
      { page: paged.json.meta.page, size: paged.json.meta.page_size, total: paged.json.meta.total,
        pages: paged.json.meta.total_pages, more: paged.json.meta.has_more, count: paged.json.meta.count },
      { page: 2, size: 2, total: 5, pages: 3, more: true, count: 2 },
    )
    assert.equal((await call('GET', '/open/manual?page=0')).status, 400)
    assert.equal((await call('GET', '/open/manual?pageSize=3')).status, 400)
    assert.deepEqual((await call('GET', '/open/manual?page=4')).json.data, [])

    const collision = apis.save(undefined, {
      name: 'collision', code: 'collision', path: '/open/collision', mode: 'MANUAL', auth: 'PUBLIC', enabled: true,
      fields: [{ name: 'page', type: 'integer' }], filters: ['page'],
    })
    apis.createRow(collision.id, { page: 7 })
    apis.createRow(collision.id, { page: 8 })
    const businessPage = await call('GET', '/open/collision?page=7')
    assert.deepEqual(businessPage.json.data, [{ page: 7 }])
    assert.equal(businessPage.json.meta.page, undefined)
    assert.equal((await call('GET', '/open/collision?page=7&_page=1&_pageSize=1')).json.meta.total, 1)

    const source = sources.save(undefined, {
      name: 'unused', host: 'localhost', database: 'unused', username: 'unused', password: 'unused',
    })
    const snapshot = apis.save(undefined, {
      name: 'snapshot', code: 'snapshot', path: '/open/snapshot', mode: 'SNAPSHOT', datasourceId: source.id,
      sql: 'SELECT 1 AS id', keyFields: ['id'], cron: '0 0 3 * * *',
    })
    const insert = db.prepare('INSERT INTO api_row (api_id, row_key, data, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    for (let i = 0; i < 52; i++) insert.run(snapshot.id, `key-${i}`, JSON.stringify({ name: `item-${i}` }), i, '2026-01-01')
    db.prepare('UPDATE api_row SET data = ? WHERE api_id = ? AND row_key = ?')
      .run(JSON.stringify({ name: 'item-0', __databridge_remark: 'source value' }), snapshot.id, 'key-0')
    assert.equal((await call('PATCH', `/admin/apis/${snapshot.id}/rows/key-0/remark`, { version: 1, remark: 'platform value' })).status, 400)
    const second = await call('GET', `/admin/apis/${snapshot.id}/rows?page=2&pageSize=50`)
    assert.equal(second.json.items[0].position, 51)
    const found = await call('GET', `/admin/apis/${snapshot.id}/rows?search=item-51`)
    assert.deepEqual(found.json.items.map((row: { position: number }) => row.position), [52])
    assert.equal(found.json.allTotal, 52)
    assert.equal((await call('POST', `/admin/apis/${snapshot.id}/rows/key-50/move`, { position: 50 })).status, 204)
    const first = await call('GET', `/admin/apis/${snapshot.id}/rows?page=1&pageSize=50`)
    assert.ok(first.json.items.some((row: { key: string }) => row.key === 'key-50'))
    assert.equal(first.json.items.at(-1).key, 'key-50')
    assert.equal((await call('GET', `/admin/apis/${snapshot.id}/rows?search=%25`)).json.total, 0)
  } finally {
    apis.stopSchedules()
    await sources.closeAll()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
