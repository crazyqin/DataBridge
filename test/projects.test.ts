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
  const dir = mkdtempSync(join(tmpdir(), 'databridge-projects-'))
  const config = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'synthetic-project-password', WEB_DIR: join(dir, 'none') })
  const db = openDb(config.dbFile), auth = new Auth(db, config), sources = new Sources(db, config), apis = new Apis(db, sources, config)
  const logs = new Logs(db), app = createApp({ config, db, auth, sources, apis, logs })
  return { config, db, auth, sources, apis, logs, app, async close() {
    apis.stopSchedules(); await sources.closeAll(); db.close(); rmSync(dir, { recursive: true, force: true })
  } }
}
const definition = { name: 'Shared API', code: 'shared', path: '/open/shared', mode: 'MANUAL', auth: 'PUBLIC', enabled: true,
  fields: [{ name: 'id', type: 'string' }], filters: ['id'] }
const asJson = (value: unknown) => value as JsonObject
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected

test('projects share APIs, preserve business data, copy membership and only remove grouping on deletion', async () => {
  const f = fixture()
  try {
    const a = f.apis.projects.save(undefined, { name: 'Contacts skill', description: 'Contact lookup' })
    const b = f.apis.projects.save(undefined, { name: 'Approval skill' })
    const api = f.apis.save(undefined, { ...definition, projectIds: [b.id, a.id, a.id] })
    f.apis.createRow(api.id, { id: 'kept-row' })
    assert.deepEqual(api.projectIds, [a.id, b.id])
    assert.equal(f.apis.projects.get(a.id).apiCount, 1)
    assert.equal(f.apis.projects.get(b.id).apiCount, 1)
    f.apis.projects.changeMembers(a.id, { apiIds: [api.id, api.id], operation: 'add' })
    assert.equal(f.apis.get(api.id).projectVersion, api.projectVersion)
    assert.equal((await f.app.request('/open/shared')).status, 200)
    const copy = f.apis.copy(api.id)
    assert.deepEqual(copy.projectIds, api.projectIds)
    assert.equal(copy.enabled, false)
    assert.equal(f.apis.rows(copy.id, 1, 10).total, 0)
    assert.equal(f.apis.projects.get(a.id).apiCount, 2)
    f.apis.projects.changeMembers(a.id, { apiIds: [api.id], operation: 'remove' })
    assert.deepEqual(f.apis.get(api.id).projectIds, [b.id])
    assert.equal(f.apis.projects.get(a.id).apiCount, 1)
    f.apis.projects.remove(b.id)
    const current = f.apis.get(api.id)
    assert.deepEqual(current.projectIds, [])
    assert.equal(current.version, api.version)
    assert.equal(current.enabled, true)
    assert.equal(current.path, api.path)
    assert.deepEqual(f.apis.rows(api.id, 1, 10).items[0].data, { id: 'kept-row' })
    assert.equal(f.logs.list({}).items.length, 1)
    assert.equal((await f.app.request('/open/shared')).status, 200)
    f.apis.remove(copy.id)
    assert.equal(f.apis.projects.get(a.id).apiCount, 0)
    const next = f.apis.projects.save(undefined, { name: 'New project' })
    assert.notEqual(next.id, b.id, 'deleted project IDs must not be reused by stale editors')
  } finally { await f.close() }
})

test('invalid and stale saves roll back API and membership changes, and older clients preserve grouping', async () => {
  const f = fixture()
  try {
    const project = f.apis.projects.save(undefined, { name: 'Skill' })
    const api = f.apis.save(undefined, definition)
    assert.throws(() => f.apis.save(undefined, { ...definition, code: 'bad', path: '/open/bad', projectIds: [9999] }), status(404))
    assert.equal(f.apis.list().length, 1)
    f.apis.projects.changeMembers(project.id, { apiIds: [api.id], operation: 'add' })
    assert.throws(() => f.apis.save(api.id, asJson({ ...api, name: 'Stale edit' })), status(409))
    assert.equal(f.apis.get(api.id).name, api.name)
    const saved = f.apis.save(api.id, { ...definition, name: 'Legacy client edit', version: api.version })
    assert.deepEqual(saved.projectIds, [project.id])
    assert.throws(() => f.apis.save(api.id, asJson({ ...saved, projectIds: [9999] })), status(404))
    assert.deepEqual(f.apis.get(api.id), saved)
    const cleared = f.apis.save(api.id, asJson({ ...saved, projectIds: [] }))
    assert.deepEqual(cleared.projectIds, [])
    assert.equal(f.apis.projects.get(project.id).apiCount, 0)
    assert.throws(() => f.apis.save(api.id, asJson({ ...cleared, projectIds: null })), status(400))
    assert.throws(() => f.apis.projects.changeMembers(project.id, { apiIds: [api.id, 9999], operation: 'add' }), status(404))
    assert.deepEqual(f.apis.get(api.id).projectIds, [])
    assert.throws(() => f.apis.projects.changeMembers(project.id, { apiIds: [api.id], operation: 'replace' }), status(400))
    for (const apiIds of [[], [0], ['1'], [1.5], Array(501).fill(api.id)]) {
      assert.throws(() => f.apis.projects.changeMembers(project.id, { apiIds, operation: 'add' }), status(400))
    }
    assert.throws(() => f.apis.save(api.id, asJson({ ...cleared, projectIds: Array(101).fill(project.id) })), status(400))
  } finally { await f.close() }
})

