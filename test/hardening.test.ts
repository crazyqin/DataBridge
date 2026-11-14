import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Apis } from '../server/apis.ts'
import { Auth } from '../server/auth.ts'
import { decrypt, encrypt, loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { HttpError } from '../server/errors.ts'
import { Sources } from '../server/sources.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-hardening-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'synthetic-admin-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config), apis = new Apis(db, sources, config)
  return { dir, config, db, auth, apis, async close() {
    apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true })
  } }
}
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected

test('parallel wrong passwords each count towards the login limit', async () => {
  const f = fixture()
  try {
    await f.auth.bootstrap()
    const attempts = await Promise.allSettled(Array.from({ length: 30 }, () => f.auth.login('admin', 'wrong-password', 'client-a')))
    const limited = attempts.filter(result => result.status === 'rejected' && (result.reason as HttpError).status === 429)
    assert.equal(attempts.length - limited.length, 10, 'only ten guesses reach the password check')
    await assert.rejects(f.auth.login('admin', 'synthetic-admin-password', 'client-a'), status(429))
    assert.ok(await f.auth.login('admin', 'synthetic-admin-password', 'client-b'))
  } finally { await f.close() }
})

test('TRUST_PROXY accepts true, false or a proxy count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-proxy-'))
  try {
    const trust = (value?: string) => loadConfig({ DATA_DIR: dir, TRUST_PROXY: value }).trustProxy
    assert.equal(trust(), 0)
    assert.equal(trust('false'), 0)
    assert.equal(trust('0'), 0)
    assert.equal(trust('true'), 1)
    assert.equal(trust('2'), 2)
    assert.throws(() => trust('yes'), /TRUST_PROXY/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('decryption requires the full authentication tag', () => {
  const key = Buffer.alloc(32, 1)
  const sealed = Buffer.from(encrypt(key, 'secret'), 'base64')
  assert.equal(decrypt(key, sealed.toString('base64')), 'secret')
  assert.throws(() => decrypt(key, sealed.subarray(0, 20).toString('base64')))
})

test('a database from a newer release is refused instead of opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-schema-'))
  try {
    const file = join(dir, 'databridge.db')
    openDb(file).close()
    const raw = new DatabaseSync(file)
    const { user_version: current } = raw.prepare('PRAGMA user_version').get() as { user_version: number }
    raw.exec(`PRAGMA user_version = ${current + 1}`)
    raw.close()
    assert.throws(() => openDb(file), /newer than this build supports/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('directory sync history is pruned with the log retention but pending candidates stay', async () => {
  const f = fixture()
  try {
    const insert = f.db.prepare(`INSERT INTO directory_sync (started_at, trigger, status, config_version, source_version, baseline_version)
      VALUES (?, 'MANUAL', ?, 1, 1, 0)`)
    const old = '2020-01-01T00:00:00.000Z', recent = new Date().toISOString()
    for (const [at, state] of [[old, 'SUCCESS'], [old, 'FAILED'], [old, 'PENDING'], [recent, 'SUCCESS']]) insert.run(at, state)
    f.apis.pruneSyncHistory(30)
    const left = f.db.prepare('SELECT started_at AS at, status FROM directory_sync ORDER BY id').all()
    assert.deepEqual(left.map(row => ({ ...row })), [{ at: old, status: 'PENDING' }, { at: recent, status: 'SUCCESS' }])
  } finally { await f.close() }
})
