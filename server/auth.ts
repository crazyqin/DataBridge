import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { now, transaction, type Db } from './db.ts'
import { bad, conflict, forbidden, HttpError, notFound, unauthorized } from './errors.ts'
import { integer, text } from './input.ts'
import type { JsonObject } from './json.ts'

const SESSION_IDLE_MS = 4 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 10

function scryptAsync(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, length, options, (error, key) => error ? reject(error) : resolve(key)))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, N, r, p, salt, hash] = stored.split('$')
  if (algorithm !== 'scrypt' || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 })
  return timingSafeEqual(actual, expected)
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

interface Session { username: string; expires: number }

interface ApiKey {
  id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; version: number; apiIds: number[]
}
const keySummary = 'SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt, version FROM api_key'

export class Auth {
  private readonly sessions = new Map<string, Session>()
  private readonly failures = new Map<string, { count: number; since: number }>()
  private readonly db: Db
  private readonly config: Config
  private readonly initialPasswordFile: string
  private dummyHash = ''

  constructor(db: Db, config: Config) {
    this.db = db
    this.config = config
    this.initialPasswordFile = join(config.dataDir, 'initial-admin-password')
  }

  /** Creates the admin account on first start; without ADMIN_PASSWORD a random one is written to the data dir. */
  async bootstrap(): Promise<string | undefined> {
    this.dummyHash = await hashPassword(randomBytes(16).toString('hex'))
    if (this.db.prepare('SELECT 1 FROM admin').get()) return undefined
    const password = this.config.adminPassword ?? randomBytes(12).toString('base64url')
    this.db.prepare('INSERT INTO admin (username, password_hash, updated_at) VALUES (?, ?, ?)')
      .run(this.config.adminUsername, await hashPassword(password), now())
    if (this.config.adminPassword) return undefined
    writeFileSync(this.initialPasswordFile, password + '\n', { mode: 0o600 })
    return this.initialPasswordFile
  }

