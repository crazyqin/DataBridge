import pg from 'pg'
import { decrypt, encrypt, type Config } from './config.ts'
import { now, type Db } from './db.ts'
import { bad, conflict, notFound } from './errors.ts'
import { choice, flag, integer, text } from './input.ts'
import type { JsonObject } from './json.ts'
import { runQuery } from './query.ts'

const SSL_MODES = ['disable', 'require', 'verify'] as const

export interface Datasource {
  id: number
  name: string
  host: string
  port: number
  database: string
  username: string
  ssl: (typeof SSL_MODES)[number]
  enabled: boolean
  version: number
  createdAt: string
  updatedAt: string
}

interface Row {
  id: number; name: string; host: string; port: number; database: string; username: string; password: string
  ssl: Datasource['ssl']; enabled: number; version: number; created_at: string; updated_at: string
}

const toSource = (row: Row): Datasource => ({
  id: row.id, name: row.name, host: row.host, port: row.port, database: row.database, username: row.username,
  ssl: row.ssl, enabled: row.enabled === 1, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
})

export class Sources {
  private readonly pools = new Map<number, { version: number; pool: pg.Pool }>()
  private readonly db: Db
  private readonly config: Config

  constructor(db: Db, config: Config) {
    this.db = db
    this.config = config
  }

  private row(id: number): Row {
    const row = this.db.prepare('SELECT * FROM datasource WHERE id = ?').get(id) as Row | undefined
    if (!row) throw notFound('数据源不存在')
    return row
  }

  list(): Datasource[] {
    return (this.db.prepare('SELECT * FROM datasource ORDER BY id DESC').all() as unknown as Row[]).map(toSource)
  }

  get(id: number): Datasource {
    return toSource(this.row(id))
  }

  save(id: number | undefined, input: JsonObject): Datasource {
    const name = text(input, 'name', '名称', { max: 100 })
    const host = text(input, 'host', '主机', { max: 255, pattern: /^[A-Za-z0-9.\-:\[\]_]+$/ })
    const port = integer(input, 'port', '端口', 1, 65535, 5432)
    const database = text(input, 'database', '数据库名', { max: 63 })
    const username = text(input, 'username', '用户名', { max: 63 })
    const ssl = choice(input, 'ssl', 'SSL 模式', SSL_MODES, 'disable')
    const enabled = flag(input, 'enabled', '启用状态', true)
    const password = input.password
    if (password !== undefined && password !== null && typeof password !== 'string') throw bad('密码必须是字符串')
    const time = now()
    try {
      if (id === undefined) {
        if (!password) throw bad('请填写密码')
        const result = this.db.prepare(`INSERT INTO datasource (name, host, port, database, username, password, ssl, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(name, host, port, database, username, encrypt(this.config.secretKey, password), ssl, enabled ? 1 : 0, time, time)
        return this.get(Number(result.lastInsertRowid))
      }
      const version = integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER)
      const current = this.row(id)
      if (current.version !== version) throw conflict('数据源已被修改，请刷新后再保存')
      const secret = password ? encrypt(this.config.secretKey, password) : current.password
      this.db.prepare(`UPDATE datasource SET name = ?, host = ?, port = ?, database = ?, username = ?, password = ?, ssl = ?,
        enabled = ?, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(name, host, port, database, username, secret, ssl, enabled ? 1 : 0, time, id)
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) throw conflict('数据源名称已存在')
      throw error
    }
    this.close(id)
    return this.get(id)
  }

  remove(id: number) {
    this.row(id)
    try {
      this.db.prepare('DELETE FROM datasource WHERE id = ?').run(id)
    } catch (error) {
      if (String((error as Error).message).includes('FOREIGN KEY')) throw conflict('数据源正在被 API 使用，无法删除')
      throw error
    }
    this.close(id)
  }

  /** The connection pool for the current version of an enabled data source. */
  pool(id: number): { source: Datasource; pool: pg.Pool } {
    const row = this.row(id)
    if (row.enabled !== 1) throw bad('数据源已停用')
    const cached = this.pools.get(id)
    if (cached?.version === row.version) return { source: toSource(row), pool: cached.pool }
    this.close(id)
    const pool = new pg.Pool({
      host: row.host,
      port: row.port,
      database: row.database,
      user: row.username,
      password: decrypt(this.config.secretKey, row.password),
      ssl: row.ssl === 'disable' ? false : { rejectUnauthorized: row.ssl === 'verify' },
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 60_000,
      application_name: 'databridge',
      options: `-c TimeZone=${this.config.timezone} -c DateStyle=ISO,YMD`,
    })
    pool.on('error', () => {}) // idle connection dropped by the server; the pool replaces it
    this.pools.set(id, { version: row.version, pool })
    return { source: toSource(row), pool }
  }

  async test(id: number) {
    const started = performance.now()
    const { pool } = this.pool(id)
    const { rows } = await runQuery(pool, 'SELECT version() AS version', [], { timeoutSeconds: 10, maxRows: 1 })
    return { version: rows[0].version, elapsedMs: Math.round(performance.now() - started) }
  }

  private close(id: number) {
    const cached = this.pools.get(id)
    this.pools.delete(id)
    cached?.pool.end().catch(() => {})
  }

  async closeAll() {
    await Promise.all([...this.pools.values()].map(({ pool }) => pool.end().catch(() => {})))
    this.pools.clear()
  }
}
