import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sm2 } from 'sm-crypto-v2'
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db.ts'
import { Sources } from '../server/sources.ts'
import { Apis } from '../server/apis.ts'
import { Auth } from '../server/auth.ts'
import { Logs } from '../server/logs.ts'
import { createApp } from '../server/app.ts'
import { matchesRule, validatePolicy, type StaffMember, type AccessRule, type AccessPolicy } from '../server/access.ts'
import { normalizeStaff } from '../server/directory.ts'
import type { JsonObject } from '../server/json.ts'

const rule = (values: Partial<AccessRule> = {}): AccessRule => ({ staffNos: [], departments: [], posts: [], employmentUnified: [], employmentLocal: [], ...values })
const policy = (allow: AccessRule[] = [], deny: AccessRule[] = []) => ({ enabled: true, staffBinding: '_auth_staff', allow, deny }) as AccessPolicy & JsonObject
const people: StaffMember[] = [
  { staffNo: '0001', name: '测试甲', department: ['甲公司', '运营部', null, '服务组'], employmentUnified: '合同制', employmentLocal: '主业', posts: ['营业员', '支局长兼片长'] },
  { staffNo: '0002', name: '测试乙', department: ['乙公司', '运营部', null, null], employmentUnified: '外包制', employmentLocal: '外包', posts: ['营业员'] },
]
const mapping = { staffNo: 'code', name: 'name', departments: ['d1', 'd2', 'd3', 'd4'], employmentUnified: 'e1', employmentLocal: 'e2', posts: ['p1', 'p2'] }
const settings = (datasourceId: number, sql = 'SELECT 1') => ({ datasourceId, sql, mapping, scheduled: false, cron: '0 0 2 * * *', timezone: 'Asia/Shanghai', changeThreshold: 20 })
const verifier = { url: 'https://identity.example.invalid/verify', inputHeader: 'Authorization', successPath: 'active', successValue: true,
  bindings: [{ name: '_auth_staff', path: 'staff', type: 'string' }] }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'databridge-access-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'synthetic-admin-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile), sources = new Sources(db, config), auth = new Auth(db, config), apis = new Apis(db, sources, config), logs = new Logs(db)
  const url = new URL(process.env.TEST_PG_URL ?? 'postgres://postgres:synthetic-test-password@127.0.0.1:15439/postgres')
  const source = sources.save(undefined, { name: 'synthetic', host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) })
  const app = createApp({ config, db, auth, sources, apis, logs })
  const seed = () => {
    apis.directory.save({ ...settings(source.id), version: 0 })
    for (const person of people) db.prepare('INSERT INTO staff_member VALUES (?, ?)').run(person.staffNo, JSON.stringify(person))
    db.prepare("UPDATE staff_directory SET snapshot_version = 1, synced_at = '2000-01-01T00:00:00Z'").run()
  }
  return { config, db, sources, auth, apis, logs, app, source, seed,
    async close() { apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('directory normalization retains hierarchy gaps and leading zeros; merges exact job names', () => {
  const rows = [{ code: '0001', name: '测试甲', d1: '甲公司', d2: '运营部', d3: null, d4: '服务组', e1: '合同制', e2: '主业', p1: '支局长兼片长', p2: '支局长兼片长' }]
  const [person] = normalizeStaff(rows, mapping)
  assert.equal(person.staffNo, '0001'); assert.deepEqual(person.department, people[0].department)
  assert.deepEqual(person.posts, ['支局长兼片长'])
  assert.throws(() => normalizeStaff([...rows, ...rows], mapping), /重复/)
  assert.throws(() => normalizeStaff([{ ...rows[0], code: 1 }], mapping), /文本/)
  assert.throws(() => normalizeStaff([{ ...rows[0], code: ' ' }], mapping), /不能为空/)
  assert.throws(() => normalizeStaff([{ ...rows[0], d2: undefined } as unknown as JsonObject], mapping), /文本/)
  assert.throws(() => validatePolicy({ enabled: true, allow: [{}] }), /至少填写/)
})

test('rules use AND within groups and exact full department paths, job sets and separate employment attributes', () => {
  assert.ok(matchesRule(people[0], rule({ departments: [{ path: ['甲公司', '运营部'], descendants: true }], posts: ['无匹配', '支局长兼片长'], employmentUnified: ['合同制'] })))
  assert.equal(matchesRule(people[1], rule({ departments: [{ path: ['甲公司', '运营部'], descendants: true }] })), false)
  assert.equal(matchesRule(people[0], rule({ departments: [{ path: ['甲公司', '运营部'], descendants: false }] })), false)
  assert.ok(matchesRule(people[1], rule({ departments: [{ path: ['乙公司', '运营部'], descendants: false }] })))
  assert.equal(matchesRule(people[0], rule({ posts: ['支局长'] })), false)
  assert.equal(matchesRule(people[0], rule({ employmentLocal: ['合同制'] })), false)
  assert.equal(matchesRule(people[0], rule({ staffNos: ['0001'], posts: ['装维'] })), false)
})

test('open queries and streams stop before business execution; previews, logs, copies and binding protections agree', async t => {
  const f = fixture(); f.seed()
  let staff = '0001', valid = true, authCalls = 0, forwardCalls = 0, queries = 0
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).startsWith(verifier.url)) { authCalls++; return Response.json({ active: valid, staff }) }
    forwardCalls++; return Response.json({ answer: 'synthetic answer' })
  })
  t.mock.method(f.apis, 'query', async () => { queries++; return [{ ok: true }] })
  t.mock.method(f.apis, 'queryPage', async () => { queries++; return { rows: [], total: 0 } })
  const connection = f.apis.connections.save(undefined, { name: 'identity', kind: 'EXTERNAL_AUTH', config: verifier })
  const base = { name: 'controlled', code: 'controlled', path: '/open/controlled', mode: 'REALTIME', auth: 'EXTERNAL', authConnectionId: connection.id,
    datasourceId: f.source.id, sql: 'SELECT 1 AS n', enabled: true, accessPolicy: policy([rule({ staffNos: ['0001'] })]) }
  const api = f.apis.save(undefined, base)
  const call = (path = api.path) => f.app.request(path, { headers: { Authorization: 'synthetic-token' } })
  try {
    assert.equal((await call()).status, 200); assert.equal(queries, 1); assert.equal(authCalls, 1)
    staff = '0002'
    assert.equal((await call()).status, 403)
    assert.equal((await call(api.path + '?page=1&pageSize=2')).status, 403)
    assert.equal((await call(api.path + '?_auth_staff=0001')).status, 403)
    assert.equal(queries, 1)
    const denied = f.logs.list({}).items[0]
    const detail = f.logs.detail(denied.id)
    assert.equal(detail.request!.errorStage, 'authorization')
    assert.equal(detail.request!.authorization!.staffNo, '0002')
    assert.equal(detail.request!.authorization!.policyVersion, api.version)
    staff = 'unknown'; assert.equal((await call()).status, 403)
    staff = ''; assert.equal((await call()).status, 502)
    valid = false; assert.equal((await call()).status, 401)
    valid = true; staff = '0001'
    const deniedPolicy = policy([rule({ staffNos: ['0001'] })], [rule({ posts: ['营业员'] })])
    assert.equal(f.apis.directory.decide(deniedPolicy, staff).allowed, false)
    assert.equal(f.apis.directory.decide(policy(), staff).allowed, false)
    assert.equal(f.apis.directory.decide(policy([rule({ staffNos: ['absent'] })]), 'absent').allowed, false)
    const copy = f.apis.copy(api.id)
    assert.deepEqual(copy.accessPolicy, api.accessPolicy); assert.equal(copy.enabled, false)
    assert.throws(() => f.apis.connections.save(connection.id, { name: 'identity', kind: 'EXTERNAL_AUTH', version: connection.version, config: { ...verifier, bindings: [] } }), /正被 API 使用/)
    const { accessPolicy: _policy, ...uncontrolled } = base
    assert.throws(() => f.apis.save(undefined, uncontrolled), /工号映射/)
    assert.throws(() => f.sources.remove(f.source.id), /人员目录/)

    await f.auth.bootstrap()
    const session = await f.auth.login('admin', 'synthetic-admin-password', 'test')
    const headers = { Cookie: `databridge_session=${session}`, 'X-Requested-With': 'DataBridge', 'X-DataBridge-Test-Credential': 'synthetic-token', 'Content-Type': 'application/json' }
    const preview = await f.app.request('/admin/access/preview', { method: 'POST', headers, body: JSON.stringify({ policy: deniedPolicy, staffNo: staff }) })
    assert.equal((await preview.json()).allowed, false)
    assert.equal((await f.app.request('/admin/directory')).status, 401)
    const deniedTest = await f.app.request('/admin/apis/test', { method: 'POST', headers, body: JSON.stringify({ api: { ...base, accessPolicy: deniedPolicy }, params: {} }) })
    assert.equal(deniedTest.status, 403); assert.equal((await deniedTest.json()).authorization.reason, '命中拒绝规则')
    assert.equal(queries, 1)

    const key = sm2.generateKeyPairHex()
    for (const responseMode of ['blocking', 'streaming']) {
      const star = f.apis.save(undefined, { ...base, name: responseMode, code: responseMode, path: '/open/' + responseMode, mode: 'XINGCHEN', method: 'POST', accessPolicy: deniedPolicy,
        xingchen: { baseUrl: 'https://agent.example.invalid/v1', appId: 'synthetic', apiKey: 'synthetic', publicKey: key.publicKey,
          staffCodeBinding: '_auth_staff', queryParam: 'q', conversationParam: 'conversation_id', responseMode, inputMappings: [] },
        params: [{ name: 'q', type: 'string', required: true }, { name: 'conversation_id', type: 'string' }] })
      assert.equal((await f.app.request(star.path, { method: 'POST', headers: { Authorization: 'synthetic-token' }, body: '{"q":"hello"}' })).status, 403)
    }
    assert.equal(forwardCalls, 0)
    for (const mode of ['MANUAL', 'SNAPSHOT']) {
      const local = f.apis.save(undefined, { ...base, code: mode, path: '/open/' + mode, mode, fields: [{ name: 'n', type: 'integer' }],
        keyFields: ['n'], cron: '0 0 2 * * *', accessPolicy: deniedPolicy })
      assert.equal((await call(local.path)).status, 403)
    }
    assert.equal(queries, 1)
    const changed = f.apis.save(api.id, { ...api, accessPolicy: deniedPolicy } as unknown as JsonObject)
    assert.equal((await call()).status, 403)
    const updated = f.apis.save(api.id, { ...changed, accessPolicy: policy([rule({ staffNos: ['0001'] })]) } as unknown as JsonObject)
    assert.equal((await call()).status, 200)
    assert.ok(updated.version > api.version)
  } finally { await f.close() }
})

