<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { formatTime, request, type Api, type ExternalAuthTrace as AuthTrace } from '../api'
import ExternalAuthTrace from './ExternalAuthTrace.vue'

interface LogItem { id: number; requestId: string; at: string; apiId: number | null; mode: string | null; elapsedMs: number; rowCount: number; ok: boolean; error: string | null; hasExternalAuth: boolean }

const apis = ref<Api[]>([])
const items = ref<LogItem[]>([])
const nextBefore = ref<number | null>(null)
const detail = ref<AuthTrace>()
const detailRequestId = ref('')
const showDetail = ref(false)
const loadingDetail = ref<number>()
const filter = reactive({ apiId: undefined as number | undefined, ok: undefined as boolean | undefined, range: null as [Date, Date] | null })

async function load(more = false) {
  const params = new URLSearchParams()
  if (filter.apiId) params.set('apiId', String(filter.apiId))
  if (filter.ok !== undefined) params.set('ok', String(filter.ok))
  if (filter.range) {
    params.set('from', filter.range[0].toISOString())
    params.set('to', filter.range[1].toISOString())
  }
  if (more && nextBefore.value) params.set('before', String(nextBefore.value))
  const page = await request<{ items: LogItem[]; nextBefore: number | null }>(`/admin/logs?${params}`)
  items.value = more ? [...items.value, ...page.items] : page.items
  nextBefore.value = page.nextBefore
}

const apiName = (id: number | null) => apis.value.find(api => api.id === id)?.name ?? id

async function inspect(row: LogItem) {
  loadingDetail.value = row.id
  try {
    detail.value = await request<AuthTrace>(`/admin/logs/${row.id}/external-auth`)
    detailRequestId.value = row.requestId
    showDetail.value = true
  } finally { loadingDetail.value = undefined }
}

onMounted(async () => {
  apis.value = await request<Api[]>('/admin/apis')
  await load()
})
</script>

<template>
  <div class="page-head">
    <div><h2>调用日志</h2><p>记录结果与错误摘要；外部身份验证可查看脱敏后的请求和响应详情</p></div>
  </div>
  <div class="toolbar">
    <el-select v-model="filter.apiId" clearable placeholder="全部 API" style="width: 200px">
      <el-option v-for="api in apis" :key="api.id" :label="api.name" :value="api.id!" />
    </el-select>
    <el-select v-model="filter.ok" clearable placeholder="全部结果" style="width: 130px">
      <el-option label="成功" :value="true" /><el-option label="失败" :value="false" />
    </el-select>
    <el-date-picker v-model="filter.range" type="datetimerange" start-placeholder="开始时间" end-placeholder="结束时间" />
    <el-button type="primary" @click="load()">查询</el-button>
  </div>
  <el-card shadow="never">
    <el-table :data="items" stripe>
      <el-table-column label="时间" min-width="165"><template #default="{ row }">{{ formatTime(row.at) }}</template></el-table-column>
      <el-table-column label="API" min-width="130"><template #default="{ row }">{{ apiName(row.apiId) }}</template></el-table-column>
      <el-table-column prop="mode" label="模式" width="110" />
      <el-table-column prop="elapsedMs" label="耗时 (ms)" width="100" />
      <el-table-column prop="rowCount" label="行数" width="80" />
      <el-table-column label="结果" width="80">
        <template #default="{ row }"><el-tag :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '成功' : '失败' }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="error" label="错误" min-width="180" show-overflow-tooltip />
      <el-table-column prop="requestId" label="Request ID" min-width="150" show-overflow-tooltip />
      <el-table-column label="身份验证" width="110"><template #default="{ row }">
        <el-button v-if="row.hasExternalAuth" link type="primary" :loading="loadingDetail === row.id" @click="inspect(row)">查看详情</el-button>
        <span v-else class="muted">—</span>
      </template></el-table-column>
    </el-table>
    <div v-if="nextBefore" style="text-align: center; margin-top: 12px"><el-button @click="load(true)">加载更多</el-button></div>
  </el-card>
  <el-dialog v-model="showDetail" title="外部身份验证详情" width="min(900px, 92vw)">
    <div class="muted">Request ID：{{ detailRequestId }}</div>
    <ExternalAuthTrace v-if="detail" :trace="detail" />
  </el-dialog>
</template>
