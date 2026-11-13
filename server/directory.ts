import { Cron } from 'croner'
import { encrypt, decrypt, type Config } from './config.ts'
import { now, transaction, type Db } from './db.ts'
import { bad, conflict, forbidden, HttpError } from './errors.ts'
import { body, flag, integer, list, text } from './input.ts'
import type { JsonObject } from './json.ts'
import { runQuery, SourceError } from './query.ts'
import { parseSql, positional } from './sql.ts'
import type { Sources } from './sources.ts'
import type { QueryIdentity } from './external-auth.ts'
import { matchesRule, type AccessDecision, type AccessPolicy, type StaffMember } from './access.ts'

export interface DirectoryConfig {
  datasourceId: number; sql: string; cron: string; timezone: string; scheduled: boolean
  timeoutSeconds: number; maxRows: number; changeThreshold: number
  mapping: { staffNo: string; name: string; departments: string[]; employmentUnified: string; employmentLocal: string; posts: string[] }
}
interface State { config: string; version: number; snapshot_version: number; synced_at: string | null }
interface SyncRow {
  id: number; status: string; candidate: string | null; config_version: number; source_version: number; baseline_version: number
}

export function normalizeStaff(rows: JsonObject[], mapping: DirectoryConfig['mapping']): StaffMember[] {
  const ids = new Set<string>()
  return rows.map((row, index) => {
    const read = (column: string, required = false): string | null => {
      if (!Object.hasOwn(row, column)) throw bad(`同步结果缺少映射列 ${column}`)
      const value = row[column]
      if (value !== null && typeof value !== 'string') throw bad(`第 ${index + 1} 行 ${column} 必须是文本，请在 SQL 中转换类型`)
      const result = typeof value === 'string' ? value.trim() : ''
      if (result.length > 300 || /[\x00-\x1f]/.test(result)) throw bad(`第 ${index + 1} 行 ${column} 文本无效`)
      if (required && !result) throw bad(`第 ${index + 1} 行 ${column} 不能为空`)
      return result || null
    }
    const staffNo = read(mapping.staffNo, true)!
    if (ids.has(staffNo)) throw bad('同步结果工号重复，已保留原目录')
    ids.add(staffNo)
    return { staffNo, name: read(mapping.name, true)!, department: mapping.departments.map(column => read(column)),
      employmentUnified: read(mapping.employmentUnified), employmentLocal: read(mapping.employmentLocal),
      posts: [...new Set(mapping.posts.map(column => read(column)).filter((value): value is string => value !== null))] }
  })
}

export class Directory {
  private job?: Cron
  private running = false
  private db: Db
  private sources: Sources
  private config: Config
  constructor(db: Db, sources: Sources, config: Config) { this.db = db; this.sources = sources; this.config = config }

  private state() { return this.db.prepare('SELECT * FROM staff_directory WHERE id = 1').get() as State | undefined }
  get() {
    const state = this.state()
    return { config: state ? JSON.parse(decrypt(this.config.secretKey, state.config)) as DirectoryConfig : null,
      version: state?.version ?? 0, snapshotVersion: state?.snapshot_version ?? 0, syncedAt: state?.synced_at ?? null,
      count: Number(this.db.prepare('SELECT count(*) AS n FROM staff_member').get()!.n), running: this.running,
      nextSyncAt: this.job?.nextRun()?.toISOString() ?? null }
  }

