import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { Connections } from './connections.ts'
import { Projects } from './projects.ts'
import { Directory } from './directory.ts'
import { validatePolicy, type AccessPolicy } from './access.ts'
import { decrypt, encrypt, type Config } from './config.ts'
import { now, transaction, type Db } from './db.ts'
import { bad, conflict, forbidden, HttpError, notFound } from './errors.ts'
import { AUTH_PARAM_PREFIX, validateExternalAuth, type ExternalAuthConfig, type QueryIdentity } from './external-auth.ts'
import { choice, flag, integer, list, NAME, names, text } from './input.ts'
import { isObject, parse, stringify, type Json, type JsonObject } from './json.ts'
import { runQuery, runStatements, SourceError } from './query.ts'
import type { Sources } from './sources.ts'
import { parseSql, positional } from './sql.ts'
import { filterSignature, NULL_KEY, REMARK_FIELD, type RowFilter } from './row-data.ts'
import { compare, filterKeys, pause, RowStore, sortedOrder, type IndexedApi } from './row-store.ts'
import type { OpenResult } from './row-worker.ts'
import { convertOptional, FIELD_TYPES, identity, rowKey, type Field, type FieldType } from './values.ts'
import { validateXingchen, type XingchenConfig } from './xingchen.ts'

export const MODES = ['REALTIME', 'SNAPSHOT', 'MANUAL', 'XINGCHEN'] as const
export type Mode = (typeof MODES)[number]

export interface Api {
  accessPolicy: AccessPolicy
  id: number
  name: string
  code: string
  projectIds: number[]
  projectVersion: number
  path: string
  method: 'GET' | 'POST'
  auth: 'API_KEY' | 'PUBLIC' | 'EXTERNAL'
  authConnectionId: number | null
  xingchenConnectionId: number | null
  authConnectionName: string | null
  xingchenConnectionName: string | null
  externalAuth: ExternalAuthConfig | null
  xingchen: XingchenConfig | null
  userAgents: string[]
  mode: Mode
  datasourceId: number | null
  sql: string | null
  params: Field[]
  fields: Field[]
  filters: string[]
  keyFields: string[]
  cron: string | null
  cronTimezone: string | null
  allowEmpty: boolean
  timeoutSeconds: number
  maxRows: number
  enabled: boolean
  version: number
  syncAt: string | null
  syncStatus: string | null
  syncCount: number | null
  syncError: string | null
  nextSyncAt?: string | null
  createdAt: string
  updatedAt: string
}

export type Row = Record<string, Json>
export interface PageResult { rows: Row[]; total: number; page: number; pageSize: number }

/** The rows of an open call on stored data, as returned by the row worker. */
function storedRows(result: OpenResult): Row[] {
  return parse(`[${Buffer.concat(result.chunks).toString()}]`) as Row[]
}

interface ApiRow {
  access_policy: string
  project_version: number
  id: number; name: string; code: string; path: string; method: Api['method']; auth: Api['auth']; user_agents: string
  external_auth: string | null; xingchen: string | null; auth_connection_id: number | null; xingchen_connection_id: number | null
  mode: Mode; datasource_id: number | null; sql_text: string | null; params: string; fields: string; filters: string
  key_fields: string; cron: string | null; cron_timezone: string | null; allow_empty: number; timeout_seconds: number; max_rows: number; enabled: number
  version: number; sync_at: string | null; sync_status: string | null; sync_count: number | null; sync_error: string | null
  created_at: string; updated_at: string
}

const toApi = (row: ApiRow, config: Config, connections: Connections, projects: Projects): Api => {
  const auth = row.auth_connection_id ? connections.get(row.auth_connection_id, 'EXTERNAL_AUTH') : null
  const platform = row.xingchen_connection_id ? connections.get(row.xingchen_connection_id, 'XINGCHEN') : null
  const application = row.xingchen ? parse(decrypt(config.secretKey, row.xingchen)) as unknown as XingchenConfig : null
  return ({
  accessPolicy: JSON.parse(row.access_policy),
  id: row.id, name: row.name, code: row.code, path: row.path, method: row.method, auth: row.auth,
  projectIds: projects.idsForApi(row.id), projectVersion: row.project_version,
  authConnectionId: row.auth_connection_id, xingchenConnectionId: row.xingchen_connection_id,
  authConnectionName: auth?.name ?? null, xingchenConnectionName: platform?.name ?? null,
  externalAuth: auth ? auth.config as ExternalAuthConfig : null,
  xingchen: application ? { ...application, ...(platform?.config ?? {}) } : null,
  userAgents: JSON.parse(row.user_agents), mode: row.mode, datasourceId: row.datasource_id, sql: row.sql_text,
  params: JSON.parse(row.params), fields: JSON.parse(row.fields), filters: JSON.parse(row.filters),
  keyFields: JSON.parse(row.key_fields), cron: row.cron, cronTimezone: row.cron_timezone, allowEmpty: row.allow_empty === 1,
  timeoutSeconds: row.timeout_seconds, maxRows: row.max_rows, enabled: row.enabled === 1, version: row.version,
  syncAt: row.sync_at, syncStatus: row.sync_status, syncCount: row.sync_count, syncError: row.sync_error,
  createdAt: row.created_at, updatedAt: row.updated_at,
  })
}

const PG_TYPES: Record<FieldType, string> = {
  string: 'text', integer: 'int8', decimal: 'numeric', boolean: 'bool', date: 'date', datetime: 'timestamp',
}

const own = (object: JsonObject, key: string): Json | undefined => Object.hasOwn(object, key) ? object[key] : undefined

