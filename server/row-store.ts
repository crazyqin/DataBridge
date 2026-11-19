import { availableParallelism } from 'node:os'
import type { StatementSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { transaction, type Db } from './db.ts'
import { HttpError } from './errors.ts'
import { parse, type JsonObject } from './json.ts'
import { filterKey, filterSignature } from './row-data.ts'
import type { ListResult, ListTask, OpenResult, OpenTask, RowTask } from './row-worker.ts'
import type { Field } from './values.ts'

// Stored rows are versioned by generation. A sync writes a complete new generation in short transactions
// and then switches api.row_generation to it, so neither readers nor other writers wait for a large snapshot;
// superseded generations are deleted in the background. api_row_filter holds each row's filter keys.

export interface IndexedApi { id: number; fields: Field[]; filters: string[] }

const READERS = Math.max(1, Math.min(4, availableParallelism() - 1))
const READER_IDLE_MS = 60_000

export const pause = () => new Promise<void>(resolve => setImmediate(resolve))

export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/**
 * Sizes write transactions to take about TARGET_MS, so log writes and other requests are not held up. The cost
 * per row varies a lot: appending in index order is cheap, while index entries in random order touch a page each.
 */
class Batch {
  private static readonly TARGET_MS = 15
  size = 500

  run<T>(db: Db, work: (size: number) => T): T {
    const started = performance.now()
    const result = transaction(db, () => work(this.size))
    const factor = Math.min(2, Math.max(0.5, Batch.TARGET_MS / Math.max(performance.now() - started, 1)))
    this.size = Math.round(Math.min(20_000, Math.max(50, this.size * factor)))
    return result
  }
}

/** The indexes 0..count-1 in sorted order, sorted in slices so that a large snapshot never blocks requests for long. */
export async function sortedOrder(count: number, by: (a: number, b: number) => number): Promise<Uint32Array> {
  const RUN = 2048
  let order = new Uint32Array(count)
  for (let index = 0; index < count; index++) order[index] = index
  for (let start = 0; start < count; start += RUN) {
    order.subarray(start, start + RUN).sort(by)
    if (start % (RUN * 4) === 0) await pause()
  }
  // Bottom-up merge of the sorted runs.
  let merged = new Uint32Array(count)
  let steps = 0
  for (let width = RUN; width < count; width *= 2) {
    for (let left = 0; left < count; left += 2 * width) {
      const middle = Math.min(left + width, count), right = Math.min(left + 2 * width, count)
      let i = left, j = middle
      for (let k = left; k < right; k++) {
        merged[k] = j >= right || (i < middle && by(order[i], order[j]) <= 0) ? order[i++] : order[j++]
        if (++steps % 32_768 === 0) await pause()
      }
    }
    ;[order, merged] = [merged, order]
  }
  return order
}

/** The filter key of a row for each of the API's filters, in filter order. */
export function filterKeys(api: IndexedApi, row: JsonObject): string[] {
  return api.filters.map(name => filterKey(Object.hasOwn(row, name) ? row[name] : undefined, api.fields.find(field => field.name === name)!))
}

export class RowStore {
  private readonly db: Db
  private readonly reader: RowReader
  /** API id → generation being written by a sync or index rebuild. */
  private readonly building = new Map<number, number>()
  private readonly collecting = new Set<number>()
  private readonly collectAgain = new Set<number>()
  private readonly statements = new Map<string, StatementSync>()
  private stopped = false

  constructor(db: Db, dbFile: string) {
    this.db = db
    this.reader = new RowReader(dbFile)
  }

  generation(apiId: number): number {
    const row = this.db.prepare('SELECT row_generation AS generation FROM api WHERE id = ?').get(apiId) as { generation: number } | undefined
    if (!row) throw new HttpError(404, 'API 不存在')
    return row.generation
  }

  /** Whether a sync or index rebuild is writing the API's next generation. */
  writing(apiId: number): boolean {
    return this.building.has(apiId)
  }

  /** Whether the filter index of the current generation matches the API's filter configuration. */
  indexed(api: IndexedApi): boolean {
    const row = this.db.prepare('SELECT row_filters AS indexed FROM api WHERE id = ?').get(api.id) as { indexed: string | null } | undefined
    return row?.indexed === filterSignature(api.fields, api.filters)
  }

  open(task: Omit<OpenTask, 'kind'>): Promise<OpenResult> {
    return this.reader.run({ kind: 'open', ...task })
  }

  list(task: Omit<ListTask, 'kind'>): Promise<ListResult> {
    return this.reader.run({ kind: 'list', ...task })
  }

  /** Prepared once: the per-row paths run these thousands of times. */
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  // ---- filter index; these run inside the caller's transaction ----

  index(api: IndexedApi, generation: number, key: string, row: JsonObject) {
    const insert = this.statement('INSERT OR REPLACE INTO api_row_filter (api_id, generation, name, value, row_key) VALUES (?, ?, ?, ?, ?)')
    filterKeys(api, row).forEach((value, index) => insert.run(api.id, generation, api.filters[index], value, key))
  }

  unindex(api: IndexedApi, generation: number, key: string) {
    const remove = this.statement('DELETE FROM api_row_filter WHERE api_id = ? AND generation = ? AND name = ? AND row_key = ?')
    for (const name of api.filters) remove.run(api.id, generation, name, key)
  }

  /** Rebuilds the index of the current generation in place; used for manual data, which is edited row by row. */
  reindexInPlace(api: IndexedApi) {
    const generation = this.generation(api.id)
    this.db.prepare('DELETE FROM api_row_filter WHERE api_id = ? AND generation = ?').run(api.id, generation)
    const rows = this.db.prepare('SELECT row_key, data FROM api_row WHERE api_id = ? AND generation = ?').iterate(api.id, generation)
    for (const row of rows as Iterable<{ row_key: string; data: string }>) this.index(api, generation, row.row_key, parse(row.data) as JsonObject)
    this.db.prepare('UPDATE api SET row_filters = ? WHERE id = ?').run(filterSignature(api.fields, api.filters), api.id)
  }

  /** Queries fall back to comparing every row until a rebuilt index is switched in. */
  markStale(apiId: number) {
    this.db.prepare('UPDATE api SET row_filters = NULL WHERE id = ?').run(apiId)
  }

  // ---- generations ----

  private nextGeneration(apiId: number): number {
    const used = (table: string) => (this.db.prepare(`SELECT max(generation) AS n FROM ${table} WHERE api_id = ?`).get(apiId) as { n: number | null }).n ?? 0
    return Math.max(this.generation(apiId), used('api_row'), used('api_row_filter')) + 1
  }

  /** Switches to an empty generation, e.g. when an API changes mode; runs inside the caller's transaction. */
  clear(api: IndexedApi) {
    this.db.prepare('UPDATE api SET row_generation = ?, row_filters = ? WHERE id = ?')
      .run(this.nextGeneration(api.id), filterSignature(api.fields, api.filters), api.id)
  }

  /**
   * Writes a new generation in short transactions and returns its number; calls see it only after switchTo.
   * keys holds each row's key and values[f][row] the row's key for filter f. writeRows inserts rows [start, end)
   * in key order, the filter keys are written here in index order: in random order every transaction would
   * rewrite pages all over the indexes. check runs before every transaction and throws to abandon the write.
   * Call finish afterwards in either case.
   */
  async write(api: IndexedApi, keys: string[], values: string[][], check: () => void,
              writeRows: (generation: number, start: number, end: number) => void): Promise<number> {
    if (this.building.has(api.id)) throw new HttpError(409, '该 API 的数据正在写入，请稍后再试')
    const generation = this.nextGeneration(api.id)
    this.building.set(api.id, generation)
    try {
      const count = keys.length
      const batch = new Batch()
      const chunks = async (write: (start: number, end: number) => void) => {
        for (let start = 0; start < count;) {
          check()
          start = batch.run(this.db, size => {
            const end = Math.min(start + size, count)
            write(start, end)
            return end
          })
          await pause()
        }
      }
      const byKey = (a: number, b: number) => compare(keys[a], keys[b])
      await chunks((start, end) => writeRows(generation, start, end))
      const insert = this.statement('INSERT INTO api_row_filter (api_id, generation, name, value, row_key) VALUES (?, ?, ?, ?, ?)')
      for (const [index, name] of api.filters.entries()) {
        const column = values[index]
        const order = await sortedOrder(count, (a, b) => compare(column[a], column[b]) || byKey(a, b))
        await chunks((start, end) => {
          for (let k = start; k < end; k++) insert.run(api.id, generation, name, column[order[k]], keys[order[k]])
        })
      }
      check()
      return generation
    } catch (error) {
      this.finish(api.id)
      throw error
    }
  }

  /** Makes a written generation current; runs inside the caller's transaction, together with its checks. */
  switchTo(api: IndexedApi, generation: number) {
    this.db.prepare('UPDATE api SET row_generation = ?, row_filters = ? WHERE id = ?')
      .run(generation, filterSignature(api.fields, api.filters), api.id)
  }

  /** Ends a write, whether it was switched in or abandoned, and removes the generations no longer used. */
  finish(apiId: number) {
    this.building.delete(apiId)
    this.collect(apiId)
  }

  /** Deletes generations other than the current one and the one being written, a chunk at a time. */
  collect(apiId: number) {
    if (this.stopped) return
    if (this.collecting.has(apiId)) {
      this.collectAgain.add(apiId)
      return
    }
    this.collecting.add(apiId)
    // One generation at a time in key order, the order it was written in: that keeps the deletes
    // sequential in the table and the key index.
    const find = (table: string) => this.db.prepare(`SELECT generation FROM ${table} WHERE api_id = ? AND generation >= ? AND generation < ? LIMIT 1`)
    const garbage = [find('api_row'), find('api_row_filter')]
    const rows = this.db.prepare(`DELETE FROM api_row WHERE rowid IN (SELECT rowid FROM api_row
      WHERE api_id = ? AND generation = ? ORDER BY row_key LIMIT ?)`)
    const keys = this.db.prepare(`DELETE FROM api_row_filter WHERE (api_id, generation, name, value, row_key) IN (
      SELECT api_id, generation, name, value, row_key FROM api_row_filter WHERE api_id = ? AND generation = ? LIMIT ?)`)
    const batch = new Batch()
    // The first chunk runs at once, so small leftovers are gone before the caller continues.
    const step = (): boolean => {
      const current = this.db.prepare('SELECT row_generation AS generation FROM api WHERE id = ?').get(apiId) as { generation: number } | undefined
      if (!current) return false // a deleted API's rows were removed with it
      // New generations are numbered above every existing one, so leftovers lie below the one being written.
      const ranges = [[0, current.generation], [current.generation + 1, this.building.get(apiId) ?? Number.MAX_SAFE_INTEGER]]
      const generation = ranges.flatMap(([low, high]) => garbage.map(query => query.get(apiId, low, high) as { generation: number } | undefined))
        .find(row => row !== undefined)?.generation
      if (generation === undefined) return false
      batch.run(this.db, size => {
        rows.run(apiId, generation, size)
        keys.run(apiId, generation, size * 2)
      })
      return true
    }
    const done = () => {
      this.collecting.delete(apiId)
      if (this.collectAgain.delete(apiId)) this.collect(apiId)
    }
    const run = async () => {
      try {
        while (!this.stopped && this.db.isOpen && step()) await pause()
      } catch (error) {
        if (this.db.isOpen) console.error(`Removing old rows of API ${apiId} failed:`, error)
      } finally {
        done()
      }
    }
    void run()
  }

  /** Whether close has been called; background index rebuilds stop at their next chunk. */
  get closed() {
    return this.stopped
  }

  async close() {
    this.stopped = true
    await this.reader.close()
  }
}

interface Job { task: RowTask; resolve: (value: never) => void; reject: (error: Error) => void }

/** A small pool of row workers, started on demand and stopped when idle; one task per worker at a time. */
class RowReader {
  private readonly dbFile: string
  private readonly workers = new Set<Worker>()
  private readonly idle: Worker[] = []
  private readonly running = new Map<Worker, Job>()
  private readonly idleTimers = new Map<Worker, NodeJS.Timeout>()
  private readonly ready = new WeakSet<Worker>()
  private readonly queue: Job[] = []
  private closed = false

  constructor(dbFile: string) {
    this.dbFile = dbFile
  }

  run<T>(task: RowTask): Promise<T> {
    if (this.closed) return Promise.reject(new HttpError(503, '服务正在关闭'))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve: resolve as (value: never) => void, reject })
      this.next()
    })
  }

  private next() {
    while (this.queue.length) {
      const worker = this.idle.pop() ?? (this.workers.size < READERS ? this.spawn() : undefined)
      if (!worker) return
      clearTimeout(this.idleTimers.get(worker))
      this.idleTimers.delete(worker)
      const job = this.queue.shift()!
      this.running.set(worker, job)
      worker.ref()
      worker.postMessage(job.task)
    }
  }

  private spawn(): Worker {
    const worker = new Worker(new URL('./row-worker.ts', import.meta.url), { workerData: { dbFile: this.dbFile } })
    this.workers.add(worker)
    worker.on('message', (message: { result?: never; error?: { status: number; message: string } }) => {
      this.ready.add(worker)
      const job = this.running.get(worker)
      this.running.delete(worker)
      if (message.error) job?.reject(new HttpError(message.error.status, message.error.message))
      else job?.resolve(message.result!)
      worker.unref()
      this.idle.push(worker)
      this.idleTimers.set(worker, setTimeout(() => void worker.terminate(), READER_IDLE_MS).unref())
      this.next()
    })
    worker.on('error', error => console.error('Stored row reader failed:', error))
    worker.on('exit', () => {
      this.workers.delete(worker)
      const index = this.idle.indexOf(worker)
      if (index >= 0) this.idle.splice(index, 1)
      clearTimeout(this.idleTimers.get(worker))
      this.idleTimers.delete(worker)
      const job = this.running.get(worker)
      this.running.delete(worker)
      job?.reject(new HttpError(500, '服务器内部错误'))
      // A worker that fails before finishing any task would fail again; reject instead of restarting in a loop.
      if (!this.ready.has(worker)) for (const queued of this.queue.splice(0)) queued.reject(new HttpError(500, '服务器内部错误'))
      if (!this.closed) this.next()
    })
    return worker
  }

  async close() {
    this.closed = true
    for (const job of this.queue.splice(0)) job.reject(new HttpError(503, '服务正在关闭'))
    await Promise.all([...this.workers].map(worker => worker.terminate()))
  }
}
