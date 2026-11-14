import pg from 'pg'
import Cursor from 'pg-cursor'
import { parse as parseArray } from 'postgres-array'
import { HttpError } from './errors.ts'
import { numberFromText, parse as parseJson, type Json } from './json.ts'

// Result values are converted to JSON without losing precision or time zones:
// int8/numeric keep exact digits, timestamps become ISO 8601, times keep fractions and offsets.

type Parser = (text: string) => Json

const exactNumber: Parser = text => /^-?(NaN|Infinity)$/.test(text) ? text : numberFromText(text)
const float: Parser = text => { const n = Number(text); return Number.isFinite(n) ? n : text }
const timestamp: Parser = text => text.replace(' ', 'T')
// The session time zone is fixed per pool; PostgreSQL prints offsets as "+08" or "+05:30".
const withOffset = (text: string) => text.replace(/([+-]\d{2})$/, '$1:00').replace(/\+00:00$/, 'Z')
const timestamptz: Parser = text => withOffset(text.replace(' ', 'T'))
const bytea: Parser = text => Buffer.from(text.slice(2), 'hex').toString('base64')

const scalar: Record<number, Parser> = {
  20: exactNumber, 1700: exactNumber, 700: float, 701: float,
  1082: t => t, 1083: t => t, 1266: withOffset, 1114: timestamp, 1184: timestamptz, 1186: t => t,
  114: parseJson, 3802: parseJson, 17: bytea,
}
const arrays: Record<number, number> = {
  1016: 20, 1231: 1700, 1021: 700, 1022: 701, 1182: 1082, 1183: 1083, 1270: 1266,
  1115: 1114, 1185: 1184, 1187: 1186, 199: 114, 3807: 3802, 1001: 17,
}

export const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (scalar[oid]) return scalar[oid]
    if (arrays[oid]) return (text: string) => parseArray(text, scalar[arrays[oid]])
    return pg.types.getTypeParser(oid, format)
  },
}

export class SourceError extends HttpError {
  readonly detail: string
  constructor(status: number, message: string, detail: string) {
    super(status, message)
    this.detail = detail
  }
}

function sourceError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const e = error as { code?: string; message?: string }
  const detail = e.code ? `${e.code}: ${e.message}` : String(e.message ?? error)
  if (e.code === '57014') return new SourceError(504, '数据源查询超时', detail)
  if (e.code === '25006') return new SourceError(400, 'SQL 只能读取数据', detail)
  const sqlState = e.code && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : undefined
  if (!sqlState || /^(08|28|3D|53|57P)/.test(sqlState)) return new SourceError(502, '数据源连接失败', detail)
  return new SourceError(502, '数据源查询失败', detail)
}

export interface QueryResult { rows: Record<string, Json>[]; truncated: boolean; columns: string[] }

export interface Statement { text: string; values: (string | null)[]; maxRows: number }

/** Runs one read-only statement and returns at most maxRows rows. */
export async function runQuery(pool: pg.Pool, text: string, values: (string | null)[],
                               options: { timeoutSeconds: number; maxRows: number }): Promise<QueryResult> {
  const [result] = await runStatements(pool, [{ text, values, maxRows: options.maxRows }], options.timeoutSeconds)
  return result
}

/** Runs statements in one read-only transaction; with several, they all see the same snapshot. */
export async function runStatements(pool: pg.Pool, statements: Statement[], timeoutSeconds: number): Promise<QueryResult[]> {
  let client: pg.PoolClient
  try {
    client = await pool.connect()
  } catch (error) {
    throw sourceError(error)
  }
  let broken = false
  let timer: NodeJS.Timeout | undefined
  // Backstop for a hung network, covering every round trip: the server-side timeout normally fires first.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SourceError(504, '数据源查询超时', 'client deadline')),
      timeoutSeconds * 1000 * statements.length + 5000)
  })
  deadline.catch(() => {})
  const bounded = <T>(work: Promise<T>): Promise<T> => {
    work.catch(() => {})
    return Promise.race([work, deadline])
  }
  try {
    await bounded(client.query(statements.length > 1 ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN READ ONLY'))
    await bounded(client.query(`SET LOCAL statement_timeout = ${timeoutSeconds * 1000}`))
    const results: QueryResult[] = []
    for (const statement of statements) results.push(await readStatement(client, statement, bounded))
    return results
  } catch (error) {
    // PostgreSQL errors leave the connection usable; network failures and our deadline do not.
    const fromServer = /^[0-9A-Z]{5}$/.test(String((error as { code?: unknown }).code ?? ''))
    broken = error instanceof SourceError || (!fromServer && !(error instanceof HttpError))
    throw sourceError(error)
  } finally {
    if (!broken) await bounded(client.query('ROLLBACK')).catch(() => { broken = true })
    clearTimeout(timer)
    client.release(broken)
  }
}

async function readStatement(client: pg.PoolClient, statement: Statement,
                             bounded: <T>(work: Promise<T>) => Promise<T>): Promise<QueryResult> {
  const cursor = client.query(new Cursor(statement.text, statement.values, { rowMode: 'array', types: typeParsers }))
  const { rows, fields } = await bounded(new Promise<{ rows: Json[][]; fields: { name: string }[] }>((resolve, reject) =>
    cursor.read(statement.maxRows + 1, (error, rows, result) =>
      error ? reject(error) : resolve({ rows: rows as Json[][], fields: result.fields }))))
  await bounded(cursor.close())
  const names = fields.map(field => field.name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) throw new HttpError(400, `查询结果包含重复的列名 ${duplicate}`)
  return {
    columns: names,
    truncated: rows.length > statement.maxRows,
    rows: rows.slice(0, statement.maxRows).map(row => Object.fromEntries(names.map((name, i) => [name, row[i]]))),
  }
}
