import { strict as assert } from 'node:assert'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { Auth } from '../server/auth.ts'
import { Sources } from '../server/sources.ts'
import { Apis } from '../server/apis.ts'
import { Logs } from '../server/logs.ts'
import { createApp } from '../server/app.ts'
import type { JsonObject } from '../server/json.ts'

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

test('DataSkill forwards verified staff, scopes status calls, and never stores task bodies or credentials in diagnostics', async () => {
  const calls: { path: string; authorization: string | undefined; body: any }[] = []
  let studioStatus = 202
  const identity = createServer((req, res) => {
    const good = req.headers.authorization === 'Bearer personal-A'
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ active: good, data: { staffCode: '00123' } }))
  })
  const studio = createServer(async (req, res) => {
    const buffers = []
    for await (const chunk of req) buffers.push(chunk)
    calls.push({ path: req.url!, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(buffers).toString()) })
    res.writeHead(studioStatus, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(studioStatus === 202 ? { feedback_id: '12345678-1234-1234-1234-123456789abc', status: 'received' }
      : { detail: { code: 'owner_changed' }, internal: 'must-not-leak' }))
  })
  const directory = mkdtempSync(join(tmpdir(), 'databridge-feedback-'))
  const authUrl = await listen(identity), studioUrl = await listen(studio)
  const config = loadConfig({ DATA_DIR: directory, ADMIN_PASSWORD: 'test-password', DATASKILL_STUDIO_URL: studioUrl,
    DATASKILL_SERVICE_TOKEN: 'server-only-token-32-characters-long', DATASKILL_AUTH_CONNECTION_ID: '1' })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config)
  const apis = new Apis(db, sources, config), logs = new Logs(db)
  const settings = { url: authUrl, method: 'POST', inputHeader: 'Authorization', inputPrefix: 'Bearer ',
    tokenLocation: 'header', tokenName: 'Authorization', tokenPrefix: 'Bearer ', headers: {}, dynamicHeaders: {}, body: {},
    successStatus: 200, successPath: 'active', successValue: true, successConditions: [],
    bindings: [{ name: '_auth_staff_code', path: 'data.staffCode', type: 'string' }], timeoutSeconds: 5 }
  const connection = apis.connections.save(undefined, { name: 'uap', kind: 'EXTERNAL_AUTH', config: settings })
  assert.equal(connection.id, 1)
  const app = createApp({ config, db, auth, sources, apis, logs })
  const call = (payload: JsonObject, token = 'personal-A', extra = {}) => app.request('/open/dataskill/feedback', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(payload) })
  try {
    assert.equal((await call({ task: 'sensitive SQL text' }, 'expired')).status, 401)
    assert.equal(calls.length, 0)
    assert.equal((await call({ actor: { staff_code: '99999' } })).status, 400)
    assert.equal((await call({ staff_code: '99999' })).status, 400)
    const response = await call({ task: 'sensitive SQL text' }, 'personal-A', { 'X-DataBridge-Staff-Code': '99999' })
    assert.equal(response.status, 202)
    assert.equal(calls[0].body.actor.staff_code, '00123')
    assert.equal(calls[0].body.actor.provider, 'uap')
    assert.equal(calls[0].body.payload.task, 'sensitive SQL text')
    assert.equal(calls[0].authorization, 'Bearer server-only-token-32-characters-long')
    assert.ok(!JSON.stringify(calls).includes('personal-A'))
    assert.equal((await app.request('/open/dataskill/feedback/12345678-1234-1234-1234-123456789abc', { headers: { Authorization: 'Bearer personal-A' } })).status, 202)
    assert.match(calls.at(-1)!.path, /\/status$/)
    studioStatus = 409
    const conflict = await call({ task: 'same' })
    assert.equal(conflict.status, 409)
    const errorText = await conflict.text()
    assert.match(errorText, /owner_changed/); assert.doesNotMatch(errorText, /must-not-leak/)
    studioStatus = 401
    assert.equal((await call({ task: 'same' })).status, 502)
    assert.throws(() => apis.connections.remove(connection.id), /DataSkill/)
    assert.throws(() => apis.connections.save(connection.id, { name: 'uap', kind: 'EXTERNAL_AUTH', version: 1,
      config: { ...settings, bindings: [] } }), /DataSkill/)
    assert.equal((db.prepare('SELECT count(*) AS n FROM request_detail_log').get() as {n:number}).n, 0)
    assert.equal((db.prepare('SELECT count(*) AS n FROM request_auth_log').get() as {n:number}).n, 0)
    const logText = JSON.stringify(logs.list({}))
    assert.doesNotMatch(logText, /sensitive SQL|personal-A|server-only-token|99999/)
  } finally {
    apis.stopSchedules(); await sources.closeAll(); db.close()
    await Promise.all([new Promise<void>(r => identity.close(() => r())), new Promise<void>(r => studio.close(() => r()))])
    rmSync(directory, { recursive: true, force: true })
  }
})
