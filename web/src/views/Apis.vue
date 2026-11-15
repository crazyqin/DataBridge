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
function projectCommand(command: 'create' | 'edit' | 'remove') {
  if (command === 'create') projectEditor.value = null
  else if (command === 'edit') projectEditor.value = currentProject.value
  else if (currentProject.value) removeProject(currentProject.value)
}
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
      <h2>接口管理</h2>
      <el-button type="primary" @click="editing = null"><UiIcon name="plus" />创建接口</el-button>
    </div>
    <el-card shadow="never" v-loading="loading">
      <div class="table-toolbar">
        <el-select v-model="projectId" aria-label="项目" style="width: 190px">
          <el-option value="all" :label="`全部接口（${apis.length}）`" />
          <el-option :value="0" :label="`未归类（${ungrouped}）`" />
          <el-option v-for="project in projects" :key="project.id" :value="project.id" :label="`${project.name}（${project.apiCount}）`" />
        </el-select>
        <el-input v-model="search" clearable placeholder="搜索名称、路径或编码" style="max-width: 280px"><template #prefix><UiIcon name="search" /></template></el-input>
        <el-select v-model="mode" clearable placeholder="全部模式" style="width: 140px"><el-option v-for="(label, key) in MODE_LABELS" :key="key" :value="key" :label="label" /></el-select>
        <el-select v-model="state" clearable placeholder="全部状态" style="width: 130px"><el-option value="enabled" label="已启用" /><el-option value="draft" label="草稿 / 已停用" /></el-select>
        <el-dropdown trigger="click" class="toolbar-count" @command="projectCommand"><el-button text>管理项目</el-button><template #dropdown><el-dropdown-menu>
          <el-dropdown-item command="create">新建项目</el-dropdown-item>
          <el-dropdown-item v-if="currentProject" command="edit">编辑「{{ currentProject.name }}」</el-dropdown-item>
          <el-dropdown-item v-if="currentProject" command="remove">删除「{{ currentProject.name }}」</el-dropdown-item>
        </el-dropdown-menu></template></el-dropdown>
      </div>
      <p v-if="currentProject?.description" class="project-description">{{ currentProject.description }}</p>
      <div v-if="selected.length" class="project-batch"><span>已选 {{ selected.length }} 个接口</span><el-button type="primary" plain :disabled="grouping || !projects.length" @click="openBatch">加入项目</el-button><el-button v-if="currentProject" :loading="grouping" @click="removeFromProject">移出当前项目</el-button><el-button text @click="clearSelection">取消选择</el-button></div>
      <el-table ref="table" :data="visible" row-key="id" :empty-text="currentProject ? '项目内暂无接口，可在全部项目中勾选接口加入' : '暂无匹配接口，点击右上角创建接口'" @selection-change="selected = $event">
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
          <el-tag v-if="row.auth === 'EXTERNAL'" :type="row.accessPolicy.enabled ? 'success' : 'warning'" size="small">{{ row.accessPolicy.enabled ? '人员授权已开启' : '未开启人员授权' }}</el-tag>
          <div v-if="row.xingchenConnectionName" class="muted">{{ row.xingchenConnectionName }}</div>
        </template></el-table-column>
        <el-table-column label="启用" width="75"><template #default="{ row }"><el-switch :model-value="row.enabled" :loading="changing === row.id" :aria-label="`${row.name} 启用状态`" @change="toggle(row)" /></template></el-table-column>
        <el-table-column v-if="apis.some(api => api.mode === 'SNAPSHOT')" label="同步" width="90">
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
.project-description { margin: -4px 0 16px; color: var(--muted); font-size: 12px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.project-batch { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; font-size: 12px; color: var(--muted); }
.api-project-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.api-project-tags .el-tag { max-width: 100%; }
.api-project-tags :deep(.el-tag__content) { overflow: hidden; text-overflow: ellipsis; }
</style>