test('Studio action policies share authorization and do not log task bodies', async t => {
  const f = fixture(); f.seed()
  let forwarded = 0
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).startsWith(verifier.url)) return Response.json({ active: true, staff: '0001' })
    forwarded++; return Response.json({ ok: true })
  })
  try {
    const identity = f.apis.connections.save(undefined, { name: 'identity', kind: 'EXTERNAL_AUTH', config: verifier })
    f.apis.connections.save(undefined, { name: 'Studio', kind: 'DATASKILL', config: { baseUrl: 'https://studio.example.invalid', serviceToken: 'synthetic-service-token-long-enough', authConnectionId: identity.id,
      staffCodeBinding: '_auth_staff', identityProvider: 'test', enabled: true, accessPolicies: { feedback: policy([rule({ staffNos: ['0001'] })]) } } })
    const paths = [ ['POST', 'feedback'], ['POST', 'skill-check'], ['GET', 'feedback/12345678-1234-1234-1234-123456789abc'], ['POST', 'feedback/12345678-1234-1234-1234-123456789abc/withdraw'], ['GET', 'skill-download/12345678-1234-1234-1234-123456789abc'] ]
    for (const [method, path] of paths) {
      const res = await f.app.request('/open/dataskill/' + path, { method, headers: { Authorization: 'synthetic-token' }, ...(method === 'POST' ? { body: '{"task":"synthetic-private-task"}' } : {}) })
      assert.equal(res.status, path === 'feedback' ? 200 : 403)
    }
    assert.equal(forwarded, 1)
    const details = JSON.stringify(f.db.prepare('SELECT detail FROM request_detail_log').all())
    assert.match(details, /authorization/); assert.doesNotMatch(details, /synthetic-private-task|synthetic-token/)
  } finally { await f.close() }
})

