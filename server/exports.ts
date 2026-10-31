import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Worker } from 'node:worker_threads'
import type { Config } from './config.ts'
import { conflict, HttpError, notFound } from './errors.ts'

export interface ExportJob {
  id: string; filename: string; status: 'RUNNING' | 'READY' | 'FAILED'
  stage: string; detail: string; createdAt: string; expiresAt: string | null
  bytes?: number; sha256?: string; snapshotAt?: string; tableCounts?: Record<string, number>; error?: string
}
interface Task { job: ExportJob; directory: string; worker?: Worker; timer?: NodeJS.Timeout }
const OWNED_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f-]{27}$/
const RETENTION_MS = 60 * 60 * 1000
const TIMEOUT_MS = 30 * 60 * 1000

/** One background export at a time; download files expire and never enter the static web root. */
export class Exports {
  private readonly config: Config
  private readonly root: string
  private readonly tasks = new Map<string, Task>()
  private initialization?: Promise<void>
  private closing = false

  constructor(config: Config) { this.config = config; this.root = join(config.dataDir, '.exports') }

  initialize() {
    return this.initialization ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      // A process restart invalidates the in-memory jobs; remove only our previous job directories.
      for (const name of await readdir(this.root)) if (OWNED_DIRECTORY.test(name)) await rm(join(this.root, name), { recursive: true, force: true })
    })()
  }

  list(): ExportJob[] { return [...this.tasks.values()].map(task => ({ ...task.job })).reverse() }

  private task(id: string) {
    const task = this.tasks.get(id)
    if (!task || task.job.expiresAt && Date.parse(task.job.expiresAt) <= Date.now()) throw notFound('导出任务不存在或已过期，请重新生成')
    return task
  }
  get(id: string): ExportJob { return { ...this.task(id).job } }

  async start(): Promise<ExportJob> {
    await this.initialize()
    if (this.closing) throw new HttpError(503, '服务正在关闭，请稍后重试')
    if ([...this.tasks.values()].some(task => task.job.status === 'RUNNING')) throw conflict('已有导出正在进行，请等待完成或取消后重试')
    // Reserve the running slot before any await, including directory creation.
    const id = randomUUID(), createdAt = new Date().toISOString()
    const task: Task = { directory: join(this.root, id), job: { id, createdAt, expiresAt: null, status: 'RUNNING',
      filename: `databridge-export-${createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${id.slice(0, 8)}.tar.gz`,
      stage: 'snapshot', detail: '正在准备完整导出' } }
    this.tasks.set(id, task)
    try {
      // Keep at most three jobs, removing the oldest completed job when necessary.
      while (this.tasks.size > 3) {
        const oldest = [...this.tasks.values()].find(item => item.job.status !== 'RUNNING')!
        await this.remove(oldest.job.id)
      }
      await mkdir(task.directory, { mode: 0o700 })
      if (this.closing || !this.tasks.has(id)) { await rm(task.directory, { recursive: true, force: true }); throw new Error('Export cancelled') }
      const worker = new Worker(new URL('./export-worker.ts', import.meta.url), { workerData: {
        dbFile: this.config.dbFile, directory: task.directory, secretKey: this.config.secretKey,
        timezone: this.config.timezone, logRetentionDays: this.config.logRetentionDays, filename: task.job.filename,
      } })
      task.worker = worker
      task.timer = setTimeout(() => {
        void worker.terminate().then(() => this.fail(task, '导出超时，请检查数据规模和磁盘空间后重试'))
      }, TIMEOUT_MS).unref()
      worker.on('message', (message: { type: string; stage: string; detail: string; bytes: number; sha256: string; snapshotAt: string; tableCounts: Record<string, number> }) => {
        if (!this.tasks.has(id) || task.job.status !== 'RUNNING') return
        if (message.type === 'progress') { task.job.stage = message.stage; task.job.detail = message.detail }
        if (message.type === 'ready') {
          Object.assign(task.job, { status: 'READY', stage: 'ready', detail: '导出完成，可以下载', bytes: message.bytes,
            sha256: message.sha256, snapshotAt: message.snapshotAt, tableCounts: message.tableCounts })
          this.expire(task)
        }
      })
      worker.on('error', () => { void this.fail(task, '导出失败，请检查磁盘空间和配置数据后重试') })
      worker.on('exit', () => {
        task.worker = undefined
        if (task.job.status === 'RUNNING') void this.fail(task, '导出未完成，请重新生成')
      })
    } catch {
      await this.fail(task, '无法创建导出任务，请检查磁盘空间和目录权限后重试')
    }
    return { ...task.job }
  }

  private expire(task: Task) {
    if (task.timer) clearTimeout(task.timer)
    task.job.expiresAt = new Date(Date.now() + RETENTION_MS).toISOString()
    task.timer = setTimeout(() => { void this.remove(task.job.id).catch(() => {}) }, RETENTION_MS).unref()
  }
  private async fail(task: Task, error: string) {
    if (!this.tasks.has(task.job.id) || task.job.status !== 'RUNNING') return
    Object.assign(task.job, { status: 'FAILED', stage: 'failed', detail: error, error })
    this.expire(task)
    await rm(task.directory, { recursive: true, force: true }).catch(() => {})
  }

  async download(id: string) {
    const task = this.task(id)
    if (task.job.status !== 'READY') throw conflict('导出尚未完成，请等待完成后下载')
    const handle = await open(join(task.directory, task.job.filename), 'r').catch(() => { throw notFound('导出文件已失效，请重新生成') })
    return { job: { ...task.job }, stream: Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array> }
  }

  async remove(id: string) {
    const task = this.tasks.get(id)
    if (!task) throw notFound('导出任务不存在')
    this.tasks.delete(id)
    if (task.timer) clearTimeout(task.timer)
    await task.worker?.terminate()
    await rm(task.directory, { recursive: true, force: true })
  }

  async close() {
    this.closing = true
    await this.initialization?.catch(() => {})
    await Promise.all([...this.tasks.keys()].map(id => this.remove(id)))
  }
}
