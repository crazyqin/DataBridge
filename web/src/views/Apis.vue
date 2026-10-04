<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onMounted, ref } from 'vue'
import { confirm, MODE_LABELS, request, type Api } from '../api'
import ApiForm from './ApiForm.vue'
import SyncHistoryDialog from './SyncHistoryDialog.vue'

const apis = ref<Api[]>([])
const editing = ref<Api | null>()
const historyApi = ref<Api | null>(null)

const load = async () => { apis.value = await request<Api[]>('/admin/apis') }
onMounted(load)

async function toggle(api: Api) {
  await request(`/admin/apis/${api.id}/${api.enabled ? 'disable' : 'enable'}`, { method: 'POST' })
  await load()
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
      <div><h2>API 管理</h2><p>发布实时查询、定时同步或手工维护的数据接口</p></div>
      <el-button type="primary" @click="editing = null">新增 API</el-button>
    </div>
    <el-card shadow="never">
      <el-table :data="apis" stripe>
        <el-table-column prop="name" label="名称" min-width="130" />
        <el-table-column label="地址" min-width="200">
          <template #default="{ row }"><code>{{ row.method }} {{ row.path }}</code></template>
        </el-table-column>
        <el-table-column label="模式" width="100">
          <template #default="{ row }">{{ MODE_LABELS[row.mode as Api['mode']] }}</template>
        </el-table-column>
        <el-table-column label="访问" width="130">
          <template #default="{ row }">
            <el-tag :type="row.auth === 'PUBLIC' ? 'info' : 'warning'">{{ row.auth === 'PUBLIC' ? '公开' : row.auth === 'EXTERNAL' ? '外部身份验证' : row.auth === 'API_KEY' ? 'API Key' : '需重新配置' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="同步" width="90">
          <template #default="{ row }">
            <el-tooltip v-if="row.syncError" :content="row.syncError"><el-tag type="danger">失败</el-tag></el-tooltip>
            <el-tag v-else-if="row.syncStatus" type="success">成功</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300">
          <template #default="{ row }">
            <el-button link type="primary" @click="editing = row">编辑</el-button>
            <el-button link @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button v-if="row.mode === 'SNAPSHOT'" link @click="sync(row)">立即同步</el-button>
            <el-button v-if="row.mode === 'SNAPSHOT'" link @click="historyApi = row">同步详情</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </template>
  <SyncHistoryDialog v-if="historyApi" :api="historyApi" @close="historyApi = null" />
</template>
