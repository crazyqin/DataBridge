<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { formatTime, request } from '../api'
import UiIcon from '../components/UiIcon.vue'

interface ExportJob {
  id: string; filename: string; status: 'RUNNING' | 'READY' | 'FAILED'; stage: string; detail: string
  createdAt: string; expiresAt: string | null; bytes?: number; sha256?: string; snapshotAt?: string
  tableCounts?: Record<string, number>; error?: string
}
const jobs = ref<ExportJob[]>([])
const starting = ref(false)
const loading = ref(false)
const removing = ref<string>()
const downloading = ref<string>()
const connectionError = ref(false)
const running = computed(() => jobs.value.some(job => job.status === 'RUNNING'))
const bytes = (value = 0) => value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`
const labels = { RUNNING: '正在生成', READY: '可以下载', FAILED: '生成失败' }
const stages: Record<string, number> = { snapshot: 10, tables: 30, configuration: 55, analysis: 70, archive: 90, ready: 100 }
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let pollGeneration = 0

async function load(quiet = false) {
  if (loading.value) return
  loading.value = true
  try {
    jobs.value = await request<ExportJob[]>('/admin/exports', { silent: quiet })
    connectionError.value = false
  } catch { connectionError.value = true }
  finally { loading.value = false }
}
async function poll() {
  const generation = ++pollGeneration
  if (timer) clearTimeout(timer)
  await load(true)
  if (!disposed && generation === pollGeneration) timer = setTimeout(poll, running.value ? 1500 : 15000)
}
async function download(job: ExportJob) {
  if (downloading.value) return
  downloading.value = job.id
  try {
    const current = await request<ExportJob>(`/admin/exports/${job.id}`)
    if (current.status !== 'READY') return ElMessage.warning('导出尚未完成')
    const link = document.createElement('a')
    link.href = `/admin/exports/${job.id}/download`
    link.download = job.filename
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally { downloading.value = undefined }
}
async function start() {
  if (starting.value || running.value) return
  starting.value = true
  try {
    const job = await request<ExportJob>('/admin/exports', { method: 'POST' })
    jobs.value = [job, ...jobs.value.filter(item => item.id !== job.id)].slice(0, 3)
    ElMessage.success('导出任务已创建，可在本页查看进度并下载')
    if (timer) clearTimeout(timer)
    void poll()
  } finally { starting.value = false }
}
async function remove(job: ExportJob) {
  if (removing.value) return
  removing.value = job.id
  try {
    await request(`/admin/exports/${job.id}`, { method: 'DELETE' })
    jobs.value = jobs.value.filter(item => item.id !== job.id)
    ElMessage.success(job.status === 'RUNNING' ? '导出已取消' : '导出文件已删除')
  } finally { removing.value = undefined }
}
onMounted(poll)
onUnmounted(() => { disposed = true; if (timer) clearTimeout(timer) })
</script>

<template>
  <div class="page-head">
    <div><h2>完整导出</h2><p>打包下载全部配置、业务数据和调用日志，附 CSV / JSONL / SQLite 及分析示例</p></div>
    <el-button type="primary" :loading="starting" :disabled="running" @click="start"><UiIcon name="exports" />生成完整导出包</el-button>
  </div>
  <el-alert title="导出包不做脱敏，包含已保存的凭据、内部地址和数据库加密密钥，请妥善保管。" description="生成后可下载 1 小时，最多保留最近 3 个任务，服务重启后需重新生成。" type="warning" :closable="false" class="export-notice" />
  <el-alert v-if="connectionError" title="暂时无法更新导出状态，正在重试。可点击刷新重新获取。" type="warning" :closable="false" class="export-notice" />
  <el-card shadow="never">
    <template #header><div class="export-heading"><strong>导出任务</strong><el-button text :loading="loading" @click="load()"><UiIcon name="refresh" />刷新</el-button></div></template>
    <el-empty v-if="!jobs.length" description="还没有导出任务，点击上方按钮开始生成" :image-size="80" />
    <article v-for="job in jobs" :key="job.id" class="export-job">
      <div class="export-heading">
        <div><el-tag :type="job.status === 'FAILED' ? 'danger' : job.status === 'READY' ? 'success' : 'info'">{{ labels[job.status] }}</el-tag><span class="export-time">{{ formatTime(job.createdAt) }}</span></div>
        <div class="export-actions">
          <el-button v-if="job.status === 'READY'" type="primary" :loading="downloading === job.id" @click="download(job)"><UiIcon name="exports" />下载导出包 · {{ bytes(job.bytes) }}</el-button>
          <el-button text :loading="removing === job.id" :disabled="!!removing && removing !== job.id" @click="remove(job)">{{ job.status === 'RUNNING' ? '取消导出' : '删除文件' }}</el-button>
        </div>
      </div>
      <p class="export-filename">{{ job.filename }}</p>
      <template v-if="job.status === 'RUNNING'"><el-progress :percentage="stages[job.stage] || 5" :show-text="false" /><p>{{ job.detail }}</p></template>
      <el-alert v-if="job.status === 'FAILED'" :title="job.error || '生成失败，请重试'" type="error" :closable="false" />
      <template v-if="job.status === 'READY'">
        <p>调用日志 {{ job.tableCounts?.request_log ?? 0 }} 条 · 业务数据 {{ job.tableCounts?.api_row ?? 0 }} 行 · 接口 {{ job.tableCounts?.api ?? 0 }} 个</p>
        <p class="export-note">快照：{{ formatTime(job.snapshotAt) }} · 下载有效期至：{{ formatTime(job.expiresAt || undefined) }}</p>
        <details><summary>查看 SHA-256 校验值</summary><code class="export-hash">{{ job.sha256 }}</code></details>
      </template>
    </article>
  </el-card>
</template>

<style scoped>
.export-note { color: var(--secondary); line-height: 1.8; font-size: 13px; }
.export-notice { margin-bottom: 20px; }
.export-heading, .export-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.export-time { color: var(--muted); margin-left: 12px; font-size: 12px; }
.export-job + .export-job { border-top: 1px solid var(--line); margin-top: 24px; padding-top: 24px; }
.export-filename, .export-hash { overflow-wrap: anywhere; font-size: 12px; }
.export-hash { display: block; padding-top: 10px; }
summary { cursor: pointer; font-size: 12px; color: var(--muted); }
</style>