function schema(input: JsonObject, key: string, label: string): Field[] {
  const fields = list(input, key, label).map(item => {
    if (!isObject(item) || typeof item.name !== 'string' || !NAME.test(item.name)) throw bad(`${label}中的字段名无效`)
    if (!FIELD_TYPES.includes(item.type as FieldType)) throw bad(`${label}中 ${item.name} 的类型无效`)
    if (item.required !== undefined && typeof item.required !== 'boolean') throw bad(`${label}中 ${item.name} 的必填标记无效`)
    return { name: item.name, type: item.type as FieldType, required: item.required === true }
  })
  if (new Set(fields.map(field => field.name)).size !== fields.length) throw bad(`${label}包含重复的字段名`)
  if (fields.length > 200) throw bad(`${label}最多 200 个字段`)
  return fields
}

function userAgentRules(input: JsonObject): string[] {
  const rules = [...new Set(list(input, 'userAgents', 'User-Agent 规则').map(rule => {
    if (typeof rule !== 'string') throw bad('User-Agent 规则必须是字符串')
    return rule.trim()
  }).filter(Boolean))]
  const invalid = rules.find(rule => rule.length > 512 || rule === '*' || /[\x00-\x1f\x7f]/.test(rule) || rule.slice(0, -1).includes('*'))
  if (invalid !== undefined || rules.length > 20) throw bad('User-Agent 规则无效：最多 20 条，* 只能出现在末尾')
  return rules
}

export function userAgentAllowed(rules: string[], userAgent: string | undefined): boolean {
  if (!rules.length) return true
  if (!userAgent) return false
  return rules.some(rule => rule.endsWith('*') ? userAgent.startsWith(rule.slice(0, -1)) : userAgent === rule)
}

function toPg(value: Json): string | null {
  if (value === null) return null
  if (JSON.isRawJSON(value)) return value.rawJSON
  return String(value)
}

export class Apis {
  readonly directory: Directory
  readonly connections: Connections
  readonly projects: Projects
  private readonly jobs = new Map<number, Cron>()
  private readonly syncing = new Set<number>()
  /** Snapshot filter indexes being rebuilt after a filter change; a sync cancels the rebuild and writes its own. */
  private readonly rebuilding = new Map<number, { cancelled: boolean; done: Promise<void> }>()
  private readonly store: RowStore
  private readonly db: Db
  private readonly sources: Sources
  private readonly config: Config

  constructor(db: Db, sources: Sources, config: Config) {
    this.db = db
    this.sources = sources
    this.config = config
    this.connections = new Connections(db, config)
    this.projects = new Projects(db)
    this.directory = new Directory(db, sources, config)
    this.store = new RowStore(db, config.dbFile)
    this.connections.migrateLegacy()
  }

  // ---- configuration ----

  list(): Api[] {
    return (this.db.prepare('SELECT * FROM api ORDER BY id DESC').all() as unknown as ApiRow[]).map(row => this.withSchedule(toApi(row, this.config, this.connections, this.projects)))
  }

  get(id: number): Api {
    const row = this.db.prepare('SELECT * FROM api WHERE id = ?').get(id) as ApiRow | undefined
    if (!row) throw notFound('API 不存在')
    return this.withSchedule(toApi(row, this.config, this.connections, this.projects))
  }

  findOpen(path: string, method: string): Api | undefined {
    const row = this.db.prepare('SELECT * FROM api WHERE path = ? AND method = ? AND enabled = 1').get(path, method) as ApiRow | undefined
    return row && toApi(row, this.config, this.connections, this.projects)
  }

  private withSchedule(api: Api): Api {
    const next = this.jobs.get(api.id)?.nextRun()
    return api.mode === 'SNAPSHOT'
      ? { ...api, cronTimezone: api.cronTimezone || this.config.timezone, nextSyncAt: next ? next.toISOString() : null }
      : api
  }

  syncHistory(id: number, before?: number) {
    const api = this.get(id)
    if (api.mode !== 'SNAPSHOT') throw bad('只有定时同步模式的 API 有同步记录')
    const limit = 50
    const items = this.db.prepare(`SELECT id, started_at AS startedAt, finished_at AS finishedAt,
      trigger, status, row_count AS rowCount, error FROM sync_log WHERE api_id = ? AND id < ?
      ORDER BY id DESC LIMIT ?`).all(id, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as {
      id: number; startedAt: string; finishedAt: string | null; trigger: string; status: string; rowCount: number | null; error: string | null
    }[]
    return { items: items.slice(0, limit), nextBefore: items.length > limit ? items[limit - 1].id : null }
  }

  pruneSyncHistory(retentionDays: number) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    this.db.prepare("DELETE FROM sync_log WHERE started_at < ? AND status != 'RUNNING'").run(cutoff)
    // A pending candidate waits for an administrator's decision however old it is.
    this.db.prepare("DELETE FROM directory_sync WHERE started_at < ? AND status NOT IN ('RUNNING', 'PENDING')").run(cutoff)
  }

