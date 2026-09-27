import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface Config {
  port: number
  dataDir: string
  dbFile: string
  webDir: string
  secretKey: Buffer
  adminUsername: string
  adminPassword?: string
  timezone: string
  secureCookies: boolean | 'auto'
  trustProxy: boolean
  logRetentionDays: number
  maxConcurrentQueries: number
}

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`)
  return n
}

/** The data-source password key lives in the data directory unless APP_SECRET_KEY is given. */
function loadSecretKey(env: NodeJS.ProcessEnv, dataDir: string, dbFile: string): Buffer {
  const file = join(dataDir, 'secret.key')
  let encoded = env.APP_SECRET_KEY?.trim()
  if (!encoded && existsSync(file)) encoded = readFileSync(file, 'utf8').trim()
  if (!encoded) {
    if (existsSync(dbFile)) {
      throw new Error(`${file} is missing but ${dbFile} exists; restore the key (or set APP_SECRET_KEY) to decrypt stored passwords`)
    }
    encoded = randomBytes(32).toString('base64')
    writeFileSync(file, encoded + '\n', { mode: 0o600 })
  }
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error('APP_SECRET_KEY must be 32 bytes, Base64 encoded')
  return key
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR ?? 'data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const dbFile = join(dataDir, 'databridge.db')
  const cookie = env.COOKIE_SECURE ?? 'auto'
  return {
    port: integer(env.PORT, 8080, 'PORT'),
    dataDir,
    dbFile,
    webDir: resolve(env.WEB_DIR ?? 'web/dist'),
    secretKey: loadSecretKey(env, dataDir, dbFile),
    adminUsername: env.ADMIN_USERNAME?.trim() || 'admin',
    adminPassword: env.ADMIN_PASSWORD || undefined,
    timezone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    secureCookies: cookie === 'auto' ? 'auto' : cookie === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    logRetentionDays: integer(env.LOG_RETENTION_DAYS, 30, 'LOG_RETENTION_DAYS'),
    maxConcurrentQueries: integer(env.MAX_CONCURRENT_QUERIES, 20, 'MAX_CONCURRENT_QUERIES'),
  }
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

export function decrypt(key: Buffer, encoded: string): string {
  const raw = Buffer.from(encoded, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}