  validate(input: JsonObject): DirectoryConfig {
    const mapping = body(input.mapping ?? null)
    const columns = (key: string, maximum: number) => {
      const values = list(mapping, key, key)
      if (!values.length || values.length > maximum) throw bad(`请配置 1 到 ${maximum} 个${key}映射`)
      return values.map(value => text({ value }, 'value', '结果列名', { max: 100 }))
    }
    const result: DirectoryConfig = {
      datasourceId: integer(input, 'datasourceId', '数据源', 1, Number.MAX_SAFE_INTEGER),
      sql: text(input, 'sql', '人员同步 SQL', { max: 100_000 }),
      cron: text({ cron: input.cron ?? '0 0 2 * * *' }, 'cron', '同步 Cron', { max: 100 }),
      timezone: text({ timezone: input.timezone ?? this.config.timezone }, 'timezone', '时区', { max: 100 }),
      scheduled: flag(input, 'scheduled', '定时同步', true),
      timeoutSeconds: integer(input, 'timeoutSeconds', '超时秒数', 1, 120, 60),
      maxRows: integer(input, 'maxRows', '最大人数', 1, 1_000_000, 100_000),
      changeThreshold: integer(input, 'changeThreshold', '变化阈值百分比', 1, 100, 20),
      mapping: {
        staffNo: text(mapping, 'staffNo', '工号列', { max: 100 }), name: text(mapping, 'name', '姓名列', { max: 100 }),
        employmentUnified: text(mapping, 'employmentUnified', '统一用工方式列', { max: 100 }),
        employmentLocal: text(mapping, 'employmentLocal', '本地用工方式列', { max: 100 }),
        departments: columns('departments', 4), posts: columns('posts', 2),
      },
    }
    const mapped = [result.mapping.staffNo, result.mapping.name, result.mapping.employmentUnified, result.mapping.employmentLocal,
      ...result.mapping.departments, ...result.mapping.posts]
    if (new Set(mapped).size !== mapped.length) throw bad('字段映射不能重复')
    if (parseSql(result.sql).names.length) throw bad('人员同步 SQL 不能包含请求或身份参数')
    this.sources.get(result.datasourceId)
    try {
      new Intl.DateTimeFormat('en', { timeZone: result.timezone })
      if (!new Cron(result.cron, { paused: true, timezone: result.timezone }).nextRun()) throw new Error()
    } catch { throw bad('同步 Cron 或时区无效') }
    return result
  }

  save(input: JsonObject) {
    const settings = this.validate(input)
    const expected = integer(input, 'version', '目录配置版本', 0, Number.MAX_SAFE_INTEGER)
    transaction(this.db, () => {
      if ((this.state()?.version ?? 0) !== expected) throw conflict('目录配置已修改，请刷新')
      this.db.prepare(`INSERT INTO staff_directory (id, config) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET config = excluded.config, version = version + 1`).run(encrypt(this.config.secretKey, JSON.stringify(settings)))
      this.db.prepare("UPDATE directory_sync SET status = 'SUPERSEDED', candidate = NULL WHERE status = 'PENDING'").run()
    })
    this.schedule()
    return this.get()
  }

  start() {
    this.db.prepare("UPDATE directory_sync SET status = 'FAILED', finished_at = ?, error = '服务重启，同步中断', candidate = NULL WHERE status = 'RUNNING'").run(now())
    this.schedule()
  }
  stop() { this.job?.stop(); this.job = undefined }
  private schedule() {
    this.stop()
    const state = this.get()
    if (state.config?.scheduled) this.job = new Cron(state.config.cron, { timezone: state.config.timezone, protect: true },
      async () => { await this.sync('SCHEDULED').catch(() => {}) })
  }

  async preview(input: JsonObject) {
    const settings = this.validate(input)
    const { pool } = this.sources.pool(settings.datasourceId)
    const result = await runQuery(pool, positional(parseSql(settings.sql), () => 'text'), [], { ...settings, maxRows: 20 })
    this.checkColumns(result.columns, settings.mapping)
    return { rows: normalizeStaff(result.rows, settings.mapping), truncated: result.truncated }
  }

  private checkColumns(columns: string[], mapping: DirectoryConfig['mapping']) {
    const required = [mapping.staffNo, mapping.name, mapping.employmentUnified, mapping.employmentLocal, ...mapping.departments, ...mapping.posts]
    const missing = required.find(column => !columns.includes(column))
    if (missing) throw bad(`同步结果缺少映射列 ${missing}`)
  }