  /** Validates a submitted configuration; the result is what gets stored. */
  validate(input: JsonObject) {
    const mode = choice(input, 'mode', '数据模式', MODES)
    const sourced = mode === 'REALTIME' || mode === 'SNAPSHOT'
    const parameters = mode === 'REALTIME' || mode === 'XINGCHEN'
    const authConnectionId = input.auth === 'EXTERNAL' && input.authConnectionId != null
      ? integer(input, 'authConnectionId', '身份服务连接', 1, Number.MAX_SAFE_INTEGER) : null
    const xingchenConnectionId = mode === 'XINGCHEN' && input.xingchenConnectionId != null
      ? integer(input, 'xingchenConnectionId', '星辰平台连接', 1, Number.MAX_SAFE_INTEGER) : null
    const values = {
      name: text(input, 'name', '接口名称', { max: 100 }),
      code: text(input, 'code', '接口编码', { max: 100, pattern: /^[A-Za-z][A-Za-z0-9_]*$/ }),
      path: text(input, 'path', '接口路径', { max: 300, pattern: /^\/open(\/[A-Za-z0-9_-]+)+$/ }),
      method: choice(input, 'method', '请求方式', ['GET', 'POST'] as const, 'GET'),
      auth: choice(input, 'auth', '访问方式', ['API_KEY', 'PUBLIC', 'EXTERNAL'] as const, 'API_KEY'),
      authConnectionId, xingchenConnectionId,
      externalAuth: input.auth === 'EXTERNAL' ? authConnectionId ? this.connections.auth(authConnectionId) : validateExternalAuth(input.externalAuth) : null,
      userAgents: userAgentRules(input),
      mode,
      datasourceId: sourced ? integer(input, 'datasourceId', '数据源', 1, Number.MAX_SAFE_INTEGER) : null,
      sql: sourced ? text(input, 'sql', 'SQL', { max: 100_000 }) : null,
      params: parameters ? schema(input, 'params', '请求参数') : [],
      fields: parameters ? [] : schema(input, 'fields', '字段定义'),
      filters: parameters ? [] : names(input, 'filters', '过滤字段'),
      keyFields: mode === 'SNAPSHOT' ? names(input, 'keyFields', '唯一键') : [],
      cron: mode === 'SNAPSHOT' ? text(input, 'cron', '同步 Cron', { max: 100 }) : null,
      cronTimezone: mode === 'SNAPSHOT'
        ? text({ cronTimezone: input.cronTimezone ?? this.config.timezone }, 'cronTimezone', '同步时区', { max: 100 }) : null,
      allowEmpty: mode === 'SNAPSHOT' && flag(input, 'allowEmpty', '空结果覆盖', false),
      timeoutSeconds: sourced || mode === 'XINGCHEN' ? integer(input, 'timeoutSeconds', '请求超时', 1, 120, mode === 'XINGCHEN' ? 60 : 10) : 10,
      maxRows: integer(input, 'maxRows', '最大行数', 1, 1_000_000, 10_000),
      enabled: flag(input, 'enabled', '启用状态', false),
    }
    if (mode === 'XINGCHEN' && values.auth !== 'EXTERNAL') throw bad('星辰转发必须使用外部身份验证获取工号')
    const xingchenInput = xingchenConnectionId ? { ...(isObject(input.xingchen) ? input.xingchen : {}), ...this.connections.platform(xingchenConnectionId) } : input.xingchen
    const xingchen = mode === 'XINGCHEN' ? validateXingchen(xingchenInput, values.params, values.externalAuth) : null
    const authBindings = values.externalAuth?.bindings ?? []
    if (authBindings.length && !parameters && !authConnectionId && !(isObject(input.accessPolicy) && input.accessPolicy.enabled)) throw bad('身份参数映射只支持实时查询或星辰转发；其他模式可仅验证身份')
    if (values.auth === 'EXTERNAL' && values.params.some(param => param.name.startsWith(AUTH_PARAM_PREFIX))) {
      throw bad(`${AUTH_PARAM_PREFIX} 开头的参数由外部身份验证提供，不能声明为请求参数`)
    }
    if (values.datasourceId !== null) this.sources.get(values.datasourceId)
    if (values.sql !== null) {
      const { names: used } = parseSql(values.sql)
      const declared = [...values.params, ...(mode === 'REALTIME' ? authBindings : [])].map(param => param.name)
      const undeclared = used.find(name => !declared.includes(name))
      if (undeclared) throw bad(mode === 'SNAPSHOT' ? '定时同步的 SQL 不能包含参数' : `SQL 使用了未定义的参数 :${undeclared}`)
      const unused = (authConnectionId ? values.params.map(param => param.name) : declared).find(name => !used.includes(name) && !(isObject(input.accessPolicy) && input.accessPolicy.enabled && input.accessPolicy.staffBinding === name))
      if (unused) throw bad(`参数 ${unused} 没有在 SQL 中使用`)
    }
    if (mode === 'MANUAL' && !values.fields.length) throw bad('手工维护模式需要至少一个字段')
    if (mode === 'SNAPSHOT' && !values.keyFields.length) throw bad('定时同步模式需要唯一键')
    const unknownFilter = values.filters.find(name => !values.fields.some(field => field.name === name))
    if (unknownFilter) throw bad(`过滤字段 ${unknownFilter} 需要先在字段定义中声明类型`)
    if (values.cron !== null) {
      let next: Date | null
      try {
        new Intl.DateTimeFormat('en', { timeZone: values.cronTimezone! })
      } catch {
        throw bad('同步时区无效，请填写 IANA 时区，如 Asia/Shanghai')
      }
      try {
        next = new Cron(values.cron, { paused: true, timezone: values.cronTimezone! }).nextRun()
      } catch {
        throw bad('Cron 表达式无效')
      }
      if (!next) throw bad('Cron 表达式永远不会触发')
    }
    const accessPolicy = validatePolicy(input.accessPolicy)
    if (values.auth !== 'EXTERNAL' && accessPolicy.enabled) throw bad('人员授权仅适用于外部身份验证')
    if (accessPolicy.enabled) {
      if (!authBindings.some(binding => binding.name === accessPolicy.staffBinding && binding.type === 'string')) throw bad('人员授权必须选择 string 类型的工号映射')
      if (xingchen && xingchen.staffCodeBinding !== accessPolicy.staffBinding) throw bad('星辰转发与人员授权必须使用同一个工号映射')
      if (values.enabled && !this.directory.get().snapshotVersion) throw bad('请先成功同步人员目录，再启用人员授权接口')
    }
    return { ...values, xingchen, accessPolicy }
  }

