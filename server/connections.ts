import { decrypt, encrypt, type Config } from './config.ts'
import { now, transaction, type Db } from './db.ts'
import { bad, conflict, notFound } from './errors.ts'
import { validateExternalAuth, type ExternalAuthConfig } from './external-auth.ts'
import { choice, integer, text } from './input.ts'
import { parse, stringify, type Json, type JsonObject } from './json.ts'
import { parseSql } from './sql.ts'
import { identity } from './values.ts'
import { validatePlatform } from './xingchen.ts'

export type ConnectionKind = 'EXTERNAL_AUTH' | 'XINGCHEN'
export type ConnectionConfig = ExternalAuthConfig | { baseUrl: string }
export interface Connection {
  id: number; kind: ConnectionKind; name: string; config: ConnectionConfig; version: number
  createdAt: string; updatedAt: string; usedBy: { id: number; name: string }[]
}
interface StoredConnection {
  id: number; kind: ConnectionKind; name: string; config: string; version: number; created_at: string; updated_at: string
}

/** Shared connection settings are encrypted as a whole, including internal addresses. */
export class Connections {
  private readonly db: Db
  private readonly config: Config
  constructor(db: Db, config: Config) { this.db = db; this.config = config }

  private decode(row: StoredConnection): Connection {
    return { id: row.id, kind: row.kind, name: row.name, version: row.version,
      config: parse(decrypt(this.config.secretKey, row.config)) as unknown as ConnectionConfig,
      createdAt: row.created_at, updatedAt: row.updated_at,
      usedBy: this.db.prepare('SELECT id, name FROM api WHERE auth_connection_id = ? OR xingchen_connection_id = ? ORDER BY id')
        .all(row.id, row.id) as { id: number; name: string }[] }
  }
  list() {
    return (this.db.prepare('SELECT * FROM connection ORDER BY kind, id').all() as unknown as StoredConnection[])
      .map(row => {
        const { config, ...summary } = this.decode(row)
        // Selectors need identity field names and caller-header metadata, never signing secrets or addresses.
        const auth = row.kind === 'EXTERNAL_AUTH' ? config as ExternalAuthConfig : null
        return { ...summary, bindings: auth?.bindings ?? [], inputHeader: auth?.inputHeader ?? '', inputPrefix: auth?.inputPrefix ?? '' }
      })
  }
  get(id: number, kind?: ConnectionKind): Connection {
    const row = this.db.prepare('SELECT * FROM connection WHERE id = ?').get(id) as StoredConnection | undefined
    if (!row) throw notFound('连接不存在，请重新选择')
    if (kind && row.kind !== kind) throw bad('所选连接类型不匹配')
    return this.decode(row)
  }
  auth(id: number): ExternalAuthConfig { return this.get(id, 'EXTERNAL_AUTH').config as ExternalAuthConfig }
  platform(id: number): { baseUrl: string } { return this.get(id, 'XINGCHEN').config as { baseUrl: string } }

