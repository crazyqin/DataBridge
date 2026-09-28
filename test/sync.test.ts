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
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'

test('snapshot Cron uses its saved time zone and exposes it with the next run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-sync-'))
  const config = loadConfig({ DATA_DIR: dir, TZ: 'UTC', ADMIN_PASSWORD: 'test-password-123' })
  const db = openDb(config.dbFile)
  const sources = new Sources(db, config)
  const apis = new Apis(db, sources, config)
  const auth = new Auth(db, config)
  const app = createApp({ config, db, sources, apis, auth, logs: new Logs(db) })
  try {
    await auth.bootstrap()
    const source = sources.save(undefined, {
      name: 'unused', host: 'localhost', database: 'unused', username: 'unused', password: 'unused',
    })
    const base = {
      name: 'daily', code: 'daily', path: '/open/daily', mode: 'SNAPSHOT', datasourceId: source.id,
      sql: 'SELECT 1 AS id', keyFields: ['id'], cron: '0 0 12 * * *', enabled: true,
    }
    assert.throws(() => apis.save(undefined, { ...base, cronTimezone: 'Invalid/Zone' }), /同步时区无效/)
    const api = apis.save(undefined, { ...base, cronTimezone: 'Asia/Shanghai' })
    assert.equal(api.cronTimezone, 'Asia/Shanghai')
    assert.ok(api.nextSyncAt)
    const localHour = new Intl.DateTimeFormat('en-US', {
      timeZone: api.cronTimezone!, hour: '2-digit', hourCycle: 'h23',
    }).format(new Date(api.nextSyncAt!))
    assert.equal(localHour, '12')
    assert.equal(new Date(api.nextSyncAt!).getUTCHours(), 4)
    assert.deepEqual(apis.syncHistory(api.id), { items: [], nextBefore: null })
    const saved = apis.save(api.id, { ...base, version: api.version, cronTimezone: 'UTC' })
    assert.equal(saved.cronTimezone, 'UTC')
    assert.equal(new Date(saved.nextSyncAt!).getUTCHours(), 12)
    sources.save(source.id, { ...source, password: '', enabled: false })
    await assert.rejects(apis.sync(api.id), /数据源已停用/)
    const history = apis.syncHistory(api.id)
    assert.equal(history.items[0].trigger, 'MANUAL')
    assert.equal(history.items[0].status, 'FAILED')
    assert.match(history.items[0].error!, /数据源已停用/)
    assert.ok(history.items[0].finishedAt)
    assert.equal(apis.get(api.id).syncStatus, 'FAILED')
    assert.equal((await app.request(`/admin/apis/${api.id}/sync-history`)).status, 401)
    const login = await app.request('/auth/login', {
      method: 'POST', headers: { 'X-Requested-With': 'DataBridge', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-password-123' }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const list = await app.request(`/admin/apis/${api.id}/sync-history`, { headers: { cookie } })
    assert.equal(list.status, 200)
    assert.equal((await list.json()).items[0].status, 'FAILED')
    assert.equal((await app.request(`/admin/apis/${api.id}/sync-history?before=bad`, { headers: { cookie } })).status, 400)
  } finally {
    apis.stopSchedules()
    await sources.closeAll()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
