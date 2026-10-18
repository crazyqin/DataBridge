<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { confirm, MODE_LABELS, request, type Api } from '../api'
import ApiForm from './ApiForm.vue'
import SyncHistoryDialog from './SyncHistoryDialog.vue'

const props = defineProps<{ initialCreate?: boolean }>()
const apis = ref<Api[]>([])
const search = ref('')
const mode = ref('')
const state = ref('')
const loading = ref(false)
const changing = ref<number>()
const copying = ref<number>()
const visible = computed(() => apis.value.filter(api => (!mode.value || api.mode === mode.value) && (!state.value || (state.value === 'enabled') === api.enabled) && `${api.name} ${api.path} ${api.code}`.toLowerCase().includes(search.value.toLowerCase())))
const editing = ref<Api | null | undefined>(props.initialCreate ? null : undefined)
const historyApi = ref<Api | null>(null)

const load = async () => { loading.value = true; try { apis.value = await request<Api[]>('/admin/apis') } finally { loading.value = false } }
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
  <ApiForm v-if="editing !== undefined" :api="editing" @close="closeForm" />
  <template v-else>
    <div class="page-head">
      <div><p class="eyebrow">API MANAGEMENT</p><h2>接口管理</h2><p>查看发布状态，管理业务配置与共享连接。</p></div>
      <el-button type="primary" @click="editing = null">创建接口</el-button>
    </div>
    <div class="summary-strip"><span><strong>{{ apis.length }}</strong> 全部接口</span><span><i class="status-dot"></i><strong>{{ apis.filter(api => api.enabled).length }}</strong> 已启用</span><span><strong>{{ apis.filter(api => !api.enabled).length }}</strong> 草稿 / 已停用</span></div>
    <el-card shadow="never" v-loading="loading">
      <div class="table-toolbar">
        <el-input v-model="search" clearable placeholder="搜索名称、路径或编码" style="max-width: 320px" />
        <el-select v-model="mode" clearable placeholder="全部模式" style="width: 165px"><el-option v-for="(label, key) in MODE_LABELS" :key="key" :value="key" :label="label" /></el-select>
        <el-select v-model="state" clearable placeholder="全部状态" style="width: 140px"><el-option value="enabled" label="已启用" /><el-option value="draft" label="草稿 / 已停用" /></el-select>
        <el-button text @click="load">刷新</el-button>
      </div>
      <el-table :data="visible" empty-text="暂无匹配接口，点击右上角创建接口">
        <el-table-column label="接口名称" min-width="155"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="muted">{{ row.code }}</div></template></el-table-column>
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
        <el-table-column label="操作" width="195">
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
  <SyncHistoryDialog v-if="historyApi" :api="historyApi" @close="historyApi = null" />
</template>

<style scoped>
.api-row-actions { display: flex; align-items: center; gap: 16px; }
.api-row-actions .el-dropdown { display: inline-flex; align-items: center; }
</style>
