import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { Apis } from '../server/apis.ts'
import { createApp } from '../server/app.ts'
import { Auth } from '../server/auth.ts'
import { loadConfig } from '../server/config.ts'
import { openDb, transaction } from '../server/db.ts'
import { HttpError } from '../server/errors.ts'
import { Exports } from '../server/exports.ts'
import { Logs } from '../server/logs.ts'
import { Sources } from '../server/sources.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-export-test-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'synthetic-export-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config), apis = new Apis(db, sources, config)
  const logs = new Logs(db), exports = new Exports(config), app = createApp({ config, db, auth, sources, apis, logs, exports })
  return { dir, config, db, auth, sources, apis, logs, exports, app, async close() {
    await exports.close(); apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true })
  } }
}
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected
async function completed(exports: Exports, id: string) {
  for (let i = 0; i < 1000; i++) {
    const job = exports.get(id)
    if (job.status !== 'RUNNING') return job
    await delay(10)
  }
  throw new Error('Export did not complete')
}
function unpack(buffer: Buffer) {
  const tar = gunzipSync(buffer), entries = new Map<string, Buffer>()
  for (let offset = 0; offset < tar.length && tar[offset];) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, ''), 8)
    assert.equal(header.subarray(257, 263).toString(), 'ustar\0')
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return { entries, json: (path: string) => JSON.parse(entries.get(path)!.toString()),
    lines: (path: string): any[] => entries.get(path)!.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
async function download(exports: Exports, id: string) {
  const { stream } = await exports.download(id)
  return Buffer.from(await new Response(stream).arrayBuffer())
}
function seedLogs(f: ReturnType<typeof fixture>, n: number) {
  transaction(f.db, () => {
    const insert = f.db.prepare(`INSERT INTO request_log(request_id,at,api_id,mode,elapsed_ms,row_count,ok,error,method,path,status)
      VALUES (?, '2026-10-30T12:00:00.000Z', NULL, 'MANUAL', ?, 0, ?, ?, 'GET', '/open/deleted', ?)`)
    for (let i = 1; i <= n; i++) insert.run('synthetic-' + i, i, i % 2, i % 2 ? null : '=failure,"quoted"\nsecond line', i % 2 ? 200 : 500)
  })
}

test('full export includes every table, raw credentials, exact JSON, diagnostic joins, all pages and reproducible statistics', async () => {
  const f = fixture()
  try {
    await f.auth.bootstrap()
    const api = f.apis.save(undefined, { name: 'Export fixture', code: 'fixture', path: '/open/fixture', mode: 'MANUAL', auth: 'API_KEY', enabled: true,
      fields: [{ name: 'id', type: 'string' }, { name: 'amount', type: 'decimal' }, { name: 'quantity', type: 'integer' }] })
    f.apis.createRow(api.id, { id: '00001', amount: JSON.rawJSON('1.10'), quantity: JSON.rawJSON('9007199254740993') })
    // Snapshot queries can retain decimal scale verbatim, unlike manual-field normalization.
    f.db.prepare('UPDATE api_row SET data = ? WHERE api_id = ?').run('{"id":"00001","amount":1.10,"quantity":9007199254740993}', api.id)
    const project = f.apis.projects.save(undefined, { name: 'Original project' })
    f.apis.projects.changeMembers(project.id, { apiIds: [api.id], operation: 'add' })
    const key = f.auth.createKey({ name: 'Original caller', apiIds: [api.id] })
    f.sources.save(undefined, { name: 'External source', host: '127.0.0.1', port: 1, database: 'unused', username: 'internal-user', password: 'synthetic-original-password' })
    f.apis.connections.save(undefined, { kind: 'EXTERNAL_AUTH', name: 'Original identity', config: {
      url: 'https://internal.example.invalid/verify', method: 'POST', inputHeader: 'Authorization', inputPrefix: 'Bearer ', tokenLocation: 'header', tokenName: 'Authorization',
      headers: { 'X-Service-Key': 'synthetic-original-service-secret' }, successPath: 'active', successValue: true } })
    seedLogs(f, 501)
    const trace = { headers: '{"Authorization":"Bearer synthetic-person-token"}', body: '{"amount":1.10,"id":9007199254740993}',
      responseBody: 'original truncated response', responseBodyTruncated: true, api: { name: 'Original name at call' } }
    const external = { redacted: false, request: { headers: { Cookie: 'original-session-cookie' } } }
    f.db.prepare('INSERT INTO request_detail_log VALUES (?, ?)').run(1, JSON.stringify(trace))
    f.db.prepare('INSERT INTO request_auth_log VALUES (?, ?)').run(1, JSON.stringify(external))
    const job = await f.exports.start()
    await assert.rejects(f.exports.start(), status(409))
    await assert.rejects(f.exports.download(job.id), status(409))
    const ready = await completed(f.exports, job.id)
    assert.equal(ready.status, 'READY', ready.error)
    assert.equal(ready.tableCounts!.request_log, 501)
    const compressed = await download(f.exports, job.id)
    assert.equal(createHash('sha256').update(compressed).digest('hex'), ready.sha256)
    const archive = unpack(compressed), manifest = archive.json('manifest.json')
    assert.equal(manifest.redacted, false)
    assert.equal(manifest.tableCounts.request_log, 501)
    const tables = f.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    for (const table of tables) {
      assert.ok(archive.entries.has(`tables/${table.name}.jsonl`), String(table.name))
      const count = f.db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get()!.n
      assert.equal(manifest.tableCounts[String(table.name)], count)
    }
    for (const file of manifest.files) {
      const content = archive.entries.get(file.path)!
      assert.equal(content.length, file.bytes)
      assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256)
    }
    assert.equal(archive.entries.get('raw/secret.key')!.toString().trim(), f.config.secretKey.toString('base64'))
    assert.equal(archive.lines('configuration/datasources.jsonl')[0].password, 'synthetic-original-password')
    assert.equal(archive.lines('configuration/connections.jsonl')[0].config.headers['x-service-key'], 'synthetic-original-service-secret')
    assert.deepEqual(archive.lines('tables/api_key_access.jsonl'), [{ key_id: key.id, api_id: api.id }])
    assert.match(archive.entries.get('analysis/api_rows.jsonl')!.toString(), /"amount":1\.10/)
    assert.match(archive.entries.get('analysis/api_rows.jsonl')!.toString(), /9007199254740993/)
    const requests = archive.lines('analysis/requests.jsonl')
    assert.equal(requests.length, 501)
    assert.deepEqual(requests[0].request, trace)
    assert.deepEqual(requests[0].external_auth, external)
    assert.equal(requests[1].request, null)
    const summary = archive.json('analysis/summary.json')
    assert.equal(summary.calls, 501); assert.equal(summary.successes, 251); assert.equal(summary.failures, 250)
    assert.equal(summary.mean_ms, 251); assert.equal(summary.p50_ms, 251); assert.equal(summary.p95_ms, 476); assert.equal(summary.p99_ms, 496)
    assert.equal(summary.failure_rate, 250 / 501)
    assert.equal(summary.success_rate, 251 / 501)
    const csv = archive.entries.get('analysis/requests.csv')!.toString()
    assert.ok(csv.startsWith('\uFEFF'))
    assert.match(csv, /"=failure,""quoted""\nsecond line"/)
    const snapshotPath = join(f.dir, 'snapshot.sqlite')
    writeFileSync(snapshotPath, archive.entries.get('raw/databridge.sqlite')!)
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    try {
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
      assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM request_log').get()!.n, 501)
      assert.equal(snapshot.prepare('SELECT hash FROM api_key').get()!.hash, f.db.prepare('SELECT hash FROM api_key').get()!.hash)
    } finally { snapshot.close() }
    // An already-open download remains readable if its temporary job is deleted.
    const opened = await f.exports.download(job.id)
    await f.exports.remove(job.id)
    assert.equal(Buffer.from(await new Response(opened.stream).arrayBuffer()).length, compressed.length)
    assert.throws(() => f.exports.get(job.id), status(404))
  } finally { await f.close() }
})