  async sync(trigger = 'MANUAL') {
    if (this.running) throw conflict('人员目录正在同步')
    const state = this.get(), settings = state.config
    if (!settings) throw bad('请先配置人员目录')
    this.running = true
    let logId: number | undefined
    try {
      const source = this.sources.get(settings.datasourceId)
      logId = Number(this.db.prepare(`INSERT INTO directory_sync (started_at, trigger, status, config_version, source_version, baseline_version)
        VALUES (?, ?, 'RUNNING', ?, ?, ?)`).run(now(), trigger, state.version, source.version, state.snapshotVersion).lastInsertRowid)
      this.db.prepare("UPDATE directory_sync SET status = 'SUPERSEDED', candidate = NULL WHERE status = 'PENDING'").run()
      const result = await runQuery(this.sources.pool(settings.datasourceId).pool, positional(parseSql(settings.sql), () => 'text'), [], settings)
      this.checkColumns(result.columns, settings.mapping)
      if (result.truncated) throw bad('人员数量超过最大行数，已保留原目录')
      const people = normalizeStaff(result.rows, settings.mapping)
      if (!people.length && !state.snapshotVersion) throw bad('首次同步结果为空，尚未建立目录')
      const old = new Map(this.all().map(person => [person.staffNo, person]))
      const ids = new Set(people.map(person => person.staffNo))
      const added = people.filter(person => !old.has(person.staffNo)).length
      const removed = [...old.keys()].filter(id => !ids.has(id)).length
      const updated = people.filter(person => old.has(person.staffNo) && JSON.stringify(old.get(person.staffNo)) !== JSON.stringify(person)).length
      const ratio = old.size ? Math.max(Math.abs(people.length - old.size), added, removed) / old.size * 100 : people.length ? 100 : 0
      const blocked = state.snapshotVersion > 0 && (!people.length || ratio > settings.changeThreshold)
      transaction(this.db, () => {
        this.checkVersion(state.version, source.version, state.snapshotVersion)
        this.db.prepare('UPDATE directory_sync SET status = ?, finished_at = ?, summary = ?, candidate = ? WHERE id = ?')
          .run('PENDING', now(), JSON.stringify({ before: old.size, after: people.length, added, removed, updated, changePercent: ratio }), JSON.stringify(people), logId!)
        if (!blocked) this.publish(logId!, false)
      })
      return { id: logId, status: blocked ? 'PENDING' : 'SUCCESS' }
    } catch (error) {
      if (logId) this.db.prepare("UPDATE directory_sync SET status = 'FAILED', finished_at = ?, error = ?, candidate = NULL WHERE id = ?")
        .run(now(), error instanceof SourceError ? `${error.message}：${error.detail}` : (error as Error).message, logId)
      throw error
    } finally { this.running = false }
  }

