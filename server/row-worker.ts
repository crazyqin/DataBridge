import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { AUTH_PREVIEW_BYTES } from './auth-diagnostics.ts'
import { HttpError } from './errors.ts'
import { parse, type JsonObject } from './json.ts'
import { rowMatches, rowText, type RowFilter } from './row-data.ts'

// Reads stored rows on a separate thread with its own read-only connection, so scanning and serialising
// large tables never blocks request handling. Each task runs in one read transaction and therefore sees
// a single committed generation, even while a sync writes the next one.

export interface OpenTask {
  kind: 'open'; apiId: number; signature: string; filters: RowFilter[]; maxRows: number; page?: number; pageSize?: number
}
/** chunks hold the JSON rows of the data array, comma separated; preview holds the first rows for the call log. */
export interface OpenResult { chunks: Uint8Array[]; count: number; total?: number; preview: string[] }
export interface ListTask { kind: 'list'; apiId: number; page: number; pageSize: number; search: string }
export interface ListResult {
  items: { key: string; version: number; sorted: boolean; position: number; remark: string; data: string }[]
  total: number; allTotal: number
}
export type RowTask = OpenTask | ListTask

const ORDER = 'ORDER BY r.sort IS NULL, r.sort, r.position'
const CHUNK_CHARS = 1 << 20

const db = new DatabaseSync((workerData as { dbFile: string }).dbFile, { readOnly: true })
db.exec('PRAGMA busy_timeout = 5000')

function read<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    return fn()
  } finally {
    db.exec('COMMIT')
  }
}

function state(apiId: number) {
  const row = db.prepare('SELECT row_generation AS generation, row_filters AS indexed FROM api WHERE id = ?').get(apiId) as
    { generation: number; indexed: string | null } | undefined
  if (!row) throw new HttpError(404, 'API 不存在')
  return row
}

/** The rows of a generation that match every filter, found through the filter index from its most selective filter. */
function matching(apiId: number, generation: number, filters: RowFilter[]) {
  if (!filters.length) {
    const from = 'FROM api_row r WHERE r.api_id = ? AND r.generation = ?'
    return { rows: from, count: from, args: [apiId, generation] }
  }
  const size = (filter: RowFilter) => Number(db.prepare(`SELECT count(*) AS n FROM api_row_filter
    WHERE api_id = ? AND generation = ? AND name = ? AND value = ?`).get(apiId, generation, filter.name, filter.key)!.n)
  const sizes = new Map(filters.length > 1 ? filters.map(filter => [filter, size(filter)]) : [])
  const [first, ...rest] = [...filters].sort((a, b) => (sizes.get(a) ?? 0) - (sizes.get(b) ?? 0))
  const where = ['f0.api_id = ? AND f0.generation = ? AND f0.name = ? AND f0.value = ?', ...rest.map(() =>
    `EXISTS (SELECT 1 FROM api_row_filter f WHERE f.api_id = f0.api_id AND f.generation = f0.generation
      AND f.name = ? AND f.value = ? AND f.row_key = f0.row_key)`)].join(' AND ')
  return {
    rows: `FROM api_row_filter f0 CROSS JOIN api_row r ON r.api_id = f0.api_id AND r.generation = f0.generation
      AND r.row_key = f0.row_key WHERE ${where}`,
    count: `FROM api_row_filter f0 WHERE ${where}`,
    args: [apiId, generation, first.name, first.key, ...rest.flatMap(filter => [filter.name, filter.key])],
  }
}

/** Collects row JSON into UTF-8 chunks that are transferred, not copied, to the main thread. */
class Output {
  readonly chunks: Uint8Array[] = []
  readonly preview: string[] = []
  count = 0
  private text = ''
  private previewSize = 0
  private readonly encoder = new TextEncoder()

  add(data: string, remark: string) {
    const row = rowText(data, remark)
    // Twice the preview size, so the main thread's own measure of the rows never runs short.
    if (this.previewSize < 2 * AUTH_PREVIEW_BYTES) {
      this.preview.push(row)
      this.previewSize += row.length
    }
    this.text += (this.count ? ',' : '') + row
    this.count++
    if (this.text.length >= CHUNK_CHARS) this.flush()
  }

  flush() {
    if (this.text) this.chunks.push(this.encoder.encode(this.text))
    this.text = ''
  }
}