test('empty databases export valid files and null latency statistics, retain at most three jobs and clean cancellation', async () => {
  const f = fixture()
  try {
    const cancelled = await f.exports.start()
    await f.exports.remove(cancelled.id)
    assert.deepEqual(await readdir(join(f.dir, '.exports')), [])
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const job = await f.exports.start(); ids.push(job.id)
      const ready = await completed(f.exports, job.id)
      assert.equal(ready.status, 'READY', ready.error)
    }
    assert.equal(f.exports.list().length, 3)
    assert.throws(() => f.exports.get(ids[0]), status(404))
    const archive = unpack(await download(f.exports, ids[3]))
    assert.equal(archive.lines('analysis/requests.jsonl').length, 0)
    const summary = archive.json('analysis/summary.json')
    assert.equal(summary.calls, 0); assert.equal(summary.successes, 0); assert.equal(summary.p95_ms, null); assert.equal(summary.failure_rate, null)
    await f.exports.close()
    assert.deepEqual(await readdir(join(f.dir, '.exports')), [])
  } finally { await f.close() }
})

test('exports capture a consistent WAL snapshot while calls continue to be recorded', async () => {
  const f = fixture()
  let writer: NodeJS.Timeout | undefined
  try {
    seedLogs(f, 50)
    let written = 0
    writer = setInterval(() => {
      f.logs.write({ requestId: 'concurrent-' + written++, at: new Date().toISOString(), apiId: null, mode: null, elapsedMs: 5, rowCount: 0, ok: true, error: null })
    }, 1)
    const ready = await completed(f.exports, (await f.exports.start()).id)
    clearInterval(writer)
    assert.equal(ready.status, 'READY', ready.error)
    assert.ok(written > 0)
    const archive = unpack(await download(f.exports, ready.id))
    const count = archive.json('manifest.json').tableCounts.request_log
    assert.equal(archive.lines('tables/request_log.jsonl').length, count)
    assert.equal(archive.lines('analysis/requests.jsonl').length, count)
    assert.equal(archive.json('analysis/summary.json').calls, count)
    assert.ok(count <= Number(f.db.prepare('SELECT COUNT(*) AS n FROM request_log').get()!.n))
  } finally { if (writer) clearInterval(writer); await f.close() }
})

