import { now, transaction, type Db } from './db.ts'
import { bad, conflict, notFound } from './errors.ts'
import { choice, integer, text } from './input.ts'
import type { Json, JsonObject } from './json.ts'

export interface Project {
  id: number; name: string; description: string; version: number; apiCount: number
  createdAt: string; updatedAt: string
}
const summary = `SELECT p.id, p.name, p.description, p.version, p.created_at AS createdAt, p.updated_at AS updatedAt,
  (SELECT count(*) FROM api_project ap WHERE ap.project_id = p.id) AS apiCount FROM project p`

function ids(value: Json | undefined, label: string, limit: number): number[] {
  if (!Array.isArray(value) || value.length > limit || value.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    throw bad(`${label}必须是有效 ID 数组，最多 ${limit} 个`)
  }
  return [...new Set(value as number[])].sort((a, b) => a - b)
}

/** Organization metadata has its own version so grouping never invalidates scheduled SQL jobs. */
export class Projects {
  private readonly db: Db
  constructor(db: Db) { this.db = db }

  list(): Project[] { return this.db.prepare(summary + ' ORDER BY p.name, p.id').all() as unknown as Project[] }
  get(id: number): Project {
    const project = this.db.prepare(summary + ' WHERE p.id = ?').get(id) as unknown as Project | undefined
    if (!project) throw notFound('项目不存在，请刷新后重新选择')
    return project
  }
  idsForApi(apiId: number): number[] {
    return (this.db.prepare('SELECT project_id AS id FROM api_project WHERE api_id = ? ORDER BY project_id').all(apiId) as { id: number }[]).map(row => row.id)
  }

  save(id: number | undefined, input: JsonObject): Project {
    const name = text(input, 'name', '项目名称', { max: 100, pattern: /^[^\x00-\x1f\x7f]+$/ })
    const description = text(input, 'description', '项目说明', { max: 1000, optional: true })
    return transaction(this.db, () => {
      if (id !== undefined && integer(input, 'version', '版本号', 1, Number.MAX_SAFE_INTEGER) !== this.get(id).version) {
        throw conflict('项目已被修改，请刷新后再编辑')
      }
      if (this.db.prepare('SELECT 1 FROM project WHERE name = ? AND id IS NOT ?').get(name, id ?? null)) throw conflict('项目名称已存在')
      const time = now()
      if (id === undefined) {
        const result = this.db.prepare('INSERT INTO project (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, description, time, time)
        return this.get(Number(result.lastInsertRowid))
      }
      this.db.prepare('UPDATE project SET name = ?, description = ?, version = version + 1, updated_at = ? WHERE id = ?').run(name, description, time, id)
      return this.get(id)
    })
  }

  remove(id: number) {
    transaction(this.db, () => {
      this.get(id)
      this.db.prepare('UPDATE api SET project_version = project_version + 1 WHERE id IN (SELECT api_id FROM api_project WHERE project_id = ?)').run(id)
      this.db.prepare('DELETE FROM project WHERE id = ?').run(id)
    })
  }

  /** Runs inside the API save transaction; omitted projectIds leave existing membership intact. */
  assign(apiId: number, value: Json | undefined, expectedVersion?: number) {
    const next = ids(value, '所属项目', 100)
    const current = this.idsForApi(apiId)
    if (expectedVersion !== undefined) {
      const row = this.db.prepare('SELECT project_version AS version FROM api WHERE id = ?').get(apiId)
      if (row?.version !== expectedVersion) throw conflict('接口所属项目已被修改，请重新载入后再保存')
    }
    for (const id of next) this.get(id)
    if (next.length === current.length && next.every((id, index) => id === current[index])) return
    this.db.prepare('DELETE FROM api_project WHERE api_id = ?').run(apiId)
    const insert = this.db.prepare('INSERT INTO api_project (api_id, project_id) VALUES (?, ?)')
    for (const id of next) insert.run(apiId, id)
    this.db.prepare('UPDATE api SET project_version = project_version + 1 WHERE id = ?').run(apiId)
  }

  changeMembers(projectId: number, input: JsonObject): Project {
    const apiIds = ids(input.apiIds, '接口', 500)
    if (!apiIds.length) throw bad('请至少选择一个接口')
    const operation = choice(input, 'operation', '操作', ['add', 'remove'] as const)
    return transaction(this.db, () => {
      this.get(projectId)
      for (const id of apiIds) {
        if (!this.db.prepare('SELECT 1 FROM api WHERE id = ?').get(id)) throw notFound('部分接口已不存在，请刷新后重新选择')
        const memberships = this.idsForApi(id)
        if (operation === 'add' && !memberships.includes(projectId) && memberships.length >= 100) throw bad('每个接口最多加入 100 个项目')
      }
      const statement = operation === 'add'
        ? this.db.prepare('INSERT OR IGNORE INTO api_project (api_id, project_id) VALUES (?, ?)')
        : this.db.prepare('DELETE FROM api_project WHERE api_id = ? AND project_id = ?')
      for (const id of apiIds) {
        if (statement.run(id, projectId).changes) this.db.prepare('UPDATE api SET project_version = project_version + 1 WHERE id = ?').run(id)
      }
      return this.get(projectId)
    })
  }
}