test('v1.6.1 upgrade preserves existing external access and requires an initial directory for new controlled APIs', async () => {
  const f = fixture()
  try {
    const identity = f.apis.connections.save(undefined, { name: 'identity', kind: 'EXTERNAL_AUTH', config: verifier })
    const base = { name: 'legacy', code: 'legacy', path: '/open/legacy', mode: 'MANUAL', auth: 'EXTERNAL', authConnectionId: identity.id,
      enabled: true, fields: [{ name: 'n', type: 'integer' }], accessPolicy: { enabled: false } }
    const api = f.apis.save(undefined, base)
    assert.throws(() => f.apis.save(undefined, { ...base, code: 'new', path: '/open/new', accessPolicy: policy() }), /先成功同步/)
    f.db.exec('ALTER TABLE api DROP COLUMN access_policy; DROP TABLE staff_directory; DROP TABLE staff_member; DROP TABLE directory_sync; PRAGMA user_version = 10;')
    const reopened = openDb(f.config.dbFile)
    try {
      const apis = new Apis(reopened, f.sources, f.config)
      assert.equal(apis.get(api.id).accessPolicy.enabled, false)
      assert.equal(apis.get(api.id).enabled, true)
      assert.equal(apis.get(api.id).authConnectionId, identity.id)
      assert.equal(apis.directory.get().snapshotVersion, 0)
    } finally { reopened.close() }
  } finally { await f.close() }
})

