import { strict as assert } from 'node:assert'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decrypt, loadConfig } from '../server/config.ts'
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
  const config = loadConfig({ DATA_DIR: directory, ADMIN_PASSWORD: 'test-password' })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config)
  const apis = new Apis(db, sources, config), logs = new Logs(db)
  const settings = { url: authUrl, method: 'POST', inputHeader: 'Authorization', inputPrefix: 'Bearer ',
    tokenLocation: 'header', tokenName: 'Authorization', tokenPrefix: 'Bearer ', headers: {}, dynamicHeaders: {}, body: {},
    successStatus: 200, successPath: 'active', successValue: true, successConditions: [],
    bindings: [{ name: '_auth_staff_code', path: 'data.staffCode', type: 'string' }], timeoutSeconds: 5 }
  const connection = apis.connections.save(undefined, { name: 'uap', kind: 'EXTERNAL_AUTH', config: settings })
  assert.equal(connection.id, 1)
  const app = createApp({ config, db, auth, sources, apis, logs })
  assert.equal((await app.request('/open/dataskill/feedback', {method:'POST',body:'{}'})).status, 503)
  const studioSettings = { baseUrl: studioUrl, serviceToken: 'server-only-token-32-characters-long',
    authConnectionId: connection.id, staffCodeBinding: '_auth_staff_code', identityProvider: 'uap', enabled: false }
  let integration = apis.connections.save(undefined, {name:'Studio', kind:'DATASKILL', config: studioSettings})
  assert.equal((await app.request('/open/dataskill/feedback', {method:'POST',body:'{}'})).status, 503)
  integration = apis.connections.save(integration.id, {name:'Studio',kind:'DATASKILL',version:integration.version,config:{...studioSettings,enabled:true}})
  const stored = db.prepare('SELECT config FROM connection WHERE id = ?').get(integration.id)!.config as string
  assert.doesNotMatch(stored, /server-only-token|127\.0\.0\.1/)
  assert.match(decrypt(config.secretKey,stored), /server-only-token/)
  assert.equal(apis.connections.get(connection.id).usedByConnections[0].id,integration.id)

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
    integration = apis.connections.save(integration.id, {name:'Studio',kind:'DATASKILL',version:integration.version,
      config:{...studioSettings,enabled:true,baseUrl:studioUrl+'/changed',serviceToken:'rotated-service-token-32-characters-long'}})
    assert.equal((await call({task:'updated'})).status, 202)
    assert.match(calls.at(-1)!.path,/^\/changed\/api\//)
    assert.equal(calls.at(-1)!.authorization,'Bearer rotated-service-token-32-characters-long')
    assert.throws(() => apis.connections.save(undefined,{name:'Second Studio',kind:'DATASKILL',config:{...studioSettings,enabled:true}}), /已有启用/)
    assert.throws(() => apis.connections.remove(integration.id), /停用/)
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
    assert.doesNotMatch(logText, /sensitive SQL|personal-A|server-only-token|rotated-service-token|99999/)
    integration = apis.connections.save(integration.id, {name:'Studio',kind:'DATASKILL',version:integration.version,config:studioSettings})
    assert.equal((await call({task:'disabled'})).status,503)
    apis.connections.remove(integration.id)
    apis.connections.remove(connection.id)
    assert.equal(apis.connections.list().length,0)
  } finally {
    apis.stopSchedules(); await sources.closeAll(); db.close()
    await Promise.all([new Promise<void>(r => identity.close(() => r())), new Promise<void>(r => studio.close(() => r()))])
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Studio connection management masks credentials, preserves them on edit, and survives reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'databridge-studio-management-'))
  const config = loadConfig({DATA_DIR:directory,ADMIN_PASSWORD:'synthetic-admin-password'})
  const db = openDb(config.dbFile), auth = new Auth(db,config), sources = new Sources(db,config)
  const apis = new Apis(db,sources,config), app = createApp({config,db,auth,sources,apis,logs:new Logs(db)})
  try {
    assert.equal('dataskill' in config,false)
    assert.equal(apis.connections.list().length,0)
    const identity = apis.connections.save(undefined,{name:'UAP',kind:'EXTERNAL_AUTH',config:{
      url:'http://127.0.0.1/verify',method:'POST',inputHeader:'Authorization',inputPrefix:'Bearer ',tokenLocation:'header',tokenName:'Authorization',tokenPrefix:'Bearer ',
      successPath:'active',successValue:true,bindings:[{name:'_auth_staff',path:'staff',type:'string'}]}})
    const definition = {name:'Team Studio',kind:'DATASKILL',config:{baseUrl:'https://studio.example.invalid',serviceToken:'synthetic-service-token-long-enough',
      authConnectionId:identity.id,staffCodeBinding:'_auth_staff',identityProvider:'uap',enabled:true}}
    assert.equal((await app.request('/admin/connections',{method:'POST',body:JSON.stringify(definition)})).status,401)
    await auth.bootstrap()
    const token = await auth.login('admin','synthetic-admin-password','test')
    const headers = {Cookie:`databridge_session=${token}`,'Content-Type':'application/json','X-Requested-With':'DataBridge'}
    const created = await app.request('/admin/connections',{method:'POST',headers,body:JSON.stringify(definition)})
    assert.equal(created.status,201)
    let row = await created.json()
    assert.equal(row.hasServiceToken,true)
    assert.match(row.serviceTokenSha256,/^[0-9a-f]{64}$/)
    assert.equal(row.config.serviceToken,'')
    assert.ok(!JSON.stringify(row).includes(definition.config.serviceToken))
    const list = await app.request('/admin/connections',{headers})
    assert.doesNotMatch(await list.text(),/synthetic-service-token|studio\.example\.invalid/)
    const detail = await app.request(`/admin/connections/${row.id}`,{headers})
    assert.doesNotMatch(await detail.text(),/synthetic-service-token/)
    const edited = await app.request(`/admin/connections/${row.id}`,{method:'PUT',headers,body:JSON.stringify({...row,name:'Renamed Studio'})})
    assert.equal(edited.status,200)
    assert.equal(apis.connections.dataSkill()!.serviceToken,definition.config.serviceToken)
    const stale = await app.request(`/admin/connections/${row.id}`,{method:'PUT',headers,body:JSON.stringify(row)})
    assert.equal(stale.status,409)
    row = await edited.json()
    assert.equal((await app.request(`/admin/connections/${identity.id}`,{method:'DELETE',headers})).status,409)
    assert.equal((await app.request(`/admin/connections/${row.id}`,{method:'DELETE',headers})).status,409)
    const { Connections } = await import('../server/connections.ts')
    const reopened = openDb(config.dbFile)
    try { assert.deepEqual(new Connections(reopened,config).dataSkill(),apis.connections.dataSkill()) }
    finally { reopened.close() }
    const switched = await app.request(`/admin/connections/${row.id}`,{method:'PUT',headers,
      body:JSON.stringify({...row,config:{...row.config,enabled:false,serviceToken:'replacement-service-token-long-enough'}})})
    assert.equal(switched.status,200)
    const next = await switched.json()
    assert.notEqual(next.serviceTokenSha256,row.serviceTokenSha256)
    assert.equal(apis.connections.dataSkill(),undefined)
    assert.equal((await app.request(`/admin/connections/${row.id}`,{method:'DELETE',headers})).status,204)
    assert.equal((await app.request(`/admin/connections/${identity.id}`,{method:'DELETE',headers})).status,204)
  } finally { apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(directory,{recursive:true,force:true}) }
})

