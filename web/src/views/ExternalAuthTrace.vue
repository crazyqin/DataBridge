<script setup lang="ts">
import { formatTime, type ExternalAuthTrace } from '../api'

defineProps<{ trace: ExternalAuthTrace }>()
const json = (value: unknown) => JSON.stringify(value, null, 2)
function body(value: string | null) {
  if (value === null) return '未读取响应内容'
  if (!value) return '空响应体'
  return value
}
</script>

<template>
  <div class="auth-trace">
    <el-alert :title="trace.ok ? '身份验证通过' : trace.error || '身份验证失败'" :type="trace.ok ? 'success' : 'error'"
              :description="trace.detail || undefined" :closable="false" show-icon />
    <div class="muted trace-meta">{{ formatTime(trace.at) }} · 验证耗时 {{ trace.elapsedMs }} ms · 凭证、密码和签名摘要已脱敏</div>
    <template v-if="trace.request">
      <h4>发送的验证请求</h4>
      <pre class="result">{{ trace.request.method }} {{ trace.request.url }}</pre>
      <div class="muted">请求 Header</div>
      <pre class="result">{{ json(trace.request.headers) }}</pre>
      <template v-if="trace.request.body !== null">
        <div class="muted">请求体<span v-if="trace.request.truncated">（内容较长，预览已截断）</span></div>
        <pre class="result">{{ body(trace.request.body) }}</pre>
      </template>
    </template>
    <p v-else class="muted">验证请求未发送。</p>
    <template v-if="trace.response">
      <h4>验证服务响应 · HTTP {{ trace.response.status }} {{ trace.response.statusText }}</h4>
      <div class="muted">响应 Header</div>
      <pre class="result">{{ json(trace.response.headers) }}</pre>
      <div class="muted">响应内容<span v-if="trace.response.truncated">（内容较长，预览已截断）</span></div>
      <pre class="result">{{ body(trace.response.body) }}</pre>
    </template>
    <p v-else class="muted">未收到 HTTP 响应，请查看上方失败原因。</p>
    <template v-if="trace.checks.length">
      <h4>成功条件检查</h4>
      <el-table :data="trace.checks" size="small" border>
        <el-table-column prop="path" label="响应字段路径" min-width="130" />
        <el-table-column label="要求值 (JSON)" min-width="110"><template #default="{ row }">{{ json(row.expected) }}</template></el-table-column>
        <el-table-column label="实际值 (JSON)" min-width="110"><template #default="{ row }">{{ row.exists ? json(row.actual) : '字段缺失' }}</template></el-table-column>
        <el-table-column label="结果" width="80"><template #default="{ row }"><el-tag :type="row.matched ? 'success' : 'danger'">{{ row.matched ? '通过' : '失败' }}</el-tag></template></el-table-column>
      </el-table>
    </template>
  </div>
</template>

<style scoped>
.auth-trace { margin-top: 14px; }
.trace-meta { margin-top: 10px; }
h4 { margin: 18px 0 8px; }
pre.result { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