test('full sync, difference quarantine, force, failed queries, config races and restarts preserve a coherent directory',
  { skip: !process.env.TEST_PG_URL }, async t => {
    const f = fixture()
    const sql = (from = 1, count = 10) => `SELECT lpad(n::text, 4, '0') AS code, 'Person ' || n AS name, 'Company'::text AS d1, 'Team'::text AS d2, NULL::text AS d3, 'Group'::text AS d4, 'Contract'::text AS e1, 'Local'::text AS e2, 'Job'::text AS p1, 'Job'::text AS p2 FROM generate_series(${from}, ${from + count - 1}) n`
    const save = (query: string, extra: JsonObject = {}) => f.apis.directory.save({ ...settings(f.source.id, query), version: f.apis.directory.get().version, ...extra })
    try {
      save(sql()); assert.equal((await f.apis.directory.sync()).status, 'SUCCESS')
      assert.equal(f.apis.directory.get().count, 10); assert.equal(f.apis.directory.get().snapshotVersion, 1)
      assert.deepEqual(f.apis.directory.members('0001').items[0].posts, ['Job'])
      assert.throws(() => f.apis.directory.save({ ...settings(f.source.id, sql()), version: 0 }), /已修改/)
      save(sql(1, 9)); assert.equal((await f.apis.directory.sync()).status, 'SUCCESS')
      assert.equal(f.apis.directory.get().count, 9)
      save(sql(101, 9)); const pending = await f.apis.directory.sync()
      assert.equal(pending.status, 'PENDING'); assert.equal(f.apis.directory.get().count, 9)
      assert.equal(f.apis.directory.candidate(pending.id).total, 18)
      f.apis.directory.force(pending.id); assert.equal(f.apis.directory.members('0101').total, 1)
      assert.throws(() => f.apis.directory.force(pending.id), /候选/)
      save(sql(1, 0)); const empty = await f.apis.directory.sync()
      assert.equal(empty.status, 'PENDING'); assert.equal(f.apis.directory.get().count, 9)
      save(sql(1, 100)); assert.throws(() => f.apis.directory.force(empty.id), /候选/)
      save(sql(1, 100), { maxRows: 10 }); await assert.rejects(f.apis.directory.sync(), /最大行数/)
      assert.equal(f.apis.directory.get().count, 9)
      save('SELECT missing_column'); await assert.rejects(f.apis.directory.sync(), /查询失败/)
      assert.equal(f.apis.directory.get().count, 9)
      save('SELECT 1 AS wrong_column WHERE false'); await assert.rejects(f.apis.directory.sync(), /缺少映射列/)
      assert.equal(f.apis.directory.get().count, 9)
      save(`${sql()} UNION ALL ${sql()}`); await assert.rejects(f.apis.directory.sync(), /工号重复/)
      assert.equal(f.apis.directory.get().count, 9)
      save(`SELECT * FROM (${sql()}) data CROSS JOIN (SELECT pg_sleep(0.2)) pause`)
      const race = f.apis.directory.sync(); await assert.rejects(f.apis.directory.sync(), /正在同步/)
      save(sql()); await assert.rejects(race, /已变更/)
      assert.equal(f.apis.directory.get().count, 9)
      save(sql(101, 9)); await f.apis.directory.sync()
      const reopened = openDb(f.config.dbFile)
      try {
        const apis = new Apis(reopened, f.sources, f.config)
        apis.directory.start(); assert.equal(apis.directory.get().count, 9); apis.stopSchedules()
      } finally { reopened.close() }
      const preview = await f.apis.directory.preview(settings(f.source.id, sql(1, 30)))
      assert.equal(preview.rows.length, 20); assert.equal(preview.truncated, true); assert.equal(f.apis.directory.get().count, 9)
      save(sql(101, 9).replace("'Job'::text AS p1", "'New role'::text AS p1"))
      assert.equal((await f.apis.directory.sync()).status, 'SUCCESS')
      assert.ok(f.apis.directory.members('0101').items[0].posts.includes('New role'))
      save(sql(1, 0)); const clear = await f.apis.directory.sync()
      f.apis.directory.force(clear.id)
      assert.equal(f.apis.directory.get().count, 0)
      assert.equal(f.apis.directory.decide(policy([rule({ staffNos: ['0101'] })]), '0101').allowed, false)
      assert.throws(() => f.apis.directory.validate({ ...settings(f.source.id, sql()), cron: 'invalid' }), /Cron/)
    } finally { await f.close() }
  })