test('worker failures clean partial files and do not expose server paths', async () => {
  const f = fixture()
  const broken = new Exports({ ...f.config, dbFile: join(f.dir, 'missing.sqlite') })
  try {
    const job = await completed(broken, (await broken.start()).id)
    assert.equal(job.status, 'FAILED')
    assert.ok(!JSON.stringify(job).includes(f.dir))
    await assert.rejects(broken.download(job.id), status(409))
    // Filesystem cleanup follows the failure notification.
    await broken.close()
    assert.deepEqual(await readdir(join(f.dir, '.exports')), [])
  } finally { await broken.close(); await f.close() }
})

test('export management and every download require admin; mutations require CSRF and attachment headers are correct', async () => {
  const f = fixture()
  try {
    for (const [path, method] of [['/admin/exports', 'GET'], ['/admin/exports', 'POST'], ['/admin/exports/unknown', 'GET'],
      ['/admin/exports/unknown/download', 'GET'], ['/admin/exports/unknown', 'DELETE']]) {
      assert.equal((await f.app.request(path, { method })).status, 401)
    }
    await f.auth.bootstrap()
    const cookie = 'databridge_session=' + await f.auth.login('admin', 'synthetic-export-password', 'test')
    assert.equal((await f.app.request('/admin/exports', { method: 'POST', headers: { cookie } })).status, 403)
    const headers = { cookie, 'X-Requested-With': 'DataBridge' }
    const response = await f.app.request('/admin/exports', { method: 'POST', headers })
    assert.equal(response.status, 202)
    const job = await response.json()
    assert.equal((await completed(f.exports, job.id)).status, 'READY')
    const download = await f.app.request(`/admin/exports/${job.id}/download`, { headers })
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('Content-Type'), 'application/gzip')
    assert.match(download.headers.get('Content-Disposition')!, /^attachment; filename="databridge-export-.*\.tar\.gz"$/)
    assert.match(download.headers.get('Cache-Control')!, /no-store/)
    assert.equal((await download.arrayBuffer()).byteLength, Number(download.headers.get('Content-Length')))
    assert.equal((await f.app.request(`/admin/exports/${job.id}`, { method: 'DELETE', headers: { cookie } })).status, 403)
    assert.equal((await f.app.request(`/admin/exports/${job.id}`, { method: 'DELETE', headers })).status, 204)
    assert.equal((await f.app.request(`/admin/exports/${job.id}/download`, { headers })).status, 404)
  } finally { await f.close() }
})

test('restart clears old job files and expiration rejects downloads', async t => {
  const f = fixture()
  const next = new Exports(f.config)
  try {
    const ready = await completed(f.exports, (await f.exports.start()).id)
    assert.equal(ready.status, 'READY')
    // The service owns one process; reinitialization models the next process starting.
    await next.initialize()
    assert.deepEqual(await readdir(join(f.dir, '.exports')), [])
    await assert.rejects(f.exports.download(ready.id), status(404))
    const current = await completed(next, (await next.start()).id)
    assert.equal(current.status, 'READY')
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(current.expiresAt!) + 1 })
    assert.throws(() => next.get(current.id), status(404))
    await assert.rejects(next.download(current.id), status(404))
    t.mock.timers.reset()
  } finally { await next.close(); await f.close() }
})
