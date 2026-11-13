<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { confirm, request, type Datasource, type DirectoryConfig, type StaffMember } from '../api'
interface DirectoryState { config: DirectoryConfig | null; version: number; snapshotVersion: number; syncedAt: string | null; count: number; running: boolean; nextSyncAt: string | null }
interface SyncRecord { id: number; startedAt: string; finishedAt: string | null; trigger: string; status: string; error: string | null; summary: { before: number; after: number; added: number; removed: number; updated: number; changePercent: number } | null }
const state = ref<DirectoryState>()
const form = ref<DirectoryConfig>({ datasourceId: 0, sql: '', cron: '0 0 2 * * *', timezone: 'Asia/Shanghai', scheduled: true, timeoutSeconds: 60, maxRows: 100000, changeThreshold: 20,
  mapping: { staffNo: '工号', name: '姓名', departments: ['org_name_lv1', 'org_name_lv2', 'org_name_lv3', 'org_name_lv4'], employmentUnified: '用工方式_统一工号', employmentLocal: '用工方式_本地', posts: ['岗位1', '岗位2'] } })
const sources = ref<Datasource[]>([]), history = ref<SyncRecord[]>([]), members = ref<StaffMember[]>([])
const total = ref(0), page = ref(1), search = ref(''), busy = ref(false), previewRows = ref<StaffMember[]>()
const tab = ref('members'), previewOpen = ref(false), previewTruncated = ref(false)
const candidate = ref<{ id: number; total: number; items: { kind: string; person: StaffMember; previous: StaffMember | null }[] }>()
const candidatePage = ref(1), candidateOpen = ref(false)
const statuses: Record<string, string> = { RUNNING: '同步中', SUCCESS: '成功覆盖', FORCED: '已强制覆盖', PENDING: '差异过大，待处理', FAILED: '失败，保留原目录', SUPERSEDED: '候选批次已失效' }
const stamp = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '—'
async function loadMembers() {
  const result = await request<{ total: number; items: StaffMember[] }>(`/admin/directory/members?page=${page.value}&search=${encodeURIComponent(search.value)}`)
  members.value = result.items; total.value = result.total
}
async function refresh() {
  await Promise.all([request<DirectoryState>('/admin/directory').then(value => { state.value = value }),
    request<SyncRecord[]>('/admin/directory/history').then(value => { history.value = value }), loadMembers()])
}
async function save() {
  busy.value = true
  try { state.value = await request('/admin/directory', { method: 'PUT', body: { ...form.value, version: state.value?.version ?? 0 } }); ElMessage.success('目录配置已保存'); await refresh() }
  finally { busy.value = false }
}
async function preview() {
  busy.value = true
  try { const result = await request<{ rows: StaffMember[]; truncated: boolean }>('/admin/directory/preview', { method: 'POST', body: form.value }); previewRows.value = result.rows; previewTruncated.value = result.truncated; previewOpen.value = true }
  finally { busy.value = false }
}
async function sync() {
  busy.value = true
  try { const result = await request<{ status: string }>('/admin/directory/sync', { method: 'POST' }); ElMessage[result.status === 'PENDING' ? 'warning' : 'success'](result.status === 'PENDING' ? '差异超过阈值，已保留原目录，请查看同步历史' : '人员目录已更新'); tab.value = 'history' }
  finally { await refresh(); busy.value = false }
}
async function inspect(id: number, nextPage = 1) {
  const result = await request<{ total: number; items: { kind: string; person: StaffMember; previous: StaffMember | null }[] }>(`/admin/directory/history/${id}/candidate?page=${nextPage}`)
  candidate.value = { id, ...result }; candidatePage.value = nextPage; candidateOpen.value = true
}
async function force(id: number) {
  const record = history.value.find(row => row.id === id)
  if (!await confirm(`将使用批次 #${id} 覆盖当前目录：${record?.summary?.before ?? '—'} → ${record?.summary?.after ?? '—'} 人。人员授权立即按新目录判断。`, '强制覆盖人员目录')) return
  busy.value = true
  try { await request(`/admin/directory/history/${id}/force`, { method: 'POST' }); candidateOpen.value = false; ElMessage.success('已强制覆盖人员目录'); await refresh() }
  finally { busy.value = false }
}
async function older() {
  const last = history.value.at(-1)
  if (last) history.value.push(...await request<SyncRecord[]>(`/admin/directory/history?before=${last.id}`))
}
onMounted(async () => {
  await Promise.all([refresh(), request<Datasource[]>('/admin/datasources').then(value => { sources.value = value })])
  if (state.value?.config) form.value = JSON.parse(JSON.stringify(state.value.config))
})
</script>