  save(id: number | undefined, input: JsonObject): Api {
    const v = this.validate({ ...input, accessPolicy: input.accessPolicy ?? (id !== undefined
      ? this.get(id).accessPolicy as unknown as Json : { enabled: input.auth === 'EXTERNAL' }) })
    const time = now()
    let rows: 'cleared' | 'stale' | undefined
    const saved = transaction(this.db, () => {
      if (id !== undefined) {
        if (this.get(id).version !== integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER)) throw conflict('API 配置已被修改，请刷新后再保存')
      }
      const authId = v.externalAuth ? v.authConnectionId ?? this.connections.reuse('EXTERNAL_AUTH', v.externalAuth) : null
      const platformId = v.xingchen ? v.xingchenConnectionId ?? this.connections.reuse('XINGCHEN', { baseUrl: v.xingchen.baseUrl }) : null
      const application = v.xingchen ? (({ baseUrl: _baseUrl, ...app }) => app)(v.xingchen) : null
      const columns = [v.name, v.code, v.path, v.method, v.auth, stringify(v.userAgents), v.mode, v.datasourceId, v.sql,
        stringify(v.params), stringify(v.fields), stringify(v.filters), stringify(v.keyFields), v.cron, v.cronTimezone, v.allowEmpty ? 1 : 0,
        v.timeoutSeconds, v.maxRows, v.enabled ? 1 : 0, null,
        application ? encrypt(this.config.secretKey, stringify(application)) : null, authId, platformId]
      if (this.db.prepare('SELECT 1 FROM api WHERE code = ? AND id IS NOT ?').get(v.code, id ?? null)) throw conflict('接口编码已存在')
      if (this.db.prepare('SELECT 1 FROM api WHERE path = ? AND method = ? AND id IS NOT ?').get(v.path, v.method, id ?? null)) {
        throw conflict('相同路径和请求方式的接口已存在')
      }
      if (id === undefined) {
        const result = this.db.prepare(`INSERT INTO api (name, code, path, method, auth, user_agents, mode, datasource_id, sql_text,
          params, fields, filters, key_fields, cron, cron_timezone, allow_empty, timeout_seconds, max_rows, enabled, external_auth, xingchen, auth_connection_id, xingchen_connection_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...columns, time, time)
        const apiId = Number(result.lastInsertRowid)
        this.db.prepare('UPDATE api SET access_policy = ?, row_filters = ? WHERE id = ?')
          .run(JSON.stringify(v.accessPolicy), filterSignature(v.fields, v.filters), apiId)
        if (input.projectIds !== undefined) this.projects.assign(apiId, input.projectIds)
        return apiId
      }
      const version = integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER)
      const current = this.get(id)
      if (current.version !== version) throw conflict('API 配置已被修改，请刷新后再保存')
      if (input.projectIds !== undefined) this.projects.assign(id, input.projectIds, integer(input, 'projectVersion', '项目归类版本', 1, Number.MAX_SAFE_INTEGER))
      this.db.prepare(`UPDATE api SET name = ?, code = ?, path = ?, method = ?, auth = ?, user_agents = ?, mode = ?,
        datasource_id = ?, sql_text = ?, params = ?, fields = ?, filters = ?, key_fields = ?, cron = ?, cron_timezone = ?, allow_empty = ?,
        timeout_seconds = ?, max_rows = ?, enabled = ?, external_auth = ?, xingchen = ?, auth_connection_id = ?, xingchen_connection_id = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(...columns, time, id)
      const stored: IndexedApi = { id, fields: v.fields, filters: v.filters }
      const filtersChanged = filterSignature(current.fields, current.filters) !== filterSignature(v.fields, v.filters)
      if (current.mode !== v.mode) {
        // Stored rows of the old mode are removed in the background.
        this.store.clear(stored)
        this.db.prepare('UPDATE api SET sync_at = NULL, sync_status = NULL, sync_count = NULL, sync_error = NULL WHERE id = ?').run(id)
        rows = 'cleared'
      } else if (v.mode === 'MANUAL') {
        const fieldsChanged = stringify(current.fields) !== stringify(v.fields)
        if (fieldsChanged) this.migrateManualRows(id, v.fields)
        if (fieldsChanged || filtersChanged || !this.store.indexed(stored)) this.store.reindexInPlace(stored)
      } else if (v.mode === 'SNAPSHOT' && filtersChanged) {
        this.store.markStale(id)
        rows = 'stale'
      }
      this.db.prepare('UPDATE api SET access_policy = ? WHERE id = ?').run(JSON.stringify(v.accessPolicy), id)
      return id
    })
    this.schedule(saved)
    if (rows === 'cleared') this.store.collect(saved)
    if (rows === 'stale') this.ensureIndex(saved)
    return this.get(saved)
  }

  /** Re-validates stored manual rows against changed fields; a row that no longer fits aborts the save. */
  private migrateManualRows(id: number, fields: Field[]) {
    const generation = this.store.generation(id)
    const rows = this.db.prepare('SELECT row_key, data FROM api_row WHERE api_id = ? AND generation = ? ORDER BY position')
      .all(id, generation) as { row_key: string; data: string }[]
    const update = this.db.prepare('UPDATE api_row SET data = ?, version = version + 1, updated_at = ? WHERE api_id = ? AND generation = ? AND row_key = ?')
    rows.forEach((row, index) => {
      let data: string
      try {
        data = stringify(this.normalizeManual(fields, parse(row.data) as JsonObject, false))
      } catch (error) {
        throw conflict(`第 ${index + 1} 条记录不符合新的字段定义：${(error as Error).message}`)
      }
      if (data !== row.data) update.run(data, now(), id, generation, row.row_key)
    })
  }

  setEnabled(id: number, enabled: boolean): Api {
    const current = this.get(id)
    if (enabled) this.validate({ ...current, enabled } as unknown as JsonObject)
    this.db.prepare('UPDATE api SET enabled = ?, version = version + 1, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id)
    this.schedule(id)
    return this.get(id)
  }

  /** Copies configuration into a disabled API; save creates fresh metadata and no stored data. */
  copy(id: number): Api {
    const original = this.get(id)
    for (let index = 1; ; index++) {
      const suffix = index === 1 ? '_copy' : `_copy_${index}`
      const label = index === 1 ? '（副本）' : `（副本 ${index}）`
      const code = original.code.slice(0, 100 - suffix.length) + suffix
      const path = original.path.slice(0, 300 - suffix.length) + suffix
      const name = original.name.slice(0, 100 - label.length) + label
      if (this.db.prepare('SELECT 1 FROM api WHERE code = ? OR (path = ? AND method = ?) OR name = ?')
        .get(code, path, original.method, name)) continue
      return this.save(undefined, { ...original, name, code, path, enabled: false } as unknown as JsonObject)
    }
  }

  remove(id: number) {
    this.get(id)
    this.db.prepare('DELETE FROM api WHERE id = ?').run(id)
    this.schedule(id)
  }

  // ---- scheduling ----

  startSchedules() {
    this.db.prepare(`UPDATE api SET sync_status = 'FAILED', sync_error = '服务重启，同步中断'
      WHERE id IN (SELECT api_id FROM sync_log WHERE status = 'RUNNING')`).run()
    this.db.prepare("UPDATE sync_log SET status = 'FAILED', finished_at = ?, error = '服务重启，同步中断' WHERE status = 'RUNNING'").run(now())
    for (const { id } of this.db.prepare("SELECT id FROM api WHERE mode = 'SNAPSHOT' AND enabled = 1").all() as { id: number }[]) {
      this.schedule(id)
    }
    this.prepareRows()
  }

  stopSchedules() {
    this.directory.stop()
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }

  /** Stops background row work and the row readers; call after stopSchedules when shutting down. */
  async close() {
    for (const job of this.rebuilding.values()) job.cancelled = true
    await this.store.close()
  }

  /** After an upgrade or an interrupted sync: builds missing filter indexes and removes unused generations. */
  private prepareRows() {
    for (const { id, mode } of this.db.prepare('SELECT id, mode FROM api').all() as { id: number; mode: Mode }[]) {
      if (mode === 'MANUAL') {
        const api = this.get(id)
        if (!this.store.indexed(api)) transaction(this.db, () => this.store.reindexInPlace(api))
      }
      if (mode === 'SNAPSHOT') this.ensureIndex(id)
      this.store.collect(id)
    }
  }

  /** Brings the cron job for one API in line with its stored configuration. */
  private schedule(id: number) {
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
    const row = this.db.prepare('SELECT * FROM api WHERE id = ?').get(id) as ApiRow | undefined
    if (!row || row.mode !== 'SNAPSHOT' || row.enabled !== 1 || !row.cron) return
    const version = row.version
    this.jobs.set(id, new Cron(row.cron, { timezone: row.cron_timezone || this.config.timezone, protect: true }, async () => {
      await this.sync(id, version).catch(() => {}) // the failure is recorded on the API
    }))
  }

  // ---- snapshot ----

  /**
   * Replaces the snapshot with the current SQL result. A scheduled run passes the configuration
   * version it was created for and is dropped if the API has since changed or been disabled.
   * The new rows are written as a separate generation in short transactions and switched in at the end,
   * so calls keep reading the previous snapshot meanwhile and are never held up by a large write.
   */
  async sync(id: number, scheduledVersion?: number): Promise<{ count: number }> {
    if (this.syncing.has(id)) throw conflict('该 API 正在同步，请稍后再试')
    this.syncing.add(id)
    let api: Api | undefined
    let currentLogId: number | undefined
    try {
      api = this.get(id)
      if (api.mode !== 'SNAPSHOT') throw bad('只有定时同步模式的 API 可以同步')
      if (scheduledVersion !== undefined && (api.version !== scheduledVersion || !api.enabled)) return { count: 0 }
      const logId = Number(this.db.prepare(`INSERT INTO sync_log (api_id, started_at, trigger, status)
        VALUES (?, ?, ?, 'RUNNING')`).run(id, now(), scheduledVersion === undefined ? 'MANUAL' : 'SCHEDULED').lastInsertRowid)
      // Keep the log id in scope for both completion and failure.
      currentLogId = logId
      const { source, pool } = this.sources.pool(api.datasourceId!)
      const result = await runQuery(pool, positional(parseSql(api.sql!), () => 'text'), [], api)
      if (result.truncated) throw new HttpError(422, `同步结果超过最大行数 ${api.maxRows}，已保留上一次快照`)
      if (!result.rows.length && !api.allowEmpty) throw bad('同步结果为空，已保留上一次快照')
      const expected = api
      const rows = result.rows
      const keys: string[] = []
      const values: string[][] = expected.filters.map(() => [])
      for (let start = 0; start < rows.length; start += 1000) {
        for (const row of rows.slice(start, start + 1000)) {
          keys.push(rowKey(row, expected.keyFields))
          filterKeys(expected, row).forEach((value, index) => values[index].push(value))
        }
        await pause()
      }
      const order = await sortedOrder(keys.length, (a, b) => compare(keys[a], keys[b]))
      for (let k = 1; k < order.length; k++) {
        if (keys[order[k]] === keys[order[k - 1]]) throw bad('同步结果中唯一键重复，已保留上一次快照')
      }
      // An index rebuild for changed filters is superseded: this sync writes the index for the current filters.
      await this.stopRebuild(id)
      const previous = this.store.generation(id)
      const time = now()
      // Manual order, remark and row version carry over from the row with the same key in the current snapshot.
      const insert = this.db.prepare(`INSERT INTO api_row (api_id, generation, row_key, data, position, sort, remark, version, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, old.sort, coalesce(old.remark, ''), coalesce(old.version, 1), ?6
        FROM (SELECT 1) LEFT JOIN api_row old ON old.api_id = ?1 AND old.generation = ?7 AND old.row_key = ?3`)
      const remark = this.db.prepare('SELECT remark FROM api_row WHERE api_id = ? AND generation = ? AND row_key = ?')
      // Rows are written in key order (see RowStore.write).
      const generation = await this.store.write(expected, keys, values, () => {
        if (this.get(id).version !== expected.version) throw conflict('同步期间 API 配置已变更，快照未更新')
      }, (generation, start, end) => {
        for (let k = start; k < end; k++) {
          const index = order[k]
          const row = rows[index]
          if (Object.hasOwn(row, REMARK_FIELD) && (remark.get(id, previous, keys[index]) as { remark: string } | undefined)?.remark) {
            throw bad(`数据字段 ${REMARK_FIELD} 与平台备注冲突，已保留上一次快照`)
          }
          insert.run(id, generation, keys[index], stringify(row), index, time, previous)
        }
      })
      try {
        transaction(this.db, () => {
          const current = this.get(id)
          if (current.version !== expected.version || (scheduledVersion !== undefined && !current.enabled)) {
            throw conflict('同步期间 API 配置已变更，快照未更新')
          }
          if (this.sources.get(source.id).version !== source.version) throw conflict('同步期间数据源配置已变更，快照未更新')
          this.store.switchTo(expected, generation)
          const finished = now()
          this.db.prepare("UPDATE api SET sync_at = ?, sync_status = 'SUCCESS', sync_count = ?, sync_error = NULL WHERE id = ?")
            .run(finished, rows.length, id)
          this.db.prepare("UPDATE sync_log SET status = 'SUCCESS', finished_at = ?, row_count = ? WHERE id = ?")
            .run(finished, rows.length, logId)
        })
      } finally {
        this.store.finish(id)
      }
      return { count: rows.length }
    } catch (error) {
      if (api?.mode === 'SNAPSHOT') {
        const message = error instanceof SourceError ? `${error.message}：${error.detail}` : (error as Error).message
        this.db.prepare("UPDATE api SET sync_status = 'FAILED', sync_error = ? WHERE id = ? AND version = ?").run(message, id, api.version)
        if (currentLogId !== undefined) {
          this.db.prepare("UPDATE sync_log SET status = 'FAILED', finished_at = ?, error = ? WHERE id = ?")
            .run(now(), message, currentLogId)
        }
      }
      throw error
    } finally {
      this.syncing.delete(id)
      // A filter change during the sync left the index stale.
      this.ensureIndex(id)
    }
  }

  /** Starts a background rebuild when a snapshot's filter index does not match its filter configuration. */
  private ensureIndex(id: number) {
    if (this.syncing.has(id) || this.rebuilding.has(id) || this.store.closed || !this.db.isOpen) return
    const api = this.db.prepare('SELECT * FROM api WHERE id = ?').get(id) as ApiRow | undefined
    if (!api || api.mode !== 'SNAPSHOT') return
    const target: IndexedApi = { id, fields: JSON.parse(api.fields), filters: JSON.parse(api.filters) }
    if (this.store.indexed(target)) return
    const job = { cancelled: false, done: Promise.resolve() }
    this.rebuilding.set(id, job)
    job.done = this.rebuildIndex(target, job).then(() => {
      this.rebuilding.delete(id)
      this.ensureIndex(id) // the filters may have changed again meanwhile
    }, error => {
      // Not retried here; the next save, sync or restart tries again. Calls compare every row until then.
      this.rebuilding.delete(id)
      if (!(error instanceof HttpError) && this.db.isOpen) console.error(`Rebuilding the filter index of API ${id} failed:`, error)
    })
  }

  /** Copies the current snapshot into a new generation with keys for the configured filters, then switches to it. */
  private async rebuildIndex(target: IndexedApi, job: { cancelled: boolean }) {
    const id = target.id
    const signature = filterSignature(target.fields, target.filters)
    const previous = this.store.generation(id)
    const cancelled = () => {
      if (job.cancelled || this.store.closed) throw conflict('索引重建已取消')
    }
    // Row keys in key order with their filter keys, read a chunk at a time.
    const keys: string[] = []
    const values: string[][] = target.filters.map(() => [])
    const read = this.db.prepare(`SELECT row_key, data FROM api_row WHERE api_id = ? AND generation = ? AND row_key > ?
      ORDER BY row_key LIMIT 1000`)
    for (;;) {
      cancelled()
      const rows = read.all(id, previous, keys.at(-1) ?? '') as { row_key: string; data: string }[]
      for (const row of rows) {
        keys.push(row.row_key)
        filterKeys(target, parse(row.data) as JsonObject).forEach((value, index) => values[index].push(value))
      }
      if (rows.length < 1000) break
      await pause()
    }
    const copy = this.db.prepare(`INSERT INTO api_row (api_id, generation, row_key, data, position, sort, remark, version, updated_at)
      SELECT api_id, ?, row_key, data, position, sort, remark, version, updated_at FROM api_row
      WHERE api_id = ? AND generation = ? AND row_key > ? ORDER BY row_key LIMIT ?`)
    // keys is in the database's key order, so each chunk continues after the last key of the one before.
    const generation = await this.store.write(target, keys, values, cancelled,
      (generation, start, end) => copy.run(generation, id, previous, start ? keys[start - 1] : '', end - start))
    try {
      transaction(this.db, () => {
        const current = this.db.prepare('SELECT mode, fields, filters FROM api WHERE id = ?').get(id) as Pick<ApiRow, 'mode' | 'fields' | 'filters'> | undefined
        if (current?.mode === 'SNAPSHOT' && this.store.generation(id) === previous
          && filterSignature(JSON.parse(current.fields), JSON.parse(current.filters)) === signature) this.store.switchTo(target, generation)
      })
    } finally {
      this.store.finish(id)
    }
  }

  private async stopRebuild(id: number) {
    const job = this.rebuilding.get(id)
    if (!job) return
    job.cancelled = true
    await job.done
  }

  /** Remarks and manual order are copied into the generation being written, so they cannot change meanwhile. */
  private assertIdle(id: number) {
    if (this.store.writing(id) || this.rebuilding.has(id)) throw conflict('数据正在同步或整理，请稍后再试')
  }

  // ---- stored rows ----

  async rows(id: number, page: number, pageSize: number, search = '') {
    const api = this.get(id)
    if (api.mode === 'REALTIME' || api.mode === 'XINGCHEN') throw bad('当前模式没有本地数据')
    const query = search.trim()
    if (query.length > 200) throw bad('搜索内容不能超过 200 个字符')
    const { items, total, allTotal } = await this.store.list({ apiId: id, page, pageSize, search: query })
    return { items: items.map(item => ({ ...item, data: parse(item.data) })), total, allTotal, page, pageSize }
  }

  private normalizeManual(fields: Field[], input: JsonObject, rejectUnknown: boolean): Row {
    if (rejectUnknown) {
      const unknown = Object.keys(input).find(key => !fields.some(field => field.name === key))
      if (unknown) throw bad(`未定义的字段 ${unknown}`)
    }
    return Object.fromEntries(fields.map(field => {
      const value = convertOptional(own(input, field.name), field)
      if (field.required && (value === null || value === '')) throw bad(`请填写 ${field.name}`)
      return [field.name, value]
    }))
  }

  private manualApi(id: number): Api {
    const api = this.get(id)
    if (api.mode !== 'MANUAL') throw bad('只有手工维护模式的 API 可以编辑数据')
    return api
  }

  createRow(id: number, input: JsonObject) {
    return transaction(this.db, () => {
      const api = this.manualApi(id)
      const data = this.normalizeManual(api.fields, input, true)
      const key = randomUUID()
      const generation = this.store.generation(id)
      this.db.prepare(`INSERT INTO api_row (api_id, generation, row_key, data, position, updated_at)
        VALUES (?1, ?2, ?3, ?4, (SELECT coalesce(max(position), -1) + 1 FROM api_row WHERE api_id = ?1 AND generation = ?2), ?5)`)
        .run(id, generation, key, stringify(data), now())
      this.store.index(api, generation, key, data)
      return { key, version: 1, data }
    })
  }

  updateRow(id: number, key: string, version: number, input: JsonObject) {
    return transaction(this.db, () => {
      const api = this.manualApi(id)
      const data = this.normalizeManual(api.fields, input, true)
      const generation = this.store.generation(id)
      const changed = this.db.prepare(`UPDATE api_row SET data = ?, version = version + 1, updated_at = ?
        WHERE api_id = ? AND generation = ? AND row_key = ? AND version = ?`).run(stringify(data), now(), id, generation, key, version)
      if (changed.changes === 0) this.rowConflict(id, key)
      this.store.unindex(api, generation, key)
      this.store.index(api, generation, key, data)
      return { key, version: version + 1, data }
    })
  }

  deleteRow(id: number, key: string, version: number) {
    transaction(this.db, () => {
      const api = this.manualApi(id)
      const generation = this.store.generation(id)
      if (this.db.prepare('DELETE FROM api_row WHERE api_id = ? AND generation = ? AND row_key = ? AND version = ?')
        .run(id, generation, key, version).changes === 0) {
        this.rowConflict(id, key)
      }
      this.store.unindex(api, generation, key)
    })
  }

  private rowConflict(id: number, key: string): never {
    if (!this.db.prepare('SELECT 1 FROM api_row WHERE api_id = ? AND generation = ? AND row_key = ?')
      .get(id, this.store.generation(id), key)) throw notFound('记录不存在')
    throw conflict('记录已被修改，请刷新后再操作')
  }

  updateRemark(id: number, key: string, version: number, remark: unknown) {
    const api = this.get(id)
    if (api.mode === 'REALTIME' || api.mode === 'XINGCHEN') throw bad('当前模式没有本地数据')
    if (typeof remark !== 'string' || remark.length > 2000) throw bad('备注必须是 2000 个字符以内的文本')
    this.assertIdle(id)
    const value = remark.trim()
    const generation = this.store.generation(id)
    const existing = this.db.prepare('SELECT data FROM api_row WHERE api_id = ? AND generation = ? AND row_key = ?')
      .get(id, generation, key) as { data: string } | undefined
    if (!existing) throw notFound('记录不存在')
    if (value && Object.hasOwn(parse(existing.data) as Row, REMARK_FIELD)) throw bad(`数据字段 ${REMARK_FIELD} 与平台备注冲突`)
    const changed = this.db.prepare(`UPDATE api_row SET remark = ?, version = version + 1, updated_at = ?
      WHERE api_id = ? AND generation = ? AND row_key = ? AND version = ?`).run(value, now(), id, generation, key, version)
    if (changed.changes === 0) this.rowConflict(id, key)
    return { key, version: version + 1, remark: value }
  }

  /** Moves one snapshot row to a 1-based position; every row then keeps an explicit order. */
  moveRow(id: number, key: string, position: number) {
    transaction(this.db, () => {
      if (this.get(id).mode !== 'SNAPSHOT') throw bad('只有定时同步模式的数据可以排序')
      this.assertIdle(id)
      const generation = this.store.generation(id)
      const keys = (this.db.prepare('SELECT row_key FROM api_row WHERE api_id = ? AND generation = ? ORDER BY sort IS NULL, sort, position')
        .all(id, generation) as { row_key: string }[]).map(row => row.row_key)
      const from = keys.indexOf(key)
      if (from < 0) throw notFound('记录不存在')
      keys.splice(from, 1)
      keys.splice(Math.min(Math.max(position, 1), keys.length + 1) - 1, 0, key)
      const update = this.db.prepare('UPDATE api_row SET sort = ? WHERE api_id = ? AND generation = ? AND row_key = ?')
      keys.forEach((rowKey, index) => update.run(index + 1, id, generation, rowKey))
    })
  }

  resetSort(id: number) {
    if (this.get(id).mode !== 'SNAPSHOT') throw bad('只有定时同步模式的数据可以排序')
    this.assertIdle(id)
    this.db.prepare('UPDATE api_row SET sort = NULL WHERE api_id = ? AND generation = ?').run(id, this.store.generation(id))
  }

  /** A shared identity service can expose many fields; each API requires only what it uses. */
  identityConfig(api: Pick<Api, 'mode' | 'sql' | 'xingchen' | 'externalAuth'> & { accessPolicy?: AccessPolicy }): ExternalAuthConfig | null {
    if (!api.externalAuth) return null
    const names = api.mode === 'REALTIME' ? parseSql(api.sql!).names
      : api.mode === 'XINGCHEN' ? [api.xingchen?.staffCodeBinding] : []
    if (api.accessPolicy?.enabled) names.push(api.accessPolicy.staffBinding)
    return { ...api.externalAuth, bindings: api.externalAuth.bindings.filter(binding => names.includes(binding.name)) }
  }

  // ---- open queries ----

  async query(api: Api, input: JsonObject, identity?: QueryIdentity): Promise<Row[]> {
    if (api.mode === 'XINGCHEN') throw bad('星辰模式请使用转发接口')
    if (api.auth === 'EXTERNAL' && !identity) throw forbidden('缺少已验证的身份')
    return api.mode === 'REALTIME' ? this.realtime(api, input, { identity }) : storedRows(await this.queryStored(api, input, identity))
  }

  async queryPage(api: Api, input: JsonObject, page: number, pageSize: number, identity?: QueryIdentity): Promise<PageResult> {
    if (api.mode === 'XINGCHEN') throw bad('星辰模式请使用转发接口')
    if (api.auth === 'EXTERNAL' && !identity) throw forbidden('缺少已验证的身份')
    if (api.mode !== 'REALTIME') {
      const result = await this.queryStored(api, input, identity, page, pageSize)
      return { rows: storedRows(result), total: result.total!, page, pageSize }
    }
    const { sql, values, pool } = this.realtimeStatement(api, input, identity)
    const source = `(${sql}) AS databridge_source`
    // One snapshot for both, so the total matches the page even while the source changes.
    const [count, result] = await runStatements(pool, [
      { text: `SELECT count(*)::text AS total FROM ${source}`, values, maxRows: 1 },
      { text: `SELECT * FROM ${source} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values, maxRows: pageSize },
    ], api.timeoutSeconds)
    const total = Number(count.rows[0].total)
    if (!Number.isSafeInteger(total)) throw new HttpError(422, '结果总数过大，无法分页')
    return { rows: result.rows, total, page, pageSize }
  }

  /** Runs the API's SQL with request parameters; used by open calls and by the editor's test button. */
  async realtime(api: Pick<Api, 'auth' | 'externalAuth' | 'datasourceId' | 'sql' | 'params' | 'timeoutSeconds' | 'maxRows'>, input: JsonObject,
                 options: { truncate?: boolean; identity?: QueryIdentity } = {}): Promise<Row[]> {
    const { sql, values, pool } = this.realtimeStatement(api, input, options.identity)
    const result = await runQuery(pool, sql, values, api)
    if (result.truncated && !options.truncate) throw new HttpError(422, `查询结果超过最大行数 ${api.maxRows}`)
    return result.rows
  }

  private realtimeStatement(api: Pick<Api, 'auth' | 'externalAuth' | 'datasourceId' | 'sql' | 'params'>, input: JsonObject, identity?: QueryIdentity) {
    const authBindings = api.auth === 'EXTERNAL' ? api.externalAuth?.bindings ?? [] : []
    if (api.auth === 'EXTERNAL') {
      if (!identity) throw forbidden('缺少已验证的身份')
      if (Object.keys(input).some(name => name.startsWith(AUTH_PARAM_PREFIX))) throw bad('身份参数由外部验证提供，不能通过请求传入')
    }
    const unknown = Object.keys(input).find(key => !api.params.some(param => param.name === key))
    if (unknown) throw bad(`未定义的参数 ${unknown}`)
    const parsed = parseSql(api.sql!)
    const values = parsed.names.map(name => {
      if (authBindings.some(binding => binding.name === name)) {
        if (!identity || !Object.hasOwn(identity, name) || identity[name] === null) throw forbidden('缺少必要身份参数')
        return toPg(identity[name])
      }
      const param = api.params.find(p => p.name === name)!
      const value = convertOptional(own(input, name), param)
      if (param.required && (value === null || value === '')) throw bad(`缺少参数 ${name}`)
      return toPg(value)
    })
    const sql = positional(parsed, name => {
      const type = PG_TYPES[[...api.params, ...authBindings].find(p => p.name === name)!.type]
      // Datetimes with an offset arrive in UTC ("Z"); a plain timestamp cast would drop the zone,
      // so read them as timestamptz and convert to the session's local time.
      const value = values[parsed.names.indexOf(name)]
      return type === 'timestamp' && value?.endsWith('Z') ? 'timestamptz::timestamp' : type
    })
    const { pool } = this.sources.pool(api.datasourceId!)
    return { sql, values, pool }
  }

  /**
   * Equality filters over stored rows, compared by field type ("1.50" matches 1.5; null matches null).
   * The row worker answers from the filter index and returns serialised rows, so open calls send them as stored.
   */
  async queryStored(api: Api, input: JsonObject, verified?: QueryIdentity, page?: number, pageSize?: number): Promise<OpenResult> {
    if (api.mode !== 'SNAPSHOT' && api.mode !== 'MANUAL') throw bad('当前模式没有本地数据')
    if (api.auth === 'EXTERNAL' && !verified) throw forbidden('缺少已验证的身份')
    const filters: RowFilter[] = Object.keys(input).map(name => {
      const field = api.fields.find(f => f.name === name)
      if (!field || !api.filters.includes(name)) throw bad(`不支持按 ${name} 过滤`)
      const value = convertOptional(own(input, name), field)
      return { name, field, key: value === null ? NULL_KEY : identity(value) }
    })
    return this.store.open({ apiId: api.id, signature: filterSignature(api.fields, api.filters), filters, maxRows: api.maxRows, page, pageSize })
  }
}
