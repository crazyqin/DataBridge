<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'
import { confirm, MODE_LABELS, request, type Api, type Project } from '../api'
import ApiForm from './ApiForm.vue'
import ProjectEditor from './ProjectEditor.vue'
import SyncHistoryDialog from './SyncHistoryDialog.vue'
import UiIcon from '../components/UiIcon.vue'

const props = defineProps<{ initialCreate?: boolean }>()
const apis = ref<Api[]>([])
const projects = ref<Project[]>([])
const projectId = ref<number | 'all'>('all')
const currentProject = computed(() => projects.value.find(project => project.id === projectId.value))
const ungrouped = computed(() => apis.value.filter(api => !api.projectIds.length).length)
const projectEditor = ref<Project | null>()
const selected = ref<Api[]>([])
const table = ref<{ clearSelection: () => void }>()
const batchOpen = ref(false)
const batchApiIds = ref<number[]>([])
const targetProjectId = ref<number>()
const grouping = ref(false)
const search = ref('')
const mode = ref('')
const state = ref('')
const loading = ref(false)
const changing = ref<number>()
const copying = ref<number>()
const visible = computed(() => apis.value.filter(api =>
  (projectId.value === 'all' || (projectId.value === 0 ? !api.projectIds.length : api.projectIds.includes(projectId.value))) &&
  (!mode.value || api.mode === mode.value) && (!state.value || (state.value === 'enabled') === api.enabled) &&
  `${api.name} ${api.path} ${api.code}`.toLowerCase().includes(search.value.trim().toLowerCase())))
const editing = ref<Api | null | undefined>(props.initialCreate ? null : undefined)
const historyApi = ref<Api | null>(null)

let loadId = 0
async function load() {
  const current = ++loadId
  loading.value = true
  try {
    const [apiList, projectList] = await Promise.all([request<Api[]>('/admin/apis'), request<Project[]>('/admin/projects')])
    if (current !== loadId) return
    apis.value = apiList; projects.value = projectList
    if (projectId.value !== 'all' && projectId.value !== 0 && !currentProject.value) projectId.value = 'all'
    clearSelection()
  } finally { if (current === loadId) loading.value = false }
}
function clearSelection() { selected.value = []; table.value?.clearSelection() }
watch([projectId, search, mode, state], clearSelection)
function apiProjects(api: Api) { return projects.value.filter(project => api.projectIds.includes(project.id)) }
async function projectSaved(project: Project) {
  projectEditor.value = undefined
  await load()
  projectId.value = project.id
}
async function removeProject(project: Project) {
  if (!await confirm(`删除项目「${project.name}」？项目中的 ${project.apiCount} 个接口及其数据会保留，其他项目归类不受影响。`, '删除项目')) return
  await request(`/admin/projects/${project.id}`, { method: 'DELETE' })
  await load()
  ElMessage.success('项目已删除，接口已保留')
}
function openBatch() {
  batchApiIds.value = selected.value.map(api => api.id!)
  targetProjectId.value = currentProject.value?.id
  batchOpen.value = true
}
async function addToProject() {
  if (!targetProjectId.value || grouping.value) return
  grouping.value = true
  try {
    await request(`/admin/projects/${targetProjectId.value}/apis`, { method: 'PATCH', body: { operation: 'add', apiIds: batchApiIds.value } })
    batchOpen.value = false
    await load()
    ElMessage.success('所选接口已加入项目')
  } finally { grouping.value = false }
}
async function removeFromProject() {
  const project = currentProject.value
  if (!project || grouping.value || !selected.value.length) return
  const ids = selected.value.map(api => api.id!)
  if (!await confirm(`将所选 ${ids.length} 个接口移出「${project.name}」？接口和其他项目归类会保留。`, '移出项目')) return
  grouping.value = true
  try {
    await request(`/admin/projects/${project.id}/apis`, { method: 'PATCH', body: { operation: 'remove', apiIds: ids } })
    await load()
    ElMessage.success('已移出当前项目')
  } finally { grouping.value = false }
}
onMounted(load)

async function edit(api: Api) { editing.value = await request<Api>(`/admin/apis/${api.id}`) }

async function copy(api: Api) {
  if (copying.value !== undefined) return
  copying.value = api.id
  try {
    editing.value = await request<Api>(`/admin/apis/${api.id}/copy`, { method: 'POST' })
    ElMessage.success('已复制为草稿，可修改配置后启用')
  } finally { copying.value = undefined }
}

async function toggle(api: Api) {
  changing.value = api.id
  try { await request(`/admin/apis/${api.id}/${api.enabled ? 'disable' : 'enable'}`, { method: 'POST' }); await load() } finally { changing.value = undefined }
}

async function sync(api: Api) {
  try {
    const result = await request<{ count: number }>(`/admin/apis/${api.id}/sync`, { method: 'POST' })
    ElMessage.success(`同步完成，${result.count} 行`)
  } finally {
    await load()
  }
}