<template>
  <div class="page-heading"><div><p class="eyebrow">STAFF DIRECTORY</p><h2>人员目录</h2><p>同步人员、部门、用工方式与岗位，为接口授权提供依据。</p></div><div class="page-actions"><el-button :disabled="busy" @click="refresh">刷新</el-button><el-button type="primary" :disabled="!state?.config || state.running || busy" @click="sync">立即同步</el-button></div></div>
  <div class="info-strip">有效人员 {{ state?.count ?? 0 }} 人 · 目录版本 {{ state?.snapshotVersion ?? 0 }} · 最近成功 {{ stamp(state?.syncedAt) }} · 下次同步 {{ stamp(state?.nextSyncAt) }}</div>
  <el-tabs v-model="tab">
    <el-tab-pane label="人员查询" name="members">
      <div class="toolbar"><el-input v-model="search" clearable placeholder="按工号或姓名搜索" style="max-width:360px" @keyup.enter="page = 1; loadMembers()" /><el-button @click="page = 1; loadMembers()">查询</el-button></div>
      <el-table :data="members" empty-text="尚无人员，请配置数据源并立即同步"><el-table-column prop="staffNo" label="工号" min-width="120" /><el-table-column prop="name" label="姓名" min-width="110" /><el-table-column label="部门" min-width="240"><template #default="{ row }">{{ row.department.filter(Boolean).join(' / ') }}</template></el-table-column><el-table-column prop="employmentUnified" label="用工方式 · 统一" min-width="140" /><el-table-column prop="employmentLocal" label="用工方式 · 本地" min-width="140" /><el-table-column label="岗位" min-width="160"><template #default="{ row }">{{ row.posts.join('、') }}</template></el-table-column></el-table>
      <el-pagination v-model:current-page="page" :total="total" :page-size="50" layout="prev, pager, next, total" @current-change="loadMembers" />
    </el-tab-pane>
    <el-tab-pane label="同步配置" name="config">
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="人员数据源" required><el-select v-model="form.datasourceId" placeholder="选择已配置的数据源"><el-option v-for="source in sources" :key="source.id" :value="source.id" :label="source.name" /></el-select></el-form-item>
        <el-form-item label="人员查询 SQL" required><el-input v-model="form.sql" type="textarea" :rows="7" placeholder="填写返回工号、姓名、部门、用工方式和岗位的只读 SELECT" /></el-form-item>
        <div class="form-grid"><el-form-item label="工号列"><el-input v-model="form.mapping.staffNo" /></el-form-item><el-form-item label="姓名列"><el-input v-model="form.mapping.name" /></el-form-item><el-form-item label="用工方式 · 统一工号列"><el-input v-model="form.mapping.employmentUnified" /></el-form-item><el-form-item label="用工方式 · 本地列"><el-input v-model="form.mapping.employmentLocal" /></el-form-item></div>
        <div class="form-grid"><el-form-item v-for="(_, index) in form.mapping.departments" :key="index" :label="`部门路径第 ${index + 1} 层结果列`"><el-input v-model="form.mapping.departments[index]" /></el-form-item></div>
        <div class="toolbar"><el-button :disabled="form.mapping.departments.length >= 4" @click="form.mapping.departments.push('')">添加部门层级</el-button><el-button :disabled="form.mapping.departments.length <= 1" @click="form.mapping.departments.pop()">移除末级映射</el-button></div>
        <div class="form-grid"><el-form-item v-for="(_, index) in form.mapping.posts" :key="index" :label="`岗位来源列 ${index + 1}`"><el-input v-model="form.mapping.posts[index]" /></el-form-item></div>
        <div class="toolbar"><el-button :disabled="form.mapping.posts.length >= 2" @click="form.mapping.posts.push('')">添加岗位来源</el-button><el-button :disabled="form.mapping.posts.length <= 1" @click="form.mapping.posts.pop()">移除末项岗位来源</el-button></div>
        <p class="muted">部门按路径合并，空层级保留；岗位合并去重，复合岗位名称完整保留。工号必须是文本，以保留前导零。</p>
        <el-form-item label="定时同步"><el-switch v-model="form.scheduled" /></el-form-item>
        <div class="form-grid"><el-form-item label="同步 Cron（秒 分 时 日 月 周）"><el-input v-model="form.cron" /><div class="field-help">默认每天 02:00：0 0 2 * * *</div></el-form-item><el-form-item label="时区"><el-input v-model="form.timezone" /></el-form-item><el-form-item label="数量变化保护阈值（%）"><el-input-number v-model="form.changeThreshold" :min="1" :max="100" /></el-form-item><el-form-item label="最大人数"><el-input-number v-model="form.maxRows" :min="1" :max="1000000" /></el-form-item><el-form-item label="查询超时（秒）"><el-input-number v-model="form.timeoutSeconds" :min="1" :max="120" /></el-form-item></div>
        <p class="muted">比较总人数变化、新增人数及移除人数占原目录的比例。超过阈值或返回空目录时保留旧数据，可查看差异后强制覆盖。同步失败继续使用原目录，无有效期限制。立即同步使用已保存的配置。</p>
        <div class="toolbar"><el-button :disabled="busy" @click="preview">预览 SQL 和映射</el-button><el-button type="primary" :loading="busy" @click="save">保存配置</el-button></div>
      </el-form>
    </el-tab-pane>
    <el-tab-pane label="同步历史" name="history">
      <el-table :data="history"><el-table-column prop="id" label="批次" width="80" /><el-table-column label="开始时间" min-width="180"><template #default="{ row }">{{ stamp(row.startedAt) }}</template></el-table-column><el-table-column label="触发" width="80"><template #default="{ row }">{{ row.trigger === 'MANUAL' ? '手动' : '定时' }}</template></el-table-column><el-table-column label="结果" min-width="170"><template #default="{ row }">{{ statuses[row.status] || row.status }}</template></el-table-column><el-table-column label="差异 / 原因" min-width="320"><template #default="{ row }"><span v-if="row.summary">{{ row.summary.before }} → {{ row.summary.after }} 人；新增 {{ row.summary.added }}，移除 {{ row.summary.removed }}，变更 {{ row.summary.updated }}；数量变化 {{ row.summary.changePercent.toFixed(1) }}%</span><span v-else>{{ row.error || '—' }}</span></template></el-table-column><el-table-column label="操作" width="140"><template #default="{ row }"><el-button v-if="row.status === 'PENDING'" link type="primary" @click="inspect(row.id)">查看差异与覆盖</el-button></template></el-table-column></el-table>
      <el-button v-if="history.length >= 50" @click="older">加载更早记录</el-button>
    </el-tab-pane>
  </el-tabs>
  <el-dialog v-model="previewOpen" title="同步预览（不会覆盖目录）" width="min(1000px, 95vw)"><p>最多预览 20 人{{ previewTruncated ? '，还有更多结果' : '' }}。</p><el-table :data="previewRows"><el-table-column prop="staffNo" label="工号" /><el-table-column prop="name" label="姓名" /><el-table-column label="部门" min-width="250"><template #default="{ row }">{{ row.department.filter(Boolean).join(' / ') }}</template></el-table-column><el-table-column label="岗位"><template #default="{ row }">{{ row.posts.join('、') }}</template></el-table-column><el-table-column prop="employmentUnified" label="统一用工" /><el-table-column prop="employmentLocal" label="本地用工" /></el-table></el-dialog>
  <el-dialog v-model="candidateOpen" title="待覆盖批次差异" width="min(1000px, 95vw)"><template v-if="candidate"><el-table :data="candidate.items"><el-table-column prop="kind" label="变化" width="80" /><el-table-column prop="person.staffNo" label="工号" /><el-table-column prop="person.name" label="姓名" /><el-table-column label="部门" min-width="250"><template #default="{ row }"><span v-if="row.kind === '变更'">{{ row.previous.department.filter(Boolean).join(' / ') }} → </span>{{ row.person.department.filter(Boolean).join(' / ') }}</template></el-table-column><el-table-column label="岗位"><template #default="{ row }"><span v-if="row.kind === '变更'">{{ row.previous.posts.join('、') }} → </span>{{ row.person.posts.join('、') }}</template></el-table-column><el-table-column label="用工方式（统一 / 本地）" min-width="180"><template #default="{ row }"><span v-if="row.kind === '变更'">{{ row.previous.employmentUnified || '空' }} / {{ row.previous.employmentLocal || '空' }} → </span>{{ row.person.employmentUnified || '空' }} / {{ row.person.employmentLocal || '空' }}</template></el-table-column></el-table><el-pagination :current-page="candidatePage" :total="candidate.total" :page-size="50" layout="prev, pager, next, total" @current-change="inspect(candidate.id, $event)" /></template><template #footer><el-button @click="candidateOpen = false">保留原目录</el-button><el-button type="danger" :loading="busy" :disabled="state?.running" @click="force(candidate!.id)">强制覆盖此批次</el-button></template></el-dialog>
</template>
