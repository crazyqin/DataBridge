<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { formatTime, MODE_LABELS, request, type Api, type CallDetails, type CallStage, type LogWindow } from '../api'
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
const stages: Record<CallStage, string> = { request: '读取请求', routing: '匹配接口', access: '访问检查', identity: '身份验证',
  query: '参数校验与查询', forward: '参数校验与转发', response: '生成响应', stream: '流式传输' }
const authLabels = { PUBLIC: '公开访问', API_KEY: 'API Key', EXTERNAL: '外部身份验证' }
const bytes = (value: number) => value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`
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
    detailTab.value = 'request'
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
    <div><p class="eyebrow">REQUEST ACTIVITY</p><h2>调用日志</h2><p>查看完整请求、响应预览与身份验证详情；凭证和密码等敏感字段已脱敏</p></div>
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
        <template #default="{ row }">
          <button v-if="!row.ok" class="log-failure" type="button" aria-label="查看失败详情"
                  :title="row.error || '未记录具体错误，点击查看详情'" @click="inspect(row)"><el-tag type="danger">失败</el-tag></button>
          <el-tag v-else type="success">成功</el-tag>
          <div v-if="row.status" class="muted">HTTP {{ row.status }}</div>
        </template>
      </el-table-column>
      <el-table-column prop="requestId" label="Request ID" min-width="150" show-overflow-tooltip />
      <el-table-column label="调用详情" width="110" fixed="right"><template #default="{ row }">
        <el-button link type="primary" :loading="loadingDetail === row.id" @click="inspect(row)">查看详情</el-button>
      </template></el-table-column>
    </el-table>
    <div v-if="nextBefore" style="text-align: center; margin-top: 12px"><el-button :loading="loading" @click="load(true)">加载更多</el-button></div>
  </el-card>
  <el-dialog v-model="showDetail" title="调用详情" width="min(960px, 94vw)" class="call-detail">
    <template v-if="detail && detailRow">
      <div class="call-status"><el-tag :type="detailRow.ok ? 'success' : 'danger'">{{ detailRow.ok ? '调用成功' : '调用失败' }}</el-tag>
        <span v-if="detail.request?.status || detailRow.status">HTTP {{ detail.request?.status || detailRow.status }} {{ detail.request?.statusText }}</span>
        <span>总耗时 {{ detailRow.elapsedMs }} ms</span><span v-if="detailRow.mode !== 'XINGCHEN'">返回 {{ detailRow.rowCount }} 行</span>
      </div>
      <dl class="call-facts">
        <div><dt>接口名称</dt><dd>{{ detail.request?.api?.name || apiName(detailRow.apiId) }}<span v-if="detail.request?.api?.id || detailRow.apiId"> · #{{ detail.request?.api?.id || detailRow.apiId }}</span></dd></div>
        <div><dt>调用时间</dt><dd>{{ formatTime(detailRow.at) }}</dd></div>
        <div v-if="detail.request?.api"><dt>接口编码 / 版本</dt><dd>{{ detail.request.api.code }} · v{{ detail.request.api.version }}</dd></div>
        <div><dt>数据模式</dt><dd>{{ MODE_LABELS[detailRow.mode as Api['mode']] || detailRow.mode || '未匹配接口' }}</dd></div>
        <div><dt>来源 IP</dt><dd>{{ detail.request?.clientAddress && detail.request.clientAddress !== 'unknown' ? detail.request.clientAddress : '未记录' }}</dd></div>
        <div v-if="detail.request?.api"><dt>访问方式</dt><dd>{{ authLabels[detail.request.api.auth] }}</dd></div>
        <div class="full-width"><dt>Request ID</dt><dd><code>{{ detailRow.requestId }}</code></dd></div>
      </dl>
      <h4>请求地址<span v-if="detail.request?.urlTruncated" class="muted"> · 地址较长，已截断</span></h4>
      <pre class="result request-address"><span v-if="detail.request?.method || detailRow.method" class="method-badge">{{ detail.request?.method || detailRow.method }}</span>{{ detail.request?.url || detail.request?.path || detailRow.path || '旧日志未记录请求地址' }}</pre>
      <p v-if="!detail.request?.url && (detail.request?.path || detailRow.path)" class="muted">旧日志仅记录请求路径，未记录协议、主机和端口。</p>
      <el-alert v-if="detailRow.error" :title="detailRow.error" type="error" :closable="false" show-icon />
      <p v-if="detail.request?.errorStage" class="muted">失败阶段：{{ stages[detail.request.errorStage] }}</p>
      <div v-if="detail.request?.steps?.length" class="call-steps" aria-label="各处理阶段耗时">
        <div v-for="(step, index) in detail.request.steps" :key="index" :class="{ failed: !step.ok }"><span>{{ stages[step.stage] }}</span><strong>{{ step.elapsedMs }} ms</strong><small>{{ step.ok ? '完成' : '失败' }}</small></div>
      </div>
      <el-tabs v-model="detailTab">
        <el-tab-pane label="请求与结果" name="request">
          <template v-if="detail.request">
            <h4>查询参数（URL）<span v-if="detail.request.queryTruncated" class="muted"> · 内容较长，已截断</span></h4>
            <pre class="result">{{ detail.request.query }}</pre>
            <template v-if="!['GET', 'HEAD'].includes(detail.request.method)">
              <h4>请求体（JSON）<span v-if="detail.request.bodyTruncated" class="muted"> · 内容较长，已截断</span></h4>
              <p v-if="detail.request.bodyNote" class="muted">{{ detail.request.bodyNote }}</p>
              <pre v-else class="result">{{ detail.request.body || '空请求体' }}</pre>
            </template>
            <h4>请求 Header（已脱敏）</h4>
              <p v-if="detail.request.headersTruncated" class="muted">内容较长，已截断</p>
              <pre class="result">{{ detail.request.headers }}</pre>
            <template v-if="detail.request.parameters !== undefined">
              <h4>业务参数<span v-if="detail.request.parametersTruncated" class="muted"> · 内容较长，已截断</span></h4>
              <p v-if="detail.request.pagination" class="muted">分页：第 {{ detail.request.pagination.page }} 页 · 每页 {{ detail.request.pagination.pageSize }} 条</p>
              <pre class="result">{{ detail.request.parameters }}</pre>
            </template>
            <h4>响应信息</h4>
            <p class="muted">HTTP {{ detail.request.status }} {{ detail.request.statusText }}<span v-if="detail.request.responseType"> · {{ detail.request.responseType }}</span><span v-if="detail.request.responseBytes !== undefined"> · {{ bytes(detail.request.responseBytes) }}</span></p>
            <h4>响应 Header（已脱敏）<span v-if="detail.request.responseHeadersTruncated" class="muted"> · 内容较长，已截断</span></h4>
            <pre v-if="detail.request.responseHeaders !== undefined" class="result">{{ detail.request.responseHeaders }}</pre>
            <p v-else class="muted">旧日志未记录响应 Header。</p>
            <h4>响应正文预览<span v-if="detail.request.responseBodyTruncated" class="muted"> · 内容较长，已截断</span></h4>
            <pre v-if="detail.request.responseBody != null" class="result response-body">{{ detail.request.responseBody || '空响应体' }}</pre>
            <p v-else class="muted">{{ detail.request.responseBodyNote || '旧日志未记录响应正文。' }}</p>
            <dl v-if="detail.request.stream" class="call-facts">
              <div><dt>接收字节</dt><dd>{{ bytes(detail.request.stream.bytes) }}</dd></div><div><dt>已识别事件</dt><dd>{{ detail.request.stream.events }}</dd></div>
              <div><dt>最后事件</dt><dd>{{ detail.request.stream.lastEvent || '未收到事件' }}</dd></div><div><dt>结束状态</dt><dd>{{ detailRow.ok ? '正常结束' : '异常结束，原因见上方' }}</dd></div>
            </dl>
            <el-collapse v-if="detail.request.api"><el-collapse-item title="调用时的接口配置" name="configuration">
              <dl class="call-facts">
                <div class="full-width"><dt>配置路径</dt><dd>{{ detail.request.api.method }} {{ detail.request.api.path }}</dd></div>
                <div><dt>超时上限</dt><dd>{{ detail.request.api.timeoutSeconds }} 秒</dd></div>
                <div v-if="detail.request.api.mode !== 'XINGCHEN'"><dt>最大行数</dt><dd>{{ detail.request.api.maxRows }}</dd></div>
                <div v-if="detail.request.api.datasourceId"><dt>数据源 ID</dt><dd>#{{ detail.request.api.datasourceId }}</dd></div>
                <div v-if="detail.request.api.authConnectionId"><dt>身份服务</dt><dd>{{ detail.request.api.authConnectionName }} · #{{ detail.request.api.authConnectionId }}</dd></div>
                <div v-if="detail.request.api.xingchenConnectionId"><dt>星辰连接</dt><dd>{{ detail.request.api.xingchenConnectionName }} · #{{ detail.request.api.xingchenConnectionId }}</dd></div>
                <div v-if="detail.request.api.syncAt"><dt>快照同步时间</dt><dd>{{ formatTime(detail.request.api.syncAt) }}</dd></div>
              </dl>
            </el-collapse-item></el-collapse>
            <p class="muted">请求地址、参数、Header 和正文各保留最多 8 KiB 的脱敏预览。SSE 流内失败时 HTTP 状态仍可能为 200，请结合调用结果和结束状态判断。</p>
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
.log-failure { border: 0; padding: 0; background: transparent; vertical-align: middle; cursor: pointer; }
.call-detail pre.result { white-space: pre-wrap; overflow-wrap: anywhere; }
.call-detail h4 { margin-bottom: 8px; }
:global(.call-detail .el-dialog__body) { max-height: 72vh; overflow-y: auto; }
.call-status { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 13px; }
.call-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; margin: 18px 0; font-size: 12px; }
.call-facts > div { min-width: 0; }
.call-facts .full-width { grid-column: 1 / -1; }
.call-facts dt { color: var(--muted); margin-bottom: 5px; }
.call-facts dd { margin: 0; overflow-wrap: anywhere; line-height: 1.7; }
.call-steps { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
.call-steps > div { display: grid; gap: 5px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 110px; font-size: 11px; }
.call-steps strong { font-size: 13px; font-weight: 550; }
.call-steps small { color: var(--muted); }
.call-steps .failed { border-color: var(--el-color-danger-light-5); color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
@media (max-width: 600px) {
  .call-facts { grid-template-columns: 1fr; }
  .call-status { gap: 8px; font-size: 12px; }
  .call-steps > div { min-width: 0; flex: 1 0 40%; }
}
</style>