async function remove(api: Api) {
  if (!await confirm(`删除 API「${api.name}」及其本地数据？`, '确认删除')) return
  await request(`/admin/apis/${api.id}`, { method: 'DELETE' })
  await load()
}

async function closeForm() {
  editing.value = undefined
  await load()
}
</script>

<template>
  <ApiForm v-if="editing !== undefined" :api="editing" :initial-project-id="currentProject?.id" @close="closeForm" />
  <template v-else>
    <div class="page-head">
      <div><p class="eyebrow">API MANAGEMENT</p><h2>接口管理</h2><p>按 skill 或业务功能整理项目，集中管理相关接口。</p></div>
      <el-button type="primary" @click="editing = null"><UiIcon name="plus" />创建接口</el-button>
    </div>
    <div class="summary-strip"><span><strong>{{ apis.length }}</strong> 全部接口</span><span><i class="status-dot"></i><strong>{{ apis.filter(api => api.enabled).length }}</strong> 已启用</span><span><strong>{{ apis.filter(api => !api.enabled).length }}</strong> 草稿 / 已停用</span></div>
    <div class="project-workspace">
      <aside class="project-sidebar" aria-label="接口项目">
        <div class="project-sidebar-head"><strong>项目</strong><el-button text type="primary" @click="projectEditor = null"><UiIcon name="plus" />新建项目</el-button></div>
        <nav class="project-navigation" aria-label="项目筛选">
          <button type="button" :class="{ active: projectId === 'all' }" :aria-current="projectId === 'all' ? 'true' : undefined" @click="projectId = 'all'"><UiIcon name="apis" /><span>全部接口</span><small>{{ apis.length }}</small></button>
          <button type="button" :class="{ active: projectId === 0 }" :aria-current="projectId === 0 ? 'true' : undefined" @click="projectId = 0"><UiIcon name="folder" /><span>未归类</span><small>{{ ungrouped }}</small></button>
          <div class="project-divider"></div>
          <button v-for="project in projects" :key="project.id" type="button" :class="{ active: projectId === project.id }" :title="project.name" :aria-current="projectId === project.id ? 'true' : undefined" @click="projectId = project.id"><UiIcon name="folder" /><span>{{ project.name }}</span><small>{{ project.apiCount }}</small></button>
        </nav>
        <p v-if="!projects.length" class="project-hint">建一个项目，把同一 skill 使用的接口放在一起。</p>
      </aside>
    <el-card shadow="never" class="project-content" v-loading="loading">
      <div class="project-heading">
        <div><h3>{{ currentProject?.name || (projectId === 0 ? '未归类' : '全部接口') }}</h3><p>{{ currentProject?.description || (projectId === 0 ? '尚未加入项目的接口，可勾选后批量归类。' : currentProject ? '一个接口可被多个项目复用。' : '从这里查看所有接口，或勾选后加入项目。') }}</p></div>
        <div v-if="currentProject" class="project-actions"><el-button text @click="projectEditor = currentProject">编辑项目</el-button><el-button text type="danger" @click="removeProject(currentProject)">删除项目</el-button></div>
      </div>
      <div class="table-toolbar">
        <el-input v-model="search" clearable placeholder="搜索名称、路径或编码" style="max-width: 320px"><template #prefix><UiIcon name="search" /></template></el-input>
        <el-select v-model="mode" clearable placeholder="全部模式" style="width: 165px"><el-option v-for="(label, key) in MODE_LABELS" :key="key" :value="key" :label="label" /></el-select>
        <el-select v-model="state" clearable placeholder="全部状态" style="width: 140px"><el-option value="enabled" label="已启用" /><el-option value="draft" label="草稿 / 已停用" /></el-select>
        <el-button text @click="load"><UiIcon name="refresh" />刷新</el-button>
      </div>
      <div v-if="selected.length" class="project-batch"><span>已选 {{ selected.length }} 个接口</span><el-button type="primary" plain :disabled="grouping || !projects.length" @click="openBatch">加入项目</el-button><el-button v-if="currentProject" :loading="grouping" @click="removeFromProject">移出当前项目</el-button><el-button text @click="clearSelection">取消选择</el-button></div>
      <el-table ref="table" :data="visible" row-key="id" :empty-text="currentProject ? '项目内暂无匹配接口，可创建接口或从全部接口中勾选加入' : '暂无匹配接口，点击右上角创建接口'" @selection-change="selected = $event">
        <el-table-column type="selection" width="44" />
        <el-table-column label="接口名称" min-width="175"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="muted">{{ row.code }}</div><div v-if="row.projectIds.length" class="api-project-tags" :title="apiProjects(row).map(project => project.name).join('、')"><el-tag v-for="project in apiProjects(row).slice(0, 2)" :key="project.id" size="small" type="info">{{ project.name }}</el-tag><span v-if="row.projectIds.length > 2" class="muted">+{{ row.projectIds.length - 2 }}</span></div></template></el-table-column>
        <el-table-column label="地址" min-width="200">
          <template #default="{ row }"><span class="method-badge">{{ row.method }}</span> <code>{{ row.path }}</code></template>
        </el-table-column>
        <el-table-column label="模式" width="150">
          <template #default="{ row }">{{ MODE_LABELS[row.mode as Api['mode']] }}</template>
        </el-table-column>
        <el-table-column label="使用连接" min-width="170"><template #default="{ row }">
          <div>{{ row.authConnectionName || (row.auth === 'PUBLIC' ? '公开访问' : row.auth === 'API_KEY' ? 'API Key' : '未配置') }}</div>
          <div v-if="row.xingchenConnectionName" class="muted">{{ row.xingchenConnectionName }}</div>
        </template></el-table-column>
        <el-table-column label="启用" width="75"><template #default="{ row }"><el-switch :model-value="row.enabled" :loading="changing === row.id" :aria-label="`${row.name} 启用状态`" @change="toggle(row)" /></template></el-table-column>
        <el-table-column label="同步" width="90">
          <template #default="{ row }">
            <el-tooltip v-if="row.syncError" :content="row.syncError"><el-tag type="danger">失败</el-tag></el-tooltip>
            <el-tag v-else-if="row.syncStatus" type="success">成功</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <div class="api-row-actions">
              <el-button link type="primary" :disabled="copying !== undefined" @click="edit(row)">编辑</el-button>
              <el-dropdown trigger="click" :disabled="copying !== undefined"><el-button link type="primary" :loading="copying === row.id" :disabled="copying !== undefined">更多</el-button><template #dropdown><el-dropdown-menu>
                <el-dropdown-item v-if="row.mode === 'SNAPSHOT'" @click="sync(row)">立即同步</el-dropdown-item>
                <el-dropdown-item v-if="row.mode === 'SNAPSHOT'" @click="historyApi = row">同步详情</el-dropdown-item>
                <el-dropdown-item @click="copy(row)">复制接口</el-dropdown-item>
                <el-dropdown-item @click="remove(row)">删除接口</el-dropdown-item>
              </el-dropdown-menu></template></el-dropdown>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    </div>
  </template>
  <ProjectEditor v-if="projectEditor !== undefined" :project="projectEditor || undefined" @close="projectEditor = undefined" @saved="projectSaved" />
  <el-dialog v-model="batchOpen" title="加入项目" width="440px" :close-on-click-modal="!grouping" :close-on-press-escape="!grouping" :show-close="!grouping">
    <p class="muted">将所选 {{ batchApiIds.length }} 个接口加入项目，已有归类会保留。</p>
    <el-select v-model="targetProjectId" filterable placeholder="选择项目" aria-label="目标项目" style="width: 100%"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" /></el-select>
    <template #footer><el-button :disabled="grouping" @click="batchOpen = false">取消</el-button><el-button type="primary" :disabled="!targetProjectId" :loading="grouping" @click="addToProject">确认加入</el-button></template>
  </el-dialog>
  <SyncHistoryDialog v-if="historyApi" :api="historyApi" @close="historyApi = null" />
