import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import type { Config } from './config.ts'
import { now, transaction, type Db } from './db.ts'
import { bad, conflict, HttpError, notFound } from './errors.ts'
import { choice, flag, integer, list, NAME, names, text } from './input.ts'
import { isObject, parse, stringify, type Json, type JsonObject } from './json.ts'
import { runQuery, SourceError } from './query.ts'
import type { Sources } from './sources.ts'
import { parseSql, positional } from './sql.ts'
import { convertOptional, FIELD_TYPES, identity, rowKey, type Field, type FieldType } from './values.ts'

export const MODES = ['REALTIME', 'SNAPSHOT', 'MANUAL'] as const
export type Mode = (typeof MODES)[number]

export interface Api {
  id: number
  name: string
  code: string
  path: string
  method: 'GET' | 'POST'
  auth: 'API_KEY' | 'PUBLIC'
  userAgents: string[]
  mode: Mode
  datasourceId: number | null
  sql: string | null
  params: Field[]
  fields: Field[]
  filters: string[]
  keyFields: string[]
  cron: string | null
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
export const REMARK_FIELD = '__databridge_remark'
function withRemark(row: Row, remark: string): Row {
  if (!remark) return row
  if (Object.hasOwn(row, REMARK_FIELD)) throw new HttpError(422, `数据字段 ${REMARK_FIELD} 与平台备注冲突`)
  return { ...row, [REMARK_FIELD]: remark }
}

interface ApiRow {
  id: number; name: string; code: string; path: string; method: Api['method']; auth: Api['auth']; user_agents: string
  mode: Mode; datasource_id: number | null; sql_text: string | null; params: string; fields: string; filters: string
  key_fields: string; cron: string | null; allow_empty: number; timeout_seconds: number; max_rows: number; enabled: number
  version: number; sync_at: string | null; sync_status: string | null; sync_count: number | null; sync_error: string | null
  created_at: string; updated_at: string
}

const toApi = (row: ApiRow): Api => ({
  id: row.id, name: row.name, code: row.code, path: row.path, method: row.method, auth: row.auth,
  userAgents: JSON.parse(row.user_agents), mode: row.mode, datasourceId: row.datasource_id, sql: row.sql_text,
  params: JSON.parse(row.params), fields: JSON.parse(row.fields), filters: JSON.parse(row.filters),
  keyFields: JSON.parse(row.key_fields), cron: row.cron, allowEmpty: row.allow_empty === 1,
  timeoutSeconds: row.timeout_seconds, maxRows: row.max_rows, enabled: row.enabled === 1, version: row.version,
  syncAt: row.sync_at, syncStatus: row.sync_status, syncCount: row.sync_count, syncError: row.sync_error,
  createdAt: row.created_at, updatedAt: row.updated_at,
})

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
  private readonly jobs = new Map<number, Cron>()
  private readonly syncing = new Set<number>()
  private readonly db: Db
  private readonly sources: Sources
  private readonly config: Config

  constructor(db: Db, sources: Sources, config: Config) {
    this.db = db
    this.sources = sources
    this.config = config
  }

  // ---- configuration ----

  list(): Api[] {
    return (this.db.prepare('SELECT * FROM api ORDER BY id DESC').all() as unknown as ApiRow[]).map(row => this.withSchedule(toApi(row)))
  }

  get(id: number): Api {
    const row = this.db.prepare('SELECT * FROM api WHERE id = ?').get(id) as ApiRow | undefined
    if (!row) throw notFound('API 不存在')
    return this.withSchedule(toApi(row))
  }

  findOpen(path: string, method: string): Api | undefined {
    const row = this.db.prepare('SELECT * FROM api WHERE path = ? AND method = ? AND enabled = 1').get(path, method) as ApiRow | undefined
    return row && toApi(row)
  }

  private withSchedule(api: Api): Api {
    const next = this.jobs.get(api.id)?.nextRun()
    return api.mode === 'SNAPSHOT' ? { ...api, nextSyncAt: next ? next.toISOString() : null } : api
  }

