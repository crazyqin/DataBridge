import { createHash } from 'node:crypto'
import { createReadStream, closeSync, openSync, writeSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { backup, DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { decrypt } from './config.ts'
import { archiveFiles } from './export-archive.ts'
import { parse, stringify } from './json.ts'

interface Input { dbFile: string; directory: string; secretKey: Uint8Array; timezone: string; logRetentionDays: number; filename: string }
const input = workerData as Input
const secretKey = Buffer.from(input.secretKey)
const files: { path: string; bytes: number; sha256: string; rows?: number }[] = []
const counts: Record<string, number> = {}
const progress = (stage: string, detail: string) => parentPort!.postMessage({ type: 'progress', stage, detail })
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const json = (value: unknown) => stringify(value)
function value(item: SQLOutputValue): unknown {
  if (typeof item === 'bigint') return item <= BigInt(Number.MAX_SAFE_INTEGER) && item >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(item) : JSON.rawJSON(String(item))
  if (item instanceof Uint8Array) return { encoding: 'base64', data: Buffer.from(item).toString('base64') }
  return item
}
function* rows(db: DatabaseSync, sql: string): Generator<Record<string, unknown>> {
  const statement = db.prepare(sql)
  statement.setReadBigInts(true)
  for (const row of statement.iterate()) yield Object.fromEntries(Object.entries(row).map(([key, item]) => [key, value(item)]))
}
async function register(path: string, rowCount?: number) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(input.directory, path))) hash.update(chunk)
  files.push({ path, bytes: (await stat(join(input.directory, path))).size, sha256: hash.digest('hex'), ...(rowCount === undefined ? {} : { rows: rowCount }) })
}
async function write(path: string, content: string) {
  await writeFile(join(input.directory, path), content, { mode: 0o600 })
  await register(path)
}
async function writeRows(path: string, items: Iterable<unknown>, csvColumns?: string[]) {
  const fd = openSync(join(input.directory, path), 'wx', 0o600)
  let count = 0, buffer = '', bufferedBytes = 0
  // Quoting preserves raw values, including embedded commas, newlines and leading zeros.
  const cell = (item: unknown) => '"' + (item == null ? '' : typeof item === 'object' ? json(item) : String(item)).replaceAll('"', '""') + '"'
  const flush = () => {
    const bytes = Buffer.from(buffer)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
    buffer = ''; bufferedBytes = 0
  }
  try {
    if (csvColumns) { buffer = '\uFEFF' + csvColumns.map(cell).join(',') + '\r\n'; bufferedBytes = Buffer.byteLength(buffer) }
    for (const item of items) {
      const line = csvColumns ? csvColumns.map(key => cell((item as Record<string, unknown>)[key])).join(',') + '\r\n' : json(item) + '\n'
      buffer += line; bufferedBytes += Buffer.byteLength(line)
      count++
      if (bufferedBytes >= 128 * 1024) flush()
    }
    if (buffer) flush()
  } finally { closeSync(fd) }
  await register(path, count)
  return count
}
const metrics = `COUNT(*) AS calls, SUM(ok) AS successes, SUM(1 - ok) AS failures,
  AVG(ok) AS success_rate, AVG(1 - ok) AS failure_rate,
  AVG(elapsed_ms) AS mean_ms, MIN(elapsed_ms) AS min_ms, MAX(elapsed_ms) AS max_ms,
  MAX(CASE WHEN rank = (n * 50 + 99) / 100 THEN elapsed_ms END) AS p50_ms,
  MAX(CASE WHEN rank = (n * 95 + 99) / 100 THEN elapsed_ms END) AS p95_ms,
  MAX(CASE WHEN rank = (n * 99 + 99) / 100 THEN elapsed_ms END) AS p99_ms`

