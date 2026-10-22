<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { formatTime, MODE_LABELS, request, type Api, type CallDetails, type LogWindow } from '../api'
import ExternalAuthTrace from './ExternalAuthTrace.vue'
import UiIcon from '../components/UiIcon.vue'

interface LogItem { id: number; requestId: string; at: string; apiId: number | null; mode: string | null; elapsedMs: number; rowCount: number; ok: boolean; error: string | null; hasExternalAuth: boolean; hasRequest: boolean; method: string | null; path: string | null; status: number | null }

const props = defineProps<{ failedWindow?: LogWindow }>()
const apis = ref<Api[]>([])
const items = ref<LogItem[]>([])
const loading = ref(false)
let sequence = 0
const nextBefore = ref<number | null>(null)
const detail = ref<CallDetails>()
const detailRow = ref<LogItem>()
const detailTab = ref('request')
const showDetail = ref(false)
const loadingDetail = ref<number>()
const filter = reactive({ apiId: undefined as number | undefined, ok: props.failedWindow ? false : undefined as boolean | undefined,
  range: props.failedWindow ? [new Date(props.failedWindow.from), new Date(props.failedWindow.to)] as [Date, Date] : null })

watch(() => props.failedWindow, value => {
  filter.apiId = undefined
  filter.ok = value ? false : undefined
  filter.range = value ? [new Date(value.from), new Date(value.to)] : null
  load()
})

async function load(more = false) {
  const current = ++sequence
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filter.apiId) params.set('apiId', String(filter.apiId))
    if (filter.ok !== undefined) params.set('ok', String(filter.ok))
    if (filter.range) {
      params.set('from', filter.range[0].toISOString())
      params.set('to', filter.range[1].toISOString())
    }
    if (more && nextBefore.value) params.set('before', String(nextBefore.value))
    const page = await request<{ items: LogItem[]; nextBefore: number | null }>(`/admin/logs?${params}`)
    if (current !== sequence) return
    items.value = more ? [...items.value, ...page.items] : page.items
    nextBefore.value = page.nextBefore
  } finally { if (current === sequence) loading.value = false }
}

const apiName = (id: number | null) => apis.value.find(api => api.id === id)?.name ?? (id === null ? '未匹配接口' : `已删除接口 #${id}`)

async function inspect(row: LogItem) {
  loadingDetail.value = row.id
  try {
    const value = await request<CallDetails>(`/admin/logs/${row.id}/details`)
    if (loadingDetail.value !== row.id) return
    detail.value = value
    detailRow.value = row
    detailTab.value = value.request ? 'request' : 'auth'
    showDetail.value = true
  } finally { if (loadingDetail.value === row.id) loadingDetail.value = undefined }
}

onMounted(async () => {
  apis.value = await request<Api[]>('/admin/apis')
  await load()
})
</script>

