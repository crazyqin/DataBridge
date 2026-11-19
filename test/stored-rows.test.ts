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
import type { JsonObject } from '../server/json.ts'
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'

// Stored rows are read by the row worker from the filter index; these tests compare it with comparing every row.
const PG_URL = process.env.TEST_PG_URL

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-rows-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'test-password-123', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile)
  const sources = new Sources(db, config)
  const apis = new Apis(db, sources, config)
  const logs = new Logs(db)
  const app = createApp({ config, db, auth: new Auth(db, config), sources, apis, logs })
  const open = async (path: string) => {
    const response = await app.request(path)
    return { status: response.status, json: await response.json() }
  }
  const generations = (apiId: number) => (db.prepare('SELECT DISTINCT generation FROM api_row WHERE api_id = ? ORDER BY generation')
    .all(apiId) as { generation: number }[]).map(row => row.generation)
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 2000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(done(), 'background row work did not finish')
  }
  return { db, sources, apis, logs, open, generations, settle,
    async close() { apis.stopSchedules(); await apis.close(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('filtered and paged stored-row calls give the same results from the index as from comparing every row', async () => {
  const f = fixture()
  try {
    const api = f.apis.save(undefined, {
      name: 'manual', code: 'manual', path: '/open/manual', mode: 'MANUAL', auth: 'PUBLIC', enabled: true, maxRows: 4,
      fields: [{ name: 'id', type: 'integer' }, { name: 'amount', type: 'decimal' }, { name: 'name', type: 'string' }, { name: 'flag', type: 'boolean' }],
      filters: ['amount', 'name', 'flag'],
    })
    const rows: JsonObject[] = [
      { id: 1, amount: '1.50', name: 'a', flag: true }, { id: 2, amount: 1.5, name: 'b', flag: false }, { id: 3, amount: 2, name: '', flag: true },
      { id: 4, name: 'a' }, { id: 5, amount: '10', name: 'a', flag: false }, { id: 6, amount: '1e1', name: 'c' },
    ]
    const keys = rows.map(row => f.apis.createRow(api.id, row).key)
    f.apis.updateRemark(api.id, keys[0], 1, 'checked')
    const queries = ['', '?amount=1.5', '?amount=1.500', '?amount=10', '?amount=', '?name=a', '?name=', '?flag=true', '?flag=false&name=a',
      '?amount=1.5&flag=true', '?name=a&page=1&pageSize=2', '?name=a&page=2&pageSize=2', '?amount=10&_page=1&_pageSize=1', '?name=zzz', '?flag=']
    const results = async () => Promise.all(queries.map(async query => {
      const { status, json } = await f.open(`/open/manual${query}`)
      return { status, data: json.data, total: json.meta?.total, count: json.meta?.count }
    }))
    const indexed = await results()
    assert.deepEqual(indexed[1].data.map((row: { id: number }) => row.id), [1, 2])
    assert.equal(indexed[1].data[0].__databridge_remark, 'checked')
    assert.deepEqual(indexed[3].data.map((row: { id: number }) => row.id), [5, 6])
    assert.deepEqual(indexed[4].data.map((row: { id: number }) => row.id), [4])
    assert.deepEqual(indexed[6].data.map((row: { id: number }) => row.id), [3])
    assert.deepEqual(indexed[8].data.map((row: { id: number }) => row.id), [5])
    assert.deepEqual(indexed[10].data.map((row: { id: number }) => row.id), [1, 4])
    assert.deepEqual([indexed[11].data.map((row: { id: number }) => row.id), indexed[11].total], [[5], 3])
    assert.equal(indexed[0].status, 422) // six rows exceed maxRows 4
    assert.equal((await f.open('/open/manual?id=1')).status, 400) // not a filter

    f.db.prepare('UPDATE api SET row_filters = NULL WHERE id = ?').run(api.id)
    assert.deepEqual(await results(), indexed)

    // Row edits keep the index current; adding a filter re-indexes the stored rows in place.
    f.db.prepare('UPDATE api SET row_filters = ? WHERE id = ?').run(JSON.stringify([['amount', 'decimal'], ['name', 'string'], ['flag', 'boolean']]), api.id)
    f.apis.updateRow(api.id, keys[1], 1, { id: 2, amount: 3, name: 'b', flag: false })
    f.apis.deleteRow(api.id, keys[4], 1)
    assert.deepEqual((await f.open('/open/manual?amount=1.5')).json.data.map((row: { id: number }) => row.id), [1])
    assert.deepEqual((await f.open('/open/manual?amount=3')).json.data.map((row: { id: number }) => row.id), [2])
    assert.deepEqual((await f.open('/open/manual?amount=10')).json.data.map((row: { id: number }) => row.id), [6])
    const current = f.apis.get(api.id)
    f.apis.save(api.id, { ...current, filters: ['id', 'name'], version: current.version, projectVersion: current.projectVersion } as never)
    assert.deepEqual((await f.open('/open/manual?id=6&name=c')).json.data, [{ id: 6, amount: 10, name: 'c', flag: null }])
    assert.equal((await f.open('/open/manual?amount=3')).status, 400)
  } finally { await f.close() }
})

test('a snapshot filter change is rebuilt in the background; calls stay correct and row edits wait for it', async () => {
  const f = fixture()
  try {
    const source = f.sources.save(undefined, { name: 'unused', host: 'localhost', database: 'unused', username: 'unused', password: 'unused' })
    const api = f.apis.save(undefined, {
      name: 'snapshot', code: 'snapshot', path: '/open/snapshot', mode: 'SNAPSHOT', auth: 'PUBLIC', enabled: true, datasourceId: source.id,
      sql: 'SELECT 1 AS id', keyFields: ['id'], cron: '0 0 3 * * *', maxRows: 10_000, fields: [{ name: 'team', type: 'string' }], filters: ['team'],
    })
    f.db.prepare(`WITH RECURSIVE items(id) AS (VALUES (1) UNION ALL SELECT id + 1 FROM items WHERE id < 2500)
      INSERT INTO api_row (api_id, row_key, data, position, updated_at)
      SELECT ?, printf('key-%05d', id), json_object('id', id, 'team', 't' || (id % 3), 'size', id % 7), id, '2026-01-01' FROM items`).run(api.id)
    f.db.prepare("UPDATE api_row SET remark = 'kept', version = 4 WHERE api_id = ? AND row_key = 'key-00009'").run(api.id)
    f.apis.moveRow(api.id, 'key-00009', 1)
    const current = f.apis.get(api.id)
    f.apis.save(api.id, { ...current, fields: [{ name: 'team', type: 'string' }, { name: 'size', type: 'integer' }], filters: ['team', 'size'],
      version: current.version, projectVersion: current.projectVersion } as never)
    // The rebuild has started: calls compare every row, and remarks and order cannot change until it ends.
    assert.throws(() => f.apis.updateRemark(api.id, 'key-00001', 1, 'x'), /正在同步或整理/)
    const during = (await f.open('/open/snapshot?team=t0&size=3&page=1&pageSize=5')).json
    await f.settle(() => f.generations(api.id).length === 1 && f.generations(api.id)[0] !== 0)
    const after = (await f.open('/open/snapshot?team=t0&size=3&page=1&pageSize=5')).json
    assert.deepEqual(after.data, during.data)
    assert.equal(after.meta.total, 119)
    assert.deepEqual(after.data[0], { id: 3, team: 't0', size: 3 })
    const first = (await f.open('/open/snapshot?team=t0&size=2&page=1&pageSize=1')).json.data[0]
    assert.deepEqual(first, { id: 9, team: 't0', size: 2, __databridge_remark: 'kept' })
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM api_row WHERE api_id = ?').get(api.id)!.n, 2500)
    assert.equal((await f.apis.rows(api.id, 1, 1)).items[0].version, 4)
    // Changing mode switches to an empty generation; the old rows are removed in the background.
    const latest = f.apis.get(api.id)
    f.apis.save(api.id, { ...latest, mode: 'MANUAL', version: latest.version, projectVersion: latest.projectVersion } as never)
    assert.equal((await f.apis.rows(api.id, 1, 10)).total, 0)
    await f.settle(() => f.generations(api.id).length === 0)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM api_row_filter WHERE api_id = ?').get(api.id)!.n, 0)
  } finally { await f.close() }
})

test('a sync writes a new generation while calls keep reading the previous snapshot', { skip: !PG_URL && 'set TEST_PG_URL to run integration tests' }, async () => {
  const f = fixture()
  const url = new URL(PG_URL!)
  try {
    const source = f.sources.save(undefined, { name: 'pg', host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
      username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) })
    let size = 30_000
    const api = () => f.apis.get(created.id)
    const current = () => (f.db.prepare('SELECT row_generation AS n FROM api WHERE id = ?').get(created.id) as { n: number }).n
    // Wait until the next generation is being written and is not yet current.
    const writing = async () => {
      const previous = current()
      await f.settle(() => f.generations(created.id).some(generation => generation > previous) && current() === previous)
    }
    const created = f.apis.save(undefined, {
      name: 'sync', code: 'sync', path: '/open/sync', mode: 'SNAPSHOT', auth: 'PUBLIC', enabled: true, datasourceId: source.id,
      sql: `SELECT g AS id, 'v1' AS version, g % 10 AS bucket FROM generate_series(1, ${size}) g`, keyFields: ['id'], cron: '0 0 3 * * *',
      maxRows: 100_000, fields: [{ name: 'bucket', type: 'integer' }], filters: ['bucket'],
    })
    assert.deepEqual(await f.apis.sync(created.id), { count: size })
    f.apis.updateRemark(created.id, (await f.apis.rows(created.id, 1, 1)).items[0].key, 1, 'carried')
    const before = api()
    await f.settle(() => f.generations(created.id).length === 1)
    size = 20_000
    f.apis.save(created.id, { ...before, sql: `SELECT g AS id, 'v2' AS version, g % 10 AS bucket FROM generate_series(1, ${size}) g`,
      version: before.version, projectVersion: before.projectVersion } as never)
    const sync = f.apis.sync(created.id)
    await writing()
    const during = (await f.open('/open/sync?bucket=1&page=1&pageSize=1')).json
    assert.deepEqual([during.data[0].version, during.meta.total], ['v1', 3000])
    assert.deepEqual(await sync, { count: 20_000 })
    const after = (await f.open('/open/sync?bucket=1&page=1&pageSize=1')).json
    assert.deepEqual([after.data[0], after.meta.total], [{ id: 1, version: 'v2', bucket: 1, __databridge_remark: 'carried' }, 2000])
    await f.settle(() => f.generations(created.id).length === 1)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM api_row_filter WHERE api_id = ?').get(created.id)!.n, 20_000)
    // A configuration change during the write leaves the previous snapshot in place and removes the partial one.
    const changing = api()
    const failed = f.apis.sync(created.id)
    await writing()
    f.apis.save(created.id, { ...changing, name: 'renamed', version: changing.version, projectVersion: changing.projectVersion } as never)
    await assert.rejects(failed, /同步期间 API 配置已变更/)
    await f.settle(() => f.generations(created.id).length === 1)
    assert.equal((await f.open('/open/sync?bucket=1&page=1&pageSize=1')).json.meta.total, 2000)
  } finally { await f.close() }
})