async function main() {
  for (const folder of ['raw', 'tables', 'configuration', 'analysis']) await mkdir(join(input.directory, folder), { mode: 0o700 })
  progress('snapshot', '正在创建一致性数据库快照')
  const source = new DatabaseSync(input.dbFile, { readOnly: true })
  let snapshotAt: string
  try {
    source.exec('PRAGMA busy_timeout = 5000; BEGIN;')
    source.prepare('SELECT count(*) FROM sqlite_schema').get() // Pin the WAL read snapshot before backup.
    snapshotAt = new Date().toISOString()
    await backup(source, join(input.directory, 'raw/databridge.sqlite'))
  } finally { source.close() }
  await chmod(join(input.directory, 'raw/databridge.sqlite'), 0o600)
  await register('raw/databridge.sqlite')
  await write('raw/secret.key', secretKey.toString('base64') + '\n')
  const db = new DatabaseSync(join(input.directory, 'raw/databridge.sqlite'), { readOnly: true })
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]
    const schema = tables.map(table => ({ ...table, columns: db.prepare(`PRAGMA table_info(${quote(table.name)})`).all(),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all() }))
    await write('schema.json', JSON.stringify(schema, null, 2) + '\n')
    for (const table of tables) {
      if (!/^[a-z_]+$/.test(table.name)) throw new Error('Unexpected table name')
      progress('tables', `正在导出 ${table.name}`)
      counts[table.name] = await writeRows(`tables/${table.name}.jsonl`, rows(db, `SELECT * FROM ${quote(table.name)} ORDER BY rowid`))
    }
    progress('configuration', '正在导出可读配置与业务数据')
    function* decoded(table: string, jsonFields: string[], encryptedFields: string[]) {
      for (const row of rows(db, `SELECT * FROM ${quote(table)} ORDER BY rowid`)) {
        for (const field of encryptedFields) if (typeof row[field] === 'string') row[field] = decrypt(secretKey, row[field])
        for (const field of jsonFields) if (typeof row[field] === 'string') row[field] = parse(row[field])
        yield row
      }
    }
    await writeRows('configuration/apis.jsonl', decoded('api', ['user_agents', 'params', 'fields', 'filters', 'key_fields', 'external_auth', 'xingchen'], ['external_auth', 'xingchen']))
    await writeRows('configuration/connections.jsonl', decoded('connection', ['config'], ['config']))
    await writeRows('configuration/datasources.jsonl', decoded('datasource', [], ['password']))
    await writeRows('analysis/api_rows.jsonl', decoded('api_row', ['data'], []))
    progress('analysis', '正在整理全部调用日志与统计')
    function* requests() {
      for (const row of rows(db, `SELECT l.*, a.name AS api_name_current, d.detail AS request, e.detail AS external_auth
        FROM request_log l LEFT JOIN api a ON a.id = l.api_id LEFT JOIN request_detail_log d ON d.log_id = l.id
        LEFT JOIN request_auth_log e ON e.log_id = l.id ORDER BY l.id`)) {
        row.request = row.request === null ? null : parse(String(row.request))
        row.external_auth = row.external_auth === null ? null : parse(String(row.external_auth))
        yield row
      }
    }
    await writeRows('analysis/requests.jsonl', requests())
    const requestColumns = ['id', 'request_id', 'at', 'api_id', 'api_name_current', 'mode', 'method', 'path', 'status', 'elapsed_ms', 'row_count', 'ok', 'error', 'has_request_detail', 'has_auth_detail']
    await writeRows('analysis/requests.csv', rows(db, `SELECT l.*, a.name AS api_name_current,
      EXISTS(SELECT 1 FROM request_detail_log d WHERE d.log_id = l.id) AS has_request_detail,
      EXISTS(SELECT 1 FROM request_auth_log e WHERE e.log_id = l.id) AS has_auth_detail
      FROM request_log l LEFT JOIN api a ON a.id = l.api_id ORDER BY l.id`), requestColumns)
    const metricColumns = ['calls', 'successes', 'failures', 'success_rate', 'failure_rate', 'mean_ms', 'min_ms', 'max_ms', 'p50_ms', 'p95_ms', 'p99_ms']
    const overall = db.prepare(`WITH ranked AS (SELECT *, ROW_NUMBER() OVER(ORDER BY elapsed_ms) AS rank, COUNT(*) OVER() AS n FROM request_log)
      SELECT ${metrics}, MIN(at) AS first_call_at, MAX(at) AS last_call_at FROM ranked`).get()!
    const summary = { ...overall, successes: overall.successes ?? 0, failures: overall.failures ?? 0,
      failure_rate: Number(overall.calls) ? Number(overall.failures) / Number(overall.calls) : null,
      request_details: counts.request_detail_log, auth_details: counts.request_auth_log,
      percentile_method: 'nearest-rank', scope: 'all retained calls at snapshot time', timezone: 'UTC' }
    await write('analysis/summary.json', json(summary) + '\n')
    await writeRows('analysis/by_api.csv', rows(db, `WITH ranked AS (SELECT *,
      ROW_NUMBER() OVER(PARTITION BY api_id, mode ORDER BY elapsed_ms) AS rank, COUNT(*) OVER(PARTITION BY api_id, mode) AS n FROM request_log)
      SELECT api_id, mode, (SELECT name FROM api WHERE id = ranked.api_id) AS api_name_current, ${metrics}
      FROM ranked GROUP BY api_id, mode ORDER BY api_id, mode`), ['api_id', 'api_name_current', 'mode', ...metricColumns])
    await writeRows('analysis/daily.csv', rows(db, `SELECT strftime('%Y-%m-%d', at) AS day_utc, COUNT(*) AS calls,
      SUM(ok) AS successes, SUM(1-ok) AS failures, AVG(ok) AS success_rate, AVG(1-ok) AS failure_rate,
      AVG(elapsed_ms) AS mean_ms FROM request_log GROUP BY day_utc ORDER BY day_utc`),
    ['day_utc', 'calls', 'successes', 'failures', 'success_rate', 'failure_rate', 'mean_ms'])
    await writeRows('analysis/sync_history.csv', rows(db, 'SELECT * FROM sync_log ORDER BY id'),
      ['id', 'api_id', 'started_at', 'finished_at', 'trigger', 'status', 'row_count', 'error'])
    await write('README.txt', `DataBridge 完整原始导出（格式版本 1）\n快照时间：${snapshotAt}\n\n` +
      '导出内容\n- raw/databridge.sqlite：完整 SQLite 一致性快照，包含全部表、索引、触发器和原始字段。\n' +
      '- raw/secret.key：该快照使用的加密密钥；configuration/ 下已提供解密后的完整连接、数据源和接口配置。\n' +
      '- tables/*.jsonl：所有业务表逐行导出，字段名与原数据库一致；JSON 文本字段保留原始字符串。\n' +
      '- schema.json：各表建表语句、字段类型、主键和外键。\n' +
      '- analysis/requests.jsonl：每次调用摘要、请求响应详情和外部身份验证详情，通过日志 ID 关联；详情缺失时为 null。\n' +
      '- analysis/api_rows.jsonl：手工和快照业务数据，data 已解析为 JSON 对象。\n' +
      '- analysis/*.csv：调用摘要、按接口统计、UTC 每日统计、同步历史；UTF-8 BOM、RFC 4180 引号，保留原始单元格值。\n' +
      '- analysis/summary.json：全部已保存调用的成功/失败数、失败率（0~1）、平均耗时和 P50/P95/P99；耗时单位毫秒，分位数采用 nearest-rank。空样本耗时和失败率为 null。\n' +
      '- manifest.json：软件与导出格式版本、时间、记录数量、每个文件的 SHA-256。\n\n' +
      '范围与解释\n所有内容不脱敏，包括凭据、内部地址、SQL 和业务原始值。导出不是当前页面的一页，也不应用日志列表筛选。\n' +
      '范围限于 DataBridge 当前已保存的数据；不连接外部数据库执行查询，不抓取外部服务的数据、服务器控制台日志、源码或环境变量。\n' +
      `日志保留配置为 ${input.logRetentionDays} 天；已清理的记录无法补回。响应预览此前被截断、脱敏或未保存的部分（例如完整 SSE 流）无法恢复，原有 truncated/redacted/note 标记保留。\n` +
      '管理员密码和调用 API Key 原值从未保存，导出保留其哈希；公开密钥前缀不能用于恢复完整 Key。\n' +
      'api_id 可以为空或指向已删除的接口。api_name_current 表示导出时名称；调用时接口快照在 requests.jsonl 的 request.api 中。ok=1/0 表示调用成功/失败，包括 SSE 流内结果，不能仅用 HTTP 状态替代。\n' +
      'JSONL 一行一个对象，使用支持大整数和精确小数的读取器；CSV 导入 Excel 时将标识符设为文本以保留前导零。\n\n' +
      'Python 读取（无需第三方库）\n' +
      '  import json, sqlite3\n  from decimal import Decimal\n  with open("analysis/requests.jsonl", encoding="utf-8") as f:\n' +
      '      for line in f:\n          row = json.loads(line, parse_float=Decimal)\n          print(row["request_id"], row["elapsed_ms"], row["ok"])\n' +
      '  db = sqlite3.connect("file:raw/databridge.sqlite?mode=ro", uri=True)\n' +
      '  print(db.execute("SELECT mode, COUNT(*), AVG(elapsed_ms) FROM request_log GROUP BY mode").fetchall())\n')
    const app = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    const manifest = { format: 'databridge-full-export', formatVersion: 1, appVersion: app.version,
      snapshotAt, generatedAt: new Date().toISOString(), schemaVersion: db.prepare('PRAGMA user_version').get()!.user_version,
      redacted: false, timezone: input.timezone, logRetentionDays: input.logRetentionDays,
      scope: 'all persisted DataBridge data', tableCounts: counts, files }
    await writeFile(join(input.directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  } finally { db.close() }
  progress('archive', '正在压缩并校验导出包')
  await archiveFiles(input.directory, [...files.map(file => file.path), 'manifest.json'], join(input.directory, input.filename))
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(input.directory, input.filename))) hash.update(chunk)
  parentPort!.postMessage({ type: 'ready', bytes: (await stat(join(input.directory, input.filename))).size,
    sha256: hash.digest('hex'), snapshotAt, tableCounts: counts })
}

await main()