<template>
  <div class="page-head">
    <div><p class="eyebrow">REQUEST ACTIVITY</p><h2>调用日志</h2><p>查看请求参数、HTTP 状态与身份验证详情；凭证和密码等敏感字段已脱敏</p></div>
  </div>
  <div class="toolbar">
    <el-select v-model="filter.apiId" clearable placeholder="全部 API" style="width: 200px">
      <el-option v-for="api in apis" :key="api.id" :label="api.name" :value="api.id!" />
    </el-select>
    <el-select v-model="filter.ok" clearable placeholder="全部结果" style="width: 130px">
      <el-option label="成功" :value="true" /><el-option label="失败" :value="false" />
    </el-select>
    <el-date-picker v-model="filter.range" type="datetimerange" start-placeholder="开始时间" end-placeholder="结束时间" />
    <el-button type="primary" :loading="loading" @click="load()"><UiIcon v-if="!loading" name="search" />查询</el-button><el-button @click="filter.apiId = undefined; filter.ok = undefined; filter.range = null; load()"><UiIcon name="refresh" />重置</el-button>
  </div>
  <el-card shadow="never" v-loading="loading">
    <el-table :data="items" empty-text="当前条件下没有调用记录">
      <el-table-column label="时间" min-width="165"><template #default="{ row }">{{ formatTime(row.at) }}</template></el-table-column>
      <el-table-column label="API" min-width="130"><template #default="{ row }">{{ apiName(row.apiId) }}</template></el-table-column>
      <el-table-column label="请求" width="90"><template #default="{ row }"><span v-if="row.method" class="method-badge">{{ row.method }}</span><span v-else class="muted" title="旧日志未记录请求方法">—</span></template></el-table-column>
      <el-table-column label="模式" width="145"><template #default="{ row }">{{ MODE_LABELS[row.mode as Api['mode']] || row.mode }}</template></el-table-column>
      <el-table-column prop="elapsedMs" label="耗时 (ms)" width="100" />
      <el-table-column prop="rowCount" label="行数" width="80" />
      <el-table-column label="结果" width="80">
        <template #default="{ row }"><el-tag :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '成功' : '失败' }}</el-tag><div v-if="row.status" class="muted">HTTP {{ row.status }}</div></template>
      </el-table-column>
      <el-table-column prop="error" label="错误" min-width="180" show-overflow-tooltip />
      <el-table-column prop="requestId" label="Request ID" min-width="150" show-overflow-tooltip />
      <el-table-column label="调用详情" width="110" fixed="right"><template #default="{ row }">
        <el-button v-if="row.hasRequest || row.hasExternalAuth" link type="primary" :loading="loadingDetail === row.id" @click="inspect(row)">查看详情</el-button>
        <span v-else class="muted">—</span>
      </template></el-table-column>
    </el-table>
    <div v-if="nextBefore" style="text-align: center; margin-top: 12px"><el-button :loading="loading" @click="load(true)">加载更多</el-button></div>
  </el-card>
  <el-dialog v-model="showDetail" title="调用详情" width="min(960px, 94vw)" class="call-detail">
    <template v-if="detail && detailRow">
      <div class="muted">Request ID：{{ detailRow.requestId }}</div>
      <p>{{ formatTime(detailRow.at) }} · {{ detailRow.elapsedMs }} ms · {{ detailRow.ok ? '成功' : '失败' }} · 返回 {{ detailRow.rowCount }} 行</p>
      <el-alert v-if="detailRow.error" :title="detailRow.error" type="error" :closable="false" show-icon />
      <el-tabs v-model="detailTab">
        <el-tab-pane label="请求与结果" name="request">
          <template v-if="detail.request">
            <p><span class="method-badge">{{ detail.request.method }}</span></p>
            <p>HTTP {{ detail.request.status }}<span v-if="detail.request.responseType"> · {{ detail.request.responseType }}</span></p>
            <h4>查询参数（URL）<span v-if="detail.request.queryTruncated" class="muted"> · 内容较长，已截断</span></h4>
            <pre class="result">{{ detail.request.query }}</pre>
            <template v-if="detail.request.method === 'POST'">
              <h4>请求体（JSON）<span v-if="detail.request.bodyTruncated" class="muted"> · 内容较长，已截断</span></h4>
              <p v-if="detail.request.bodyNote" class="muted">{{ detail.request.bodyNote }}</p>
              <pre v-else class="result">{{ detail.request.body || '空请求体' }}</pre>
            </template>
            <el-collapse><el-collapse-item title="请求 Header（已脱敏）" name="headers">
              <p v-if="detail.request.headersTruncated" class="muted">内容较长，已截断</p>
              <pre class="result">{{ detail.request.headers }}</pre>
            </el-collapse-item></el-collapse>
            <p class="muted">请求内容各保留最多 8 KiB。结果显示状态、耗时和行数，不保存业务响应正文；SSE 流内失败时 HTTP 状态仍可能为 200。</p>
          </template>
          <el-empty v-else description="旧日志未记录请求参数，升级后的新调用会显示在这里" />
        </el-tab-pane>
        <el-tab-pane label="身份验证" name="auth">
          <ExternalAuthTrace v-if="detail.externalAuth" :trace="detail.externalAuth" />
          <el-empty v-else description="本次调用没有外部身份验证详情" />
        </el-tab-pane>
      </el-tabs>
    </template>
  </el-dialog>
</template>

<style scoped>
.call-detail pre.result { white-space: pre-wrap; overflow-wrap: anywhere; }
.call-detail h4 { margin-bottom: 8px; }
</style>