test('project names, descriptions and metadata edits are validated with optimistic concurrency', async () => {
  const f = fixture()
  try {
    for (const name of ['', '  ', 'x'.repeat(101), 'bad\nname']) assert.throws(() => f.apis.projects.save(undefined, { name }), status(400))
    assert.throws(() => f.apis.projects.save(undefined, { name: 'Too long', description: 'x'.repeat(1001) }), status(400))
    const a = f.apis.projects.save(undefined, { name: ' Skill ', description: ' Description ' })
    assert.equal(a.name, 'Skill'); assert.equal(a.description, 'Description')
    assert.throws(() => f.apis.projects.save(undefined, { name: 'skill' }), status(409))
    const b = f.apis.projects.save(a.id, { name: 'Updated', description: '', version: a.version })
    assert.equal(b.name, 'Updated'); assert.equal(b.description, '')
    assert.throws(() => f.apis.projects.save(a.id, { name: 'Stale', version: a.version }), status(409))
    assert.throws(() => f.apis.projects.remove(9999), status(404))
  } finally { await f.close() }
})

test('grouping leaves snapshot job versions and next execution unchanged', async () => {
  const f = fixture()
  try {
    const source = f.sources.save(undefined, { name: 'unused', host: 'localhost', database: 'unused', username: 'unused', password: 'unused' })
    const api = f.apis.save(undefined, { name: 'daily', code: 'daily', path: '/open/daily', mode: 'SNAPSHOT', datasourceId: source.id,
      sql: 'SELECT 1 AS id', keyFields: ['id'], cron: '0 0 12 * * *', cronTimezone: 'UTC', enabled: true })
    const project = f.apis.projects.save(undefined, { name: 'Scheduled skill' })
    f.apis.projects.changeMembers(project.id, { apiIds: [api.id], operation: 'add' })
    const changed = f.apis.get(api.id)
    assert.equal(changed.version, api.version)
    assert.equal(changed.nextSyncAt, api.nextSyncAt)
    assert.equal(changed.enabled, true)
    assert.ok(changed.projectVersion > api.projectVersion)
    f.apis.projects.remove(project.id)
    assert.equal(f.apis.get(api.id).version, api.version)
    assert.equal(f.apis.get(api.id).nextSyncAt, api.nextSyncAt)
  } finally { await f.close() }
})

test('project endpoints require admin and CSRF, expose counts and apply membership changes atomically', async () => {
  const f = fixture()
  try {
    const api = f.apis.save(undefined, definition)
    assert.equal((await f.app.request('/admin/projects')).status, 401)
    assert.equal((await f.app.request('/admin/projects', { method: 'POST', body: '{"name":"Denied"}' })).status, 401)
    await f.auth.bootstrap()
    const token = await f.auth.login('admin', 'synthetic-project-password', 'test')
    const cookie = `databridge_session=${token}`
    assert.equal((await f.app.request('/admin/projects', { method: 'POST', headers: { cookie }, body: '{"name":"Denied"}' })).status, 403)
    const headers = { cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'DataBridge' }
    const created = await f.app.request('/admin/projects', { method: 'POST', headers, body: '{"name":"Endpoint skill"}' })
    assert.equal(created.status, 201)
    const project = await created.json()
    assert.equal((await f.app.request(`/admin/projects/${project.id}/apis`, { method: 'PATCH', headers, body: JSON.stringify({ apiIds: [api.id], operation: 'add' }) })).status, 200)
    const response = await f.app.request('/admin/projects', { headers })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json())[0].apiCount, 1)
    const listed = await (await f.app.request('/admin/apis', { headers })).json()
    assert.deepEqual(listed[0].projectIds, [project.id])
    assert.equal((await f.app.request(`/admin/projects/${project.id}`, { method: 'DELETE', headers })).status, 204)
    assert.equal((await f.app.request('/open/shared')).status, 200)
    assert.deepEqual(f.apis.get(api.id).projectIds, [])
  } finally { await f.close() }
})

test('v1.2.8 databases upgrade with ungrouped APIs and retain rows and open routes', async () => {
  const f = fixture()
  try {
    const original = f.apis.save(undefined, definition)
    f.apis.createRow(original.id, { id: 'legacy-row' })
    f.db.exec('DROP TABLE api_project; DROP TABLE project; ALTER TABLE api DROP COLUMN project_version; PRAGMA user_version = 8;')
    const upgraded = openDb(f.config.dbFile)
    try {
      const apis = new Apis(upgraded, f.sources, f.config)
      const api = apis.get(original.id)
      assert.deepEqual(api.projectIds, [])
      assert.equal(api.projectVersion, 1)
      assert.equal(api.version, original.version)
      assert.equal(apis.findOpen(api.path, api.method)!.id, api.id)
      assert.deepEqual(apis.rows(api.id, 1, 10).items[0].data, { id: 'legacy-row' })
      assert.deepEqual(apis.projects.list(), [])
    } finally { upgraded.close() }
  } finally { await f.close() }
})