test('Studio connections reject missing or unsuitable UAP fields and invalid service settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'databridge-studio-validation-'))
  const config = loadConfig({DATA_DIR:directory}), db = openDb(config.dbFile), sources = new Sources(db,config), apis = new Apis(db,sources,config)
  try {
    const auth = apis.connections.save(undefined,{name:'UAP',kind:'EXTERNAL_AUTH',config:{url:'http://127.0.0.1/identity',
      method:'POST',inputHeader:'Authorization',tokenLocation:'header',tokenName:'Authorization',successPath:'active',successValue:true,
      bindings:[{name:'_auth_staff',path:'staff',type:'integer'}]}})
    const value={baseUrl:'https://studio.example.invalid',serviceToken:'synthetic-service-token-long-enough',authConnectionId:auth.id,staffCodeBinding:'_auth_staff',identityProvider:'uap',enabled:true}
    const save = (changes:JsonObject={}) => apis.connections.save(undefined,{name:'Studio',kind:'DATASKILL',config:{...value,...changes}})
    assert.throws(()=>save(),/string/)
    assert.throws(()=>save({serviceToken:''}),/凭据/)
    assert.throws(()=>save({baseUrl:'https://user:password@host'}),/根地址/)
    assert.throws(()=>save({baseUrl:'file:///tmp/studio'}),/根地址/)
    assert.throws(()=>save({baseUrl:'https://host?token=abc'}),/根地址/)
    assert.throws(()=>save({authConnectionId:123456}),/不存在/)
    assert.throws(()=>save({enabled:'true'}),/布尔/)
    assert.equal(apis.connections.list().length,1)
  } finally { apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(directory,{recursive:true,force:true}) }
})
