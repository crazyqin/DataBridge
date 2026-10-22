<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatTime, request, type Api, type ConnectionSummary, type Datasource, type LogStats, type LogWindow } from '../api'
const emit = defineEmits<{ navigate: [page: 'apis' | 'connections' | 'sources' | 'logs']; create: []; failures: [window: LogWindow] }>()
const apis = ref<Api[]>([])
const connections = ref<ConnectionSummary[]>([])
const sources = ref<Datasource[]>([])
const logs = ref<{ id: number; at: string; ok: boolean; apiId: number | null; elapsedMs: number; error: string | null }[]>([])
const stats = ref<LogStats>()
const failureRate = computed(() => stats.value?.total ? `${(stats.value.failed / stats.value.total * 100).toFixed(1)}%` : '—')
const loading = ref(true)
const ready = computed(() => connections.value.length + sources.value.length)
const active = computed(() => apis.value.filter(api => api.enabled).length)
const apiName = (id: number | null) => apis.value.find(api => api.id === id)?.name ?? (id === null ? '未匹配接口' : `已删除接口 #${id}`)
async function load() {
  loading.value = true
  try {
    await Promise.allSettled([
      request<Api[]>('/admin/apis').then(value => { apis.value = value }),
      request<ConnectionSummary[]>('/admin/connections').then(value => { connections.value = value }),
      request<Datasource[]>('/admin/datasources').then(value => { sources.value = value }),
      request<{ items: typeof logs.value }>('/admin/logs?limit=8').then(value => { logs.value = value.items }),
      request<LogStats>('/admin/logs/stats').then(value => { stats.value = value }).catch(() => { stats.value = undefined }),
    ])
  } finally { loading.value = false }
}
onMounted(load)
</script>
<template>
  <div v-loading="loading">
    <div class="page-head"><div><p class="eyebrow">WORKSPACE OVERVIEW</p><h2>工作台</h2><p>连接、接口与运行状态，集中查看。</p></div><div><el-button :loading="loading" @click="load">刷新</el-button><el-button type="primary" @click="emit('create')">创建接口</el-button></div></div>
    <div class="metric-grid">
      <button class="metric-card" @click="emit('navigate', 'apis')"><span>已启用接口</span><strong>{{ active }}<small>/ {{ apis.length }}</small></strong><em>查看全部接口 →</em></button>
      <button class="metric-card" @click="emit('navigate', 'connections')"><span>共享连接</span><strong>{{ connections.length }}</strong><em>身份服务与星辰平台 →</em></button>
      <button class="metric-card" @click="emit('navigate', 'sources')"><span>数据库连接</span><strong>{{ sources.length }}</strong><em>管理 PostgreSQL 数据源 →</em></button>
      <button class="metric-card" :disabled="!stats" :title="stats ? `${formatTime(stats.from)} 至 ${formatTime(stats.to)}` : undefined" @click="stats && emit('failures', { from: stats.from, to: stats.to })">
        <span>近 24 小时失败调用</span><strong :class="{ danger: stats && stats.failed > 0 }">{{ stats?.failed ?? '—' }}</strong>
        <span v-if="stats" class="call-summary">共 {{ stats.total }} 次调用 · {{ stats.total ? `失败率 ${failureRate}` : '暂无调用' }}</span>
        <em>{{ stats ? '查看失败日志 →' : '统计暂不可用，请刷新' }}</em>
      </button>
    </div>
    <section class="editor-section onboarding">
      <div class="section-heading"><h3>{{ apis.length ? '常用操作' : '从一个连接开始' }}</h3><span>连接只配置一次，多个 API 可直接选用</span></div>
      <div class="setup-grid">
        <button class="setup-card" @click="emit('navigate', 'connections')"><span class="step-number">01</span><div><strong>准备共享连接</strong><p>配置身份验证和星辰基础地址。</p><span class="setup-state">{{ ready ? '管理已有连接 →' : '添加第一个连接 →' }}</span></div></button>
        <button class="setup-card" @click="emit('create')"><span class="step-number">02</span><div><strong>创建业务接口</strong><p>选择模式和连接，填写业务参数。</p><span class="setup-state">创建接口 →</span></div></button>
        <button class="setup-card" @click="emit('navigate', 'logs')"><span class="step-number">03</span><div><strong>测试与观察</strong><p>发布后通过日志查看调用结果。</p><span class="setup-state">查看运行记录 →</span></div></button>
      </div>
    </section>
    <el-card shadow="never"><div class="section-heading"><h3>最近调用</h3><el-button text @click="emit('navigate', 'logs')">全部日志 →</el-button></div>
      <el-table :data="logs" empty-text="接口开始接收请求后，最近调用会显示在这里">
        <el-table-column label="接口" min-width="160"><template #default="{ row }">{{ apiName(row.apiId) }}</template></el-table-column>
        <el-table-column label="时间" min-width="175"><template #default="{ row }">{{ formatTime(row.at) }}</template></el-table-column>
        <el-table-column label="结果" width="100"><template #default="{ row }"><el-tag :type="row.ok ? 'success' : 'danger'">{{ row.ok ? '成功' : '失败' }}</el-tag></template></el-table-column>
        <el-table-column label="耗时" width="110"><template #default="{ row }">{{ row.elapsedMs }} ms</template></el-table-column>
        <el-table-column prop="error" label="说明" min-width="200" show-overflow-tooltip />
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.metric-card { display: flex; flex-direction: column; align-items: flex-start; }
.metric-card em { margin-top: auto; }
.metric-card .call-summary { font-size: 12px; margin-bottom: 8px; }
.metric-card:disabled { cursor: default; }
</style>