  private checkVersion(configVersion: number, sourceVersion: number, baselineVersion: number) {
    const current = this.get()
    if (!current.config || current.version !== configVersion || current.snapshotVersion !== baselineVersion
      || this.sources.get(current.config.datasourceId).version !== sourceVersion) throw conflict('目录或数据源已变更，请重新同步')
  }
  private publish(id: number, forced: boolean) {
    const row = this.db.prepare('SELECT * FROM directory_sync WHERE id = ?').get(id) as SyncRow | undefined
    if (!row || row.status !== 'PENDING' || !row.candidate) throw conflict('该批次不是可覆盖的候选数据，请重新同步')
    this.checkVersion(row.config_version, row.source_version, row.baseline_version)
    const people = JSON.parse(row.candidate) as StaffMember[]
    this.db.prepare('DELETE FROM staff_member').run()
    const insert = this.db.prepare('INSERT INTO staff_member (staff_no, data) VALUES (?, ?)')
    for (const person of people) insert.run(person.staffNo, JSON.stringify(person))
    this.db.prepare('UPDATE staff_directory SET snapshot_version = snapshot_version + 1, synced_at = ? WHERE id = 1').run(now())
    this.db.prepare('UPDATE directory_sync SET status = ?, candidate = NULL, finished_at = ? WHERE id = ?').run(forced ? 'FORCED' : 'SUCCESS', now(), id)
  }
  force(id: number) {
    if (this.running) throw conflict('目录正在同步，请稍后覆盖')
    transaction(this.db, () => this.publish(id, true))
    return this.get()
  }
  history(before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT id, started_at AS startedAt, finished_at AS finishedAt, trigger, status, summary, error FROM directory_sync WHERE id < ? ORDER BY id DESC LIMIT 50')
      .all(before).map(row => ({ ...row, summary: row.summary ? JSON.parse(String(row.summary)) : null }))
  }
  candidate(id: number, page = 1) {
    const row = this.db.prepare('SELECT candidate FROM directory_sync WHERE id = ? AND status = ?').get(id, 'PENDING')
    if (!row?.candidate) throw bad('该批次没有待覆盖数据')
    const people = JSON.parse(String(row.candidate)) as StaffMember[]
    const previous = new Map(this.all().map(person => [person.staffNo, person]))
    const ids = new Set(people.map(person => person.staffNo))
    const changes = people.flatMap<{ kind: string; person: StaffMember; previous: StaffMember | null }>(person => !previous.has(person.staffNo) ? [{ kind: '新增', person, previous: null }]
      : JSON.stringify(previous.get(person.staffNo)) !== JSON.stringify(person) ? [{ kind: '变更', person, previous: previous.get(person.staffNo)! }] : [])
    changes.push(...[...previous.values()].filter(person => !ids.has(person.staffNo)).map(person => ({ kind: '移除', person, previous: person })))
    return { total: changes.length, items: changes.slice((page - 1) * 50, page * 50) }
  }
  private all(): StaffMember[] { return this.db.prepare('SELECT data FROM staff_member ORDER BY staff_no').all().map(row => JSON.parse(String(row.data))) }
  members(search = '', page = 1) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`
    const where = "staff_no LIKE ? ESCAPE '\\' OR json_extract(data, '$.name') LIKE ? ESCAPE '\\'"
    return { total: Number(this.db.prepare(`SELECT count(*) AS n FROM staff_member WHERE ${where}`).get(pattern, pattern)!.n),
      items: this.db.prepare(`SELECT data FROM staff_member WHERE ${where} ORDER BY staff_no LIMIT 50 OFFSET ?`).all(pattern, pattern, (page - 1) * 50)
        .map(row => JSON.parse(String(row.data)) as StaffMember) }
  }
  options() {
    const departments = new Map<string, (string | null)[]>(), unified = new Set<string>(), local = new Set<string>(), posts = new Set<string>()
    for (const person of this.all()) {
      person.department.forEach((part, i) => { if (part) { const path = person.department.slice(0, i + 1); departments.set(JSON.stringify(path), path) } })
      if (person.employmentUnified) unified.add(person.employmentUnified)
      if (person.employmentLocal) local.add(person.employmentLocal)
      person.posts.forEach(post => posts.add(post))
    }
    return { departments: [...departments.values()], employmentUnified: [...unified].sort(), employmentLocal: [...local].sort(), posts: [...posts].sort() }
  }

  decide(policy: AccessPolicy, staffNo: string | null, policyVersion: number | null = null): AccessDecision {
    const decision = (allowed: boolean, reason: string, rule: string | null = null): AccessDecision =>
      ({ allowed, reason, rule, staffNo, directoryVersion: this.state()?.snapshot_version ?? 0, policyVersion })
    if (!policy.enabled) return decision(true, '未开启人员授权')
    if (!this.state()?.snapshot_version) return decision(false, '人员目录尚未建立')
    const row = staffNo ? this.db.prepare('SELECT data FROM staff_member WHERE staff_no = ?').get(staffNo) : undefined
    if (!row) return decision(false, '工号不在当前有效人员目录')
    const person = JSON.parse(String(row.data)) as StaffMember
    const deny = policy.deny.findIndex(rule => matchesRule(person, rule))
    if (deny >= 0) return decision(false, '命中拒绝规则', `deny:${deny + 1}`)
    const allow = policy.allow.findIndex(rule => matchesRule(person, rule))
    return allow >= 0 ? decision(true, '命中允许规则', `allow:${allow + 1}`) : decision(false, '未命中允许规则')
  }
  authorize(policy: AccessPolicy, identity: QueryIdentity | undefined, version: number | null, diagnostic?: (decision: AccessDecision) => void) {
    const value = identity?.[policy.staffBinding]
    if (policy.enabled && (typeof value !== 'string' || !value.trim())) throw new HttpError(502, '身份服务未提供有效工号')
    const decision = this.decide(policy, typeof value === 'string' ? value.trim() : null, version)
    diagnostic?.(decision)
    if (!decision.allowed) throw forbidden('没有当前接口的调用权限')
    return decision
  }
}
