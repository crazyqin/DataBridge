import { transaction, type Db } from './db.ts'
import { bad, notFound } from './errors.ts'
import { parse, stringify } from './json.ts'
import type { ExternalAuthTrace } from './auth-diagnostics.ts'

export interface LogEntry {
  requestId: string
  at: string
  apiId: number | null
  mode: string | null
  elapsedMs: number
  rowCount: number
  ok: boolean
  error: string | null
  externalAuthTrace?: ExternalAuthTrace
}

export interface LogQuery { apiId?: string; ok?: string; from?: string; to?: string; before?: string; limit?: string }

function instant(value: string, label: string): string {
  const time = new Date(value)
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value) || Number.isNaN(time.getTime())) throw bad(`${label}需要带时区的 ISO 8601 时间`)
  return time.toISOString()
}

export class Logs {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  write(entry: LogEntry) {
    transaction(this.db, () => {
      const result = this.db.prepare(`INSERT INTO request_log (request_id, at, api_id, mode, elapsed_ms, row_count, ok, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.requestId, entry.at, entry.apiId, entry.mode, Math.round(entry.elapsedMs),
        entry.rowCount, entry.ok ? 1 : 0, entry.error)
      if (entry.externalAuthTrace) this.db.prepare('INSERT INTO request_auth_log (log_id, detail) VALUES (?, ?)')
        .run(result.lastInsertRowid, stringify(entry.externalAuthTrace))
    })
  }

  /** Newest first; pass the last item's id as `before` to get the next page. */
  list(query: LogQuery) {
    const where: string[] = []
    const args: (string | number)[] = []
    if (query.apiId) { where.push('api_id = ?'); args.push(Number(query.apiId)) }
    if (query.ok === 'true' || query.ok === 'false') { where.push('ok = ?'); args.push(query.ok === 'true' ? 1 : 0) }
    if (query.from) { where.push('at >= ?'); args.push(instant(query.from, '开始时间')) }
    if (query.to) { where.push('at <= ?'); args.push(instant(query.to, '结束时间')) }
    if (query.before) { where.push('id < ?'); args.push(Number(query.before)) }
    if (args.some(arg => typeof arg === 'number' && !Number.isSafeInteger(arg))) throw bad('查询条件无效')
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500)
    const items = this.db.prepare(`SELECT id, request_id AS requestId, at, api_id AS apiId, mode, elapsed_ms AS elapsedMs,
      row_count AS rowCount, ok = 1 AS ok, error,
      EXISTS (SELECT 1 FROM request_auth_log WHERE log_id = request_log.id) AS hasExternalAuth
      FROM request_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC LIMIT ?`).all(...args, limit) as (Omit<LogEntry, 'externalAuthTrace' | 'ok'> & { id: number; ok: number; hasExternalAuth: number })[]
    return {
      items: items.map(item => ({ ...item, ok: item.ok === 1, hasExternalAuth: item.hasExternalAuth === 1 })),
      nextBefore: items.length === limit ? items[items.length - 1].id : null,
    }
  }

  externalAuthDetail(logId: number): ExternalAuthTrace {
    const row = this.db.prepare('SELECT detail FROM request_auth_log WHERE log_id = ?').get(logId) as { detail: string } | undefined
    if (!row) throw notFound('该日志没有外部身份验证详情')
    return parse(row.detail) as unknown as ExternalAuthTrace
  }

  prune(retentionDays: number) {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    this.db.prepare('DELETE FROM request_log WHERE at < ?').run(cutoff)
  }
}