function open(task: OpenTask): OpenResult {
  return read(() => {
    const { generation, indexed } = state(task.apiId)
    const paged = task.page !== undefined && task.pageSize !== undefined
    const offset = paged ? (task.page! - 1) * task.pageSize! : 0
    const tooMany = () => new HttpError(422, `查询结果超过最大行数 ${task.maxRows}`)
    const output = new Output()
    let total: number | undefined
    if (!task.filters.length || indexed === task.signature) {
      const query = matching(task.apiId, generation, task.filters)
      if (paged) total = Number(db.prepare(`SELECT count(*) AS n ${query.count}`).get(...query.args)!.n)
      const rows = db.prepare(`SELECT r.data, r.remark ${query.rows} ${ORDER} LIMIT ? OFFSET ?`)
        .iterate(...query.args, paged ? task.pageSize! : task.maxRows + 1, offset) as Iterable<{ data: string; remark: string }>
      for (const row of rows) {
        if (!paged && output.count === task.maxRows) throw tooMany()
        output.add(row.data, row.remark)
      }
    } else {
      // The filter index is still being rebuilt after a filter change: compare every row instead.
      let matched = 0
      const rows = db.prepare(`SELECT r.data, r.remark FROM api_row r WHERE r.api_id = ? AND r.generation = ? ${ORDER}`)
        .iterate(task.apiId, generation) as Iterable<{ data: string; remark: string }>
      for (const row of rows) {
        if (!rowMatches(parse(row.data) as JsonObject, task.filters)) continue
        if (!paged && matched === task.maxRows) throw tooMany()
        if (matched >= offset && (!paged || output.count < task.pageSize!)) output.add(row.data, row.remark)
        matched++
      }
      if (paged) total = matched
    }
    output.flush()
    return { chunks: output.chunks, count: output.count, total, preview: output.preview }
  })
}

function list(task: ListTask): ListResult {
  return read(() => {
    const { generation } = state(task.apiId)
    const offset = (task.page - 1) * task.pageSize
    const allTotal = Number(db.prepare('SELECT count(*) AS n FROM api_row WHERE api_id = ? AND generation = ?').get(task.apiId, generation)!.n)
    type Stored = { row_key: string; data: string; remark: string; version: number; sort: number | null; position: number }
    const item = (row: Stored, position: number) =>
      ({ key: row.row_key, version: row.version, sorted: row.sort !== null, position, remark: row.remark, data: row.data })
    if (!task.search) {
      const rows = db.prepare(`SELECT r.row_key, r.data, r.remark, r.version, r.sort FROM api_row r
        WHERE r.api_id = ? AND r.generation = ? ${ORDER} LIMIT ? OFFSET ?`).all(task.apiId, generation, task.pageSize, offset) as Stored[]
      return { items: rows.map((row, index) => item(row, offset + index + 1)), total: allTotal, allTotal }
    }
    const pattern = `%${task.search.replace(/[\\%_]/g, '\\$&')}%`
    const sql = `WITH ordered AS (
      SELECT row_key, data, remark, version, sort, row_number() OVER (ORDER BY sort IS NULL, sort, position) AS position
      FROM api_row WHERE api_id = ? AND generation = ?
    ) SELECT * FROM ordered WHERE EXISTS (SELECT 1 FROM json_each(ordered.data)
      WHERE CAST(value AS TEXT) LIKE ? ESCAPE '\\') OR remark LIKE ? ESCAPE '\\'`
    const args = [task.apiId, generation, pattern, pattern]
    const total = Number(db.prepare(`SELECT count(*) AS n FROM (${sql})`).get(...args)!.n)
    const rows = db.prepare(`${sql} ORDER BY position LIMIT ? OFFSET ?`).all(...args, task.pageSize, offset) as Stored[]
    return { items: rows.map(row => item(row, row.position)), total, allTotal }
  })
}

parentPort!.on('message', (task: RowTask) => {
  try {
    if (task.kind === 'open') {
      const result = open(task)
      parentPort!.postMessage({ result }, result.chunks.map(chunk => chunk.buffer as ArrayBuffer))
    } else {
      parentPort!.postMessage({ result: list(task) })
    }
  } catch (error) {
    if (!(error instanceof HttpError)) console.error('Stored row read failed:', error)
    parentPort!.postMessage({ error: error instanceof HttpError
      ? { status: error.status, message: error.message } : { status: 500, message: '服务器内部错误' } })
  }
})