  save(id: number | undefined, input: JsonObject): Connection {
    const kind = choice(input, 'kind', '连接类型', ['EXTERNAL_AUTH', 'XINGCHEN'] as const)
    const name = text(input, 'name', '连接名称', { max: 100 })
    const config = kind === 'EXTERNAL_AUTH' ? validateExternalAuth(input.config) : validatePlatform(input.config)
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM connection WHERE name = ? AND id IS NOT ?').get(name, id ?? null)) throw conflict('连接名称已存在')
      const at = now()
      const encoded = encrypt(this.config.secretKey, stringify(config))
      if (id === undefined) {
        const result = this.db.prepare('INSERT INTO connection (kind, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(kind, name, encoded, at, at)
        return this.get(Number(result.lastInsertRowid))
      }
      const current = this.get(id)
      if (current.kind !== kind) throw bad('已有连接不能改变类型')
      if (integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER) !== current.version) throw conflict('连接已被修改，请重新载入')
      if (kind === 'EXTERNAL_AUTH') this.checkBindings(id, current.config as ExternalAuthConfig, config as ExternalAuthConfig)
      this.db.prepare('UPDATE connection SET name = ?, config = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(name, encoded, at, id)
      return this.get(id)
    })
  }

  private checkBindings(id: number, previous: ExternalAuthConfig, next: ExternalAuthConfig) {
    const used = this.db.prepare('SELECT mode, sql_text, xingchen FROM api WHERE auth_connection_id = ?').all(id) as
      { mode: string; sql_text: string | null; xingchen: string | null }[]
    for (const api of used) {
      const names = api.mode === 'REALTIME' ? parseSql(api.sql_text!).names
        : api.mode === 'XINGCHEN' && api.xingchen ? [(parse(decrypt(this.config.secretKey, api.xingchen)) as JsonObject).staffCodeBinding] : []
      for (const binding of previous.bindings.filter(binding => names.includes(binding.name))) {
        if (!next.bindings.some(item => item.name === binding.name && item.type === binding.type)) {
          throw conflict(`身份字段 ${binding.name} 正被 API 使用，不能删除或修改类型；请先调整关联 API`)
        }
      }
    }
  }

  remove(id: number) {
    if (this.get(id).usedBy.length) throw conflict('连接正在被 API 使用，请先更换这些 API 的连接')
    this.db.prepare('DELETE FROM connection WHERE id = ?').run(id)
  }

  /** Used inside the API save/migration transaction; identical verifier settings share one connection. */
  reuse(kind: ConnectionKind, config: ConnectionConfig): number {
    const canonical = (value: unknown) => identity(value as Json)
    const rows = this.db.prepare('SELECT * FROM connection WHERE kind = ? ORDER BY id').all(kind) as unknown as StoredConnection[]
    for (const row of rows) {
      const old = this.decode(row).config
      if (kind === 'XINGCHEN') { if (canonical(old) === canonical(config)) return row.id; continue }
      const before = old as ExternalAuthConfig, next = config as ExternalAuthConfig
      if (canonical({ ...before, bindings: [] }) !== canonical({ ...next, bindings: [] })) continue
      if (next.bindings.some(binding => before.bindings.some(item => item.name === binding.name && canonical(item) !== canonical(binding)))) continue
      const bindings = [...before.bindings, ...next.bindings.filter(binding => !before.bindings.some(item => item.name === binding.name))]
      if (bindings.length > 50) continue
      if (bindings.length !== before.bindings.length) this.db.prepare('UPDATE connection SET config = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(encrypt(this.config.secretKey, stringify({ ...before, bindings })), now(), row.id)
      return row.id
    }
    const prefix = kind === 'EXTERNAL_AUTH' ? '导入的身份服务' : '导入的星辰平台'
    let index = 1
    while (this.db.prepare('SELECT 1 FROM connection WHERE name = ?').get(`${prefix} ${index}`)) index++
    const at = now()
    return Number(this.db.prepare('INSERT INTO connection (kind, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, `${prefix} ${index}`, encrypt(this.config.secretKey, stringify(config)), at, at).lastInsertRowid)
  }

  /** Idempotent, atomic migration of existing per-API settings, retaining application credentials per API. */
  migrateLegacy() {
    transaction(this.db, () => {
      const rows = this.db.prepare('SELECT id, external_auth, xingchen, auth_connection_id, xingchen_connection_id FROM api WHERE external_auth IS NOT NULL OR (xingchen IS NOT NULL AND xingchen_connection_id IS NULL)').all() as
        { id: number; external_auth: string | null; xingchen: string | null; auth_connection_id: number | null; xingchen_connection_id: number | null }[]
      for (const row of rows) {
        let authId = row.auth_connection_id, platformId = row.xingchen_connection_id, app = row.xingchen
        if (!authId && row.external_auth) authId = this.reuse('EXTERNAL_AUTH', validateExternalAuth(parse(decrypt(this.config.secretKey, row.external_auth))))
        if (!platformId && row.xingchen) {
          const settings = parse(decrypt(this.config.secretKey, row.xingchen)) as JsonObject
          platformId = this.reuse('XINGCHEN', validatePlatform(settings))
          const { baseUrl: _baseUrl, ...application } = settings
          app = encrypt(this.config.secretKey, stringify(application))
        }
        this.db.prepare('UPDATE api SET auth_connection_id = ?, xingchen_connection_id = ?, external_auth = NULL, xingchen = ?, version = version + 1 WHERE id = ?')
          .run(authId, platformId, app, row.id)
      }
    })
  }
}