  /** Validates a submitted configuration; the result is what gets stored. */
  validate(input: JsonObject) {
    const mode = choice(input, 'mode', '数据模式', MODES)
    const sourced = mode !== 'MANUAL'
    const values = {
      name: text(input, 'name', '接口名称', { max: 100 }),
      code: text(input, 'code', '接口编码', { max: 100, pattern: /^[A-Za-z][A-Za-z0-9_]*$/ }),
      path: text(input, 'path', '接口路径', { max: 300, pattern: /^\/open(\/[A-Za-z0-9_-]+)+$/ }),
      method: choice(input, 'method', '请求方式', ['GET', 'POST'] as const, 'GET'),
      auth: choice(input, 'auth', '访问方式', ['API_KEY', 'PUBLIC'] as const, 'API_KEY'),
      userAgents: userAgentRules(input),
      mode,
      datasourceId: sourced ? integer(input, 'datasourceId', '数据源', 1, Number.MAX_SAFE_INTEGER) : null,
      sql: sourced ? text(input, 'sql', 'SQL', { max: 100_000 }) : null,
      params: mode === 'REALTIME' ? schema(input, 'params', '请求参数') : [],
      fields: mode === 'REALTIME' ? [] : schema(input, 'fields', '字段定义'),
      filters: mode === 'REALTIME' ? [] : names(input, 'filters', '过滤字段'),
      keyFields: mode === 'SNAPSHOT' ? names(input, 'keyFields', '唯一键') : [],
      cron: mode === 'SNAPSHOT' ? text(input, 'cron', '同步 Cron', { max: 100 }) : null,
      allowEmpty: mode === 'SNAPSHOT' && flag(input, 'allowEmpty', '空结果覆盖', false),
      timeoutSeconds: sourced ? integer(input, 'timeoutSeconds', '查询超时', 1, 120, 10) : 10,
      maxRows: integer(input, 'maxRows', '最大行数', 1, 100_000, 10_000),
      enabled: flag(input, 'enabled', '启用状态', false),
    }
    if (values.datasourceId !== null) this.sources.get(values.datasourceId)
    if (values.sql !== null) {
      const { names: used } = parseSql(values.sql)
      const declared = values.params.map(param => param.name)
      const undeclared = used.find(name => !declared.includes(name))
      if (undeclared) throw bad(mode === 'SNAPSHOT' ? '定时同步的 SQL 不能包含参数' : `SQL 使用了未定义的参数 :${undeclared}`)
      const unused = declared.find(name => !used.includes(name))
      if (unused) throw bad(`参数 ${unused} 没有在 SQL 中使用`)
    }
    if (mode === 'MANUAL' && !values.fields.length) throw bad('手工维护模式需要至少一个字段')
    if (mode === 'SNAPSHOT' && !values.keyFields.length) throw bad('定时同步模式需要唯一键')
    const unknownFilter = values.filters.find(name => !values.fields.some(field => field.name === name))
    if (unknownFilter) throw bad(`过滤字段 ${unknownFilter} 需要先在字段定义中声明类型`)
    if (values.cron !== null) {
      let next: Date | null
      try {
        next = new Cron(values.cron, { paused: true, timezone: this.config.timezone }).nextRun()
      } catch {
        throw bad('Cron 表达式无效')
      }
      if (!next) throw bad('Cron 表达式永远不会触发')
    }
    return values
  }

  save(id: number | undefined, input: JsonObject): Api {
    const v = this.validate(input)
    const time = now()
    const columns = [v.name, v.code, v.path, v.method, v.auth, stringify(v.userAgents), v.mode, v.datasourceId, v.sql,
      stringify(v.params), stringify(v.fields), stringify(v.filters), stringify(v.keyFields), v.cron, v.allowEmpty ? 1 : 0,
      v.timeoutSeconds, v.maxRows, v.enabled ? 1 : 0]
    const saved = transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM api WHERE code = ? AND id IS NOT ?').get(v.code, id ?? null)) throw conflict('接口编码已存在')
      if (this.db.prepare('SELECT 1 FROM api WHERE path = ? AND method = ? AND id IS NOT ?').get(v.path, v.method, id ?? null)) {
        throw conflict('相同路径和请求方式的接口已存在')
      }
      if (id === undefined) {
        const result = this.db.prepare(`INSERT INTO api (name, code, path, method, auth, user_agents, mode, datasource_id, sql_text,
          params, fields, filters, key_fields, cron, allow_empty, timeout_seconds, max_rows, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...columns, time, time)
        return Number(result.lastInsertRowid)
      }
      const version = integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER)
      const current = this.get(id)
      if (current.version !== version) throw conflict('API 配置已被修改，请刷新后再保存')
      this.db.prepare(`UPDATE api SET name = ?, code = ?, path = ?, method = ?, auth = ?, user_agents = ?, mode = ?,
        datasource_id = ?, sql_text = ?, params = ?, fields = ?, filters = ?, key_fields = ?, cron = ?, allow_empty = ?,
        timeout_seconds = ?, max_rows = ?, enabled = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(...columns, time, id)
      if (current.mode !== v.mode) {
        this.db.prepare('DELETE FROM api_row WHERE api_id = ?').run(id)
        this.db.prepare('UPDATE api SET sync_at = NULL, sync_status = NULL, sync_count = NULL, sync_error = NULL WHERE id = ?').run(id)
      } else if (v.mode === 'MANUAL' && stringify(current.fields) !== stringify(v.fields)) {
        this.migrateManualRows(id, v.fields)
      }
      return id
    })
    this.schedule(saved)
    return this.get(saved)
  }