  async login(username: string, password: string, client: string): Promise<string> {
    const failure = this.failures.get(client)
    if (failure && Date.now() - failure.since < LOGIN_WINDOW_MS && failure.count >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, '登录失败次数过多，请 15 分钟后再试')
    }
    const row = this.db.prepare('SELECT password_hash FROM admin WHERE username = ?').get(username) as { password_hash: string } | undefined
    // Always run scrypt so response time does not reveal whether the username exists.
    const valid = await verifyPassword(password, row?.password_hash ?? this.dummyHash) && row !== undefined
    if (!valid) {
      const current = failure && Date.now() - failure.since < LOGIN_WINDOW_MS ? failure : { count: 0, since: Date.now() }
      this.failures.set(client, { count: current.count + 1, since: current.since })
      throw unauthorized('账号或密码错误')
    }
    this.failures.delete(client)
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, { username, expires: Date.now() + SESSION_IDLE_MS })
    return token
  }

  /** Returns the username for a live session and extends it. */
  session(token: string | undefined): string | undefined {
    const session = token ? this.sessions.get(token) : undefined
    if (!session) return undefined
    if (session.expires < Date.now()) {
      this.sessions.delete(token!)
      return undefined
    }
    session.expires = Date.now() + SESSION_IDLE_MS
    return session.username
  }

  logout(token: string | undefined) {
    if (token) this.sessions.delete(token)
  }

  prune() {
    const time = Date.now()
    for (const [token, session] of this.sessions) if (session.expires < time) this.sessions.delete(token)
    for (const [client, failure] of this.failures) if (time - failure.since > LOGIN_WINDOW_MS) this.failures.delete(client)
  }

  async changePassword(username: string, current: unknown, next: unknown) {
    if (typeof current !== 'string' || typeof next !== 'string') throw bad('请输入当前密码和新密码')
    if (next.length < 12 || next.length > 200) throw bad('新密码长度需在 12 到 200 个字符之间')
    const row = this.db.prepare('SELECT password_hash FROM admin WHERE username = ?').get(username) as { password_hash: string } | undefined
    if (!row) throw unauthorized()
    if (!await verifyPassword(current, row.password_hash)) throw bad('当前密码不正确')
    if (current === next) throw bad('新密码不能与当前密码相同')
    const hash = await hashPassword(next)
    const changed = this.db.prepare('UPDATE admin SET password_hash = ?, updated_at = ? WHERE username = ? AND password_hash = ?')
      .run(hash, now(), username, row.password_hash)
    if (changed.changes !== 1) throw conflict('密码已被同时修改，请重试')
    for (const [token, session] of this.sessions) if (session.username === username) this.sessions.delete(token)
    if (existsSync(this.initialPasswordFile)) unlinkSync(this.initialPasswordFile)
  }

  listKeys(): ApiKey[] {
    const keys = this.db.prepare(keySummary + ' ORDER BY id DESC').all() as unknown as Omit<ApiKey, 'apiIds'>[]
    const access = this.db.prepare('SELECT key_id, api_id FROM api_key_access ORDER BY api_id').all() as { key_id: number; api_id: number }[]
    const grants = new Map<number, number[]>()
    for (const row of access) {
      const ids = grants.get(row.key_id) ?? []
      ids.push(row.api_id)
      grants.set(row.key_id, ids)
    }
    return keys.map(key => ({ ...key, apiIds: grants.get(key.id) ?? [] }))
  }

  private getKey(id: number): ApiKey {
    const key = this.db.prepare(keySummary + ' WHERE id = ?').get(id) as unknown as Omit<ApiKey, 'apiIds'> | undefined
    if (!key) throw notFound('调用密钥不存在，请刷新列表')
    const rows = this.db.prepare('SELECT api_id FROM api_key_access WHERE key_id = ? ORDER BY api_id').all(id) as { api_id: number }[]
    return { ...key, apiIds: rows.map(row => row.api_id) }
  }

  private keySettings(input: JsonObject) {
    const name = text(input, 'name', '调用方名称', { max: 100 })
    const ids = input.apiIds
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
      throw bad('授权接口必须是有效 ID 数组，最多 1000 个；空数组表示不允许调用任何接口')
    }
    const apiIds = [...new Set(ids as number[])].sort((a, b) => a - b)
    for (const id of apiIds) {
      const api = this.db.prepare('SELECT auth FROM api WHERE id = ?').get(id)
      if (!api) throw bad('部分授权接口已不存在，请刷新后重新选择')
      if (api.auth !== 'API_KEY') throw bad('只能授权访问方式为 API Key 的接口，请刷新后重新选择')
    }
    return { name, apiIds }
  }

  private assignKey(id: number, apiIds: number[]) {
    this.db.prepare('DELETE FROM api_key_access WHERE key_id = ?').run(id)
    const insert = this.db.prepare('INSERT INTO api_key_access (key_id, api_id) VALUES (?, ?)')
    for (const apiId of apiIds) insert.run(id, apiId)
  }

  createKey(input: JsonObject) {
    const key = `dbk_${randomBytes(24).toString('base64url')}`
    const prefix = key.slice(0, 10)
    return transaction(this.db, () => {
      const { name, apiIds } = this.keySettings(input)
      const { lastInsertRowid } = this.db.prepare('INSERT INTO api_key (name, prefix, hash, created_at) VALUES (?, ?, ?, ?)')
        .run(name, prefix, sha256(key), now())
      const id = Number(lastInsertRowid)
      this.assignKey(id, apiIds)
      return { ...this.getKey(id), key }
    })
  }

  updateKey(id: number, input: JsonObject) {
    return transaction(this.db, () => {
      const current = this.getKey(id)
      if (integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER) !== current.version) {
        throw conflict('调用密钥或授权接口已被修改，请重新打开编辑窗口')
      }
      const { name, apiIds } = this.keySettings(input)
      this.db.prepare('UPDATE api_key SET name = ?, version = version + 1 WHERE id = ?').run(name, id)
      this.assignKey(id, apiIds)
      return this.getKey(id)
    })
  }

  deleteKey(id: number) {
    if (this.db.prepare('DELETE FROM api_key WHERE id = ?').run(id).changes === 0) throw notFound()
  }

  authorizeKey(key: string | undefined, apiId: number): void {
    if (!key) throw unauthorized('API Key 无效')
    const row = this.db.prepare('SELECT id FROM api_key WHERE hash = ?').get(sha256(key)) as { id: number } | undefined
    if (!row) throw unauthorized('API Key 无效')
    if (!this.db.prepare('SELECT 1 FROM api_key_access WHERE key_id = ? AND api_id = ?').get(row.id, apiId)) {
      throw forbidden('API Key 无权访问此接口')
    }
    const time = now()
    const minuteAgo = new Date(Date.now() - 60_000).toISOString()
    this.db.prepare('UPDATE api_key SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
      .run(time, row.id, minuteAgo)
  }
}
