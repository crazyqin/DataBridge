import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { now, type Db } from './db.ts'
import { bad, conflict, HttpError, notFound, unauthorized } from './errors.ts'

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

  listKeys() {
    return this.db.prepare('SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_key ORDER BY id DESC').all()
  }

  createKey(name: unknown) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw bad('请填写 1 到 100 个字符的名称')
    const key = `dbk_${randomBytes(24).toString('base64url')}`
    const prefix = key.slice(0, 10)
    const { lastInsertRowid } = this.db.prepare('INSERT INTO api_key (name, prefix, hash, created_at) VALUES (?, ?, ?, ?)')
      .run(name.trim(), prefix, sha256(key), now())
    return { id: Number(lastInsertRowid), name: name.trim(), prefix, key }
  }

  deleteKey(id: number) {
    if (this.db.prepare('DELETE FROM api_key WHERE id = ?').run(id).changes === 0) throw notFound()
  }

  checkKey(key: string | undefined): boolean {
    if (!key) return false
    const row = this.db.prepare('SELECT id FROM api_key WHERE hash = ?').get(sha256(key)) as { id: number } | undefined
    if (!row) return false
    const time = now()
    const minuteAgo = new Date(Date.now() - 60_000).toISOString()
    this.db.prepare('UPDATE api_key SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
      .run(time, row.id, minuteAgo)
    return true
  }
}