  /** Re-validates stored manual rows against changed fields; a row that no longer fits aborts the save. */
  private migrateManualRows(id: number, fields: Field[]) {
    const rows = this.db.prepare('SELECT row_key, data FROM api_row WHERE api_id = ? ORDER BY position').all(id) as { row_key: string; data: string }[]
    const update = this.db.prepare('UPDATE api_row SET data = ?, version = version + 1, updated_at = ? WHERE api_id = ? AND row_key = ?')
    rows.forEach((row, index) => {
      let data: string
      try {
        data = stringify(this.normalizeManual(fields, parse(row.data) as JsonObject, false))
      } catch (error) {
        throw conflict(`第 ${index + 1} 条记录不符合新的字段定义：${(error as Error).message}`)
      }
      if (data !== row.data) update.run(data, now(), id, row.row_key)
    })
  }

  setEnabled(id: number, enabled: boolean): Api {
    this.get(id)
    this.db.prepare('UPDATE api SET enabled = ?, version = version + 1, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id)
    this.schedule(id)
    return this.get(id)
  }

  remove(id: number) {
    this.get(id)
    this.db.prepare('DELETE FROM api WHERE id = ?').run(id)
    this.schedule(id)
  }

  // ---- scheduling ----

  startSchedules() {
    for (const { id } of this.db.prepare("SELECT id FROM api WHERE mode = 'SNAPSHOT' AND enabled = 1").all() as { id: number }[]) {
      this.schedule(id)
    }
  }

  stopSchedules() {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }

  /** Brings the cron job for one API in line with its stored configuration. */
  private schedule(id: number) {
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
    const row = this.db.prepare('SELECT * FROM api WHERE id = ?').get(id) as ApiRow | undefined
    if (!row || row.mode !== 'SNAPSHOT' || row.enabled !== 1 || !row.cron) return
    const version = row.version
    this.jobs.set(id, new Cron(row.cron, { timezone: this.config.timezone, protect: true }, async () => {
      await this.sync(id, version).catch(() => {}) // the failure is recorded on the API
    }))
  }

  // ---- snapshot ----

  /**
   * Replaces the snapshot with the current SQL result. A scheduled run passes the configuration
   * version it was created for and is dropped if the API has since changed or been disabled.
   */
  async sync(id: number, scheduledVersion?: number): Promise<{ count: number }> {
    if (this.syncing.has(id)) throw conflict('该 API 正在同步，请稍后再试')
    this.syncing.add(id)
    let api: Api | undefined
    try {
      api = this.get(id)
      if (api.mode !== 'SNAPSHOT') throw bad('只有定时同步模式的 API 可以同步')
      if (scheduledVersion !== undefined && (api.version !== scheduledVersion || !api.enabled)) return { count: 0 }
      const { source, pool } = this.sources.pool(api.datasourceId!)
      const result = await runQuery(pool, positional(parseSql(api.sql!), () => 'text'), [], api)
      if (result.truncated) throw new HttpError(422, `同步结果超过最大行数 ${api.maxRows}，已保留上一次快照`)
      if (!result.rows.length && !api.allowEmpty) throw bad('同步结果为空，已保留上一次快照')
      const keys = result.rows.map(row => rowKey(row, api!.keyFields))
      if (new Set(keys).size !== keys.length) throw bad('同步结果中唯一键重复，已保留上一次快照')
      const expected = api
      transaction(this.db, () => {
        const current = this.get(id)
        if (current.version !== expected.version || (scheduledVersion !== undefined && !current.enabled)) {
          throw conflict('同步期间 API 配置已变更，快照未更新')
        }
        if (this.sources.get(source.id).version !== source.version) throw conflict('同步期间数据源配置已变更，快照未更新')
        const previous = new Map((this.db.prepare('SELECT row_key, sort, remark, version FROM api_row WHERE api_id = ?')
          .all(id) as { row_key: string; sort: number | null; remark: string; version: number }[]).map(row => [row.row_key, row]))
        this.db.prepare('DELETE FROM api_row WHERE api_id = ?').run(id)
        const insert = this.db.prepare(`INSERT INTO api_row (api_id, row_key, data, position, sort, remark, version, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        const time = now()
        result.rows.forEach((row, index) => {
          const old = previous.get(keys[index])
          if (old?.remark && Object.hasOwn(row, REMARK_FIELD)) throw bad(`数据字段 ${REMARK_FIELD} 与平台备注冲突，已保留上一次快照`)
          insert.run(id, keys[index], stringify(row), index, old?.sort ?? null, old?.remark ?? '', old?.version ?? 1, time)
        })
        this.db.prepare("UPDATE api SET sync_at = ?, sync_status = 'SUCCESS', sync_count = ?, sync_error = NULL WHERE id = ?")
          .run(time, result.rows.length, id)
      })
      return { count: result.rows.length }
    } catch (error) {
      if (api?.mode === 'SNAPSHOT') {
        const message = error instanceof SourceError ? `${error.message}：${error.detail}` : (error as Error).message
        this.db.prepare("UPDATE api SET sync_status = 'FAILED', sync_error = ? WHERE id = ? AND version = ?").run(message, id, api.version)
      }
      throw error
    } finally {
      this.syncing.delete(id)
    }
  }

  // ---- stored rows ----

  rows(id: number, page: number, pageSize: number, search = '') {
    const api = this.get(id)
    if (api.mode === 'REALTIME') throw bad('实时查询模式没有本地数据')
    const query = search.trim()
    if (query.length > 200) throw bad('搜索内容不能超过 200 个字符')
    const offset = (page - 1) * pageSize
    if (!query) {
      const { total } = this.db.prepare('SELECT count(*) AS total FROM api_row WHERE api_id = ?').get(id) as { total: number }
      const items = (this.db.prepare(`SELECT row_key, data, remark, version, sort FROM api_row WHERE api_id = ?
        ORDER BY sort IS NULL, sort, position LIMIT ? OFFSET ?`).all(id, pageSize, offset) as
        { row_key: string; data: string; remark: string; version: number; sort: number | null }[])
        .map((row, index) => ({ key: row.row_key, version: row.version, sorted: row.sort !== null,
          position: offset + index + 1, remark: row.remark, data: parse(row.data) }))
      return { items, total, allTotal: total, page, pageSize }
    }
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    const sql = `WITH ordered AS (
      SELECT row_key, data, remark, version, sort, row_number() OVER (ORDER BY sort IS NULL, sort, position) AS position
      FROM api_row WHERE api_id = ?
    ) SELECT * FROM ordered WHERE EXISTS (SELECT 1 FROM json_each(ordered.data)
      WHERE CAST(value AS TEXT) LIKE ? ESCAPE '\\') OR remark LIKE ? ESCAPE '\\'`
    const args = [id, pattern, pattern]
    const { total } = this.db.prepare(`SELECT count(*) AS total FROM (${sql})`).get(...args) as { total: number }
    const items = (this.db.prepare(`${sql} ORDER BY position LIMIT ? OFFSET ?`).all(...args, pageSize, offset) as
      { row_key: string; data: string; remark: string; version: number; sort: number | null; position: number }[])
      .map(row => ({ key: row.row_key, version: row.version, sorted: row.sort !== null,
        position: row.position, remark: row.remark, data: parse(row.data) }))
    const allTotal = (this.db.prepare('SELECT count(*) AS total FROM api_row WHERE api_id = ?').get(id) as { total: number }).total
    return { items, total, allTotal, page, pageSize }
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
      const data = this.normalizeManual(this.manualApi(id).fields, input, true)
      const key = randomUUID()
      this.db.prepare(`INSERT INTO api_row (api_id, row_key, data, position, updated_at)
        VALUES (?, ?, ?, (SELECT coalesce(max(position), -1) + 1 FROM api_row WHERE api_id = ?), ?)`).run(id, key, stringify(data), id, now())
      return { key, version: 1, data }
    })
  }

  updateRow(id: number, key: string, version: number, input: JsonObject) {
    return transaction(this.db, () => {
      const data = this.normalizeManual(this.manualApi(id).fields, input, true)
      const changed = this.db.prepare('UPDATE api_row SET data = ?, version = version + 1, updated_at = ? WHERE api_id = ? AND row_key = ? AND version = ?')
        .run(stringify(data), now(), id, key, version)
      if (changed.changes === 0) this.rowConflict(id, key)
      return { key, version: version + 1, data }
    })
  }

  deleteRow(id: number, key: string, version: number) {
    transaction(this.db, () => {
      this.manualApi(id)
      if (this.db.prepare('DELETE FROM api_row WHERE api_id = ? AND row_key = ? AND version = ?').run(id, key, version).changes === 0) {
        this.rowConflict(id, key)
      }
    })
  }

  private rowConflict(id: number, key: string): never {
    if (!this.db.prepare('SELECT 1 FROM api_row WHERE api_id = ? AND row_key = ?').get(id, key)) throw notFound('记录不存在')
    throw conflict('记录已被修改，请刷新后再操作')
  }

  updateRemark(id: number, key: string, version: number, remark: unknown) {
    const api = this.get(id)
    if (api.mode === 'REALTIME') throw bad('实时查询模式没有本地数据')
    if (typeof remark !== 'string' || remark.length > 2000) throw bad('备注必须是 2000 个字符以内的文本')
    const value = remark.trim()
    const existing = this.db.prepare('SELECT data FROM api_row WHERE api_id = ? AND row_key = ?').get(id, key) as { data: string } | undefined
    if (!existing) throw notFound('记录不存在')
    if (value && Object.hasOwn(parse(existing.data) as Row, REMARK_FIELD)) throw bad(`数据字段 ${REMARK_FIELD} 与平台备注冲突`)
    const changed = this.db.prepare(`UPDATE api_row SET remark = ?, version = version + 1, updated_at = ?
      WHERE api_id = ? AND row_key = ? AND version = ?`).run(value, now(), id, key, version)
    if (changed.changes === 0) this.rowConflict(id, key)
    return { key, version: version + 1, remark: value }
  }

  /** Moves one snapshot row to a 1-based position; every row then keeps an explicit order. */
  moveRow(id: number, key: string, position: number) {
    transaction(this.db, () => {
      if (this.get(id).mode !== 'SNAPSHOT') throw bad('只有定时同步模式的数据可以排序')
      const keys = (this.db.prepare('SELECT row_key FROM api_row WHERE api_id = ? ORDER BY sort IS NULL, sort, position')
        .all(id) as { row_key: string }[]).map(row => row.row_key)
      const from = keys.indexOf(key)
      if (from < 0) throw notFound('记录不存在')
      keys.splice(from, 1)
      keys.splice(Math.min(Math.max(position, 1), keys.length + 1) - 1, 0, key)
      const update = this.db.prepare('UPDATE api_row SET sort = ? WHERE api_id = ? AND row_key = ?')
      keys.forEach((rowKey, index) => update.run(index + 1, id, rowKey))
    })
  }

  resetSort(id: number) {
    if (this.get(id).mode !== 'SNAPSHOT') throw bad('只有定时同步模式的数据可以排序')
    this.db.prepare('UPDATE api_row SET sort = NULL WHERE api_id = ?').run(id)
  }

  // ---- open queries ----

  async query(api: Api, input: JsonObject): Promise<Row[]> {
    return api.mode === 'REALTIME' ? this.realtime(api, input) : this.local(api, input)
  }

  async queryPage(api: Api, input: JsonObject, page: number, pageSize: number): Promise<PageResult> {
    if (api.mode !== 'REALTIME') return this.localPage(api, input, page, pageSize)
    const { sql, values, pool } = this.realtimeStatement(api, input)
    const source = `(${sql}) AS databridge_source`
    const count = await runQuery(pool, `SELECT count(*)::text AS total FROM ${source}`, values,
      { timeoutSeconds: api.timeoutSeconds, maxRows: 1 })
    const total = Number(count.rows[0].total)
    if (!Number.isSafeInteger(total)) throw new HttpError(422, '结果总数过大，无法分页')
    const result = await runQuery(pool, `SELECT * FROM ${source} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values,
      { timeoutSeconds: api.timeoutSeconds, maxRows: pageSize })
    return { rows: result.rows, total, page, pageSize }
  }

  /** Runs the API's SQL with request parameters; used by open calls and by the editor's test button. */
  async realtime(api: Pick<Api, 'datasourceId' | 'sql' | 'params' | 'timeoutSeconds' | 'maxRows'>, input: JsonObject,
                 options: { truncate?: boolean } = {}): Promise<Row[]> {
    const { sql, values, pool } = this.realtimeStatement(api, input)
    const result = await runQuery(pool, sql, values, api)
    if (result.truncated && !options.truncate) throw new HttpError(422, `查询结果超过最大行数 ${api.maxRows}`)
    return result.rows
  }

  private realtimeStatement(api: Pick<Api, 'datasourceId' | 'sql' | 'params'>, input: JsonObject) {
    const unknown = Object.keys(input).find(key => !api.params.some(param => param.name === key))
    if (unknown) throw bad(`未定义的参数 ${unknown}`)
    const parsed = parseSql(api.sql!)
    const values = parsed.names.map(name => {
      const param = api.params.find(p => p.name === name)!
      const value = convertOptional(own(input, name), param)
      if (param.required && (value === null || value === '')) throw bad(`缺少参数 ${name}`)
      return toPg(value)
    })
    const sql = positional(parsed, name => PG_TYPES[api.params.find(p => p.name === name)!.type])
    const { pool } = this.sources.pool(api.datasourceId!)
    return { sql, values, pool }
  }

  /** Equality filters over stored rows, compared by field type ("1.50" matches 1.5; null matches null). */
  private local(api: Api, input: JsonObject): Row[] {
    const matches = this.localMatcher(api, input)
    const rows: Row[] = []
    const statement = this.db.prepare('SELECT data, remark FROM api_row WHERE api_id = ? ORDER BY sort IS NULL, sort, position')
    for (const { data, remark } of statement.iterate(api.id) as Iterable<{ data: string; remark: string }>) {
      const row = parse(data) as Row
      if (!matches(row)) continue
      if (rows.length === api.maxRows) throw new HttpError(422, `查询结果超过最大行数 ${api.maxRows}`)
      rows.push(withRemark(row, remark))
    }
    return rows
  }

  private localPage(api: Api, input: JsonObject, page: number, pageSize: number): PageResult {
    const matches = this.localMatcher(api, input)
    const rows: Row[] = []
    let total = 0
    const offset = (page - 1) * pageSize
    const statement = this.db.prepare('SELECT data, remark FROM api_row WHERE api_id = ? ORDER BY sort IS NULL, sort, position')
    for (const { data, remark } of statement.iterate(api.id) as Iterable<{ data: string; remark: string }>) {
      const row = parse(data) as Row
      if (!matches(row)) continue
      if (total >= offset && rows.length < pageSize) rows.push(withRemark(row, remark))
      total++
    }
    return { rows, total, page, pageSize }
  }

  private localMatcher(api: Api, input: JsonObject): (row: Row) => boolean {
    const filters = Object.keys(input).map(name => {
      const field = api.fields.find(f => f.name === name)
      if (!field || !api.filters.includes(name)) throw bad(`不支持按 ${name} 过滤`)
      const value = convertOptional(own(input, name), field)
      return { field, want: value === null ? null : identity(value) }
    })
    return (row: Row) => filters.every(({ field, want }) => {
      const value = own(row, field.name)
      if (want === null) return value === undefined || value === null
      if (value === undefined || value === null) return false
      try {
        return identity(convertOptional(value, field)) === want
      } catch {
        return false
      }
    })
  }
}