</template>

<style scoped>
.api-row-actions { display: flex; align-items: center; gap: 16px; }
.api-row-actions .el-dropdown { display: inline-flex; align-items: center; }
.project-workspace { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 18px; align-items: start; }
.project-sidebar { min-width: 0; padding: 12px; background: #fff; border: 1px solid var(--line); border-radius: 12px; }
.project-sidebar-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 4px 10px; }
.project-sidebar-head strong { font-size: 13px; }
.project-sidebar-head .el-button { padding: 6px; }
.project-navigation { display: grid; gap: 4px; max-height: 65vh; overflow-y: auto; }
.project-navigation button { display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; padding: 10px; border: 0; border-radius: 7px; background: transparent; color: var(--ink); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.project-navigation button:hover { background: #f4f7fd; }
.project-navigation button.active { background: #edf2ff; color: #2c63df; font-weight: 600; }
.project-navigation button span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-navigation button small { font-variant-numeric: tabular-nums; color: var(--muted); }
.project-divider { height: 1px; margin: 8px; background: var(--line); }
.project-hint { padding: 0 8px; font-size: 12px; line-height: 1.8; color: var(--muted); }
.project-content { min-width: 0; }
.project-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
.project-heading > div:first-child { min-width: 0; }
.project-heading h3 { margin: 0 0 8px; font-size: 17px; overflow-wrap: anywhere; }
.project-heading p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.project-actions { display: flex; flex-shrink: 0; }
.project-batch { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; font-size: 12px; color: var(--muted); }
.api-project-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.api-project-tags .el-tag { max-width: 100%; }
.api-project-tags :deep(.el-tag__content) { overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 1000px) {
  .project-workspace { grid-template-columns: minmax(0, 1fr); }
  .project-navigation { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); max-height: 190px; }
  .project-divider { display: none; }
}
@media (max-width: 760px) {
  .project-heading { flex-wrap: wrap; }
  .project-navigation { grid-template-columns: minmax(0, 1fr); max-height: 160px; }
}
</style>
