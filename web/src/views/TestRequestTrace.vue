<script setup lang="ts">
import { formatTime } from '../api'
import type { RequestTrace } from '../request-trace'

defineProps<{ trace: RequestTrace; externalAuth?: boolean }>()
const json = (value: unknown) => JSON.stringify(value, null, 2)
</script>

<template>
  <section class="test-trace" aria-label="浏览器与 DataBridge 的测试请求和返回">
    <h3>浏览器与 DataBridge 的测试请求和返回</h3>
    <p class="muted">浏览器通过 POST 将测试配置提交给 DataBridge。<span v-if="externalAuth">外部身份服务使用配置中的 GET / POST 方式，实际请求请查看「外部身份服务请求与响应」。</span></p>
    <div class="muted">{{ formatTime(trace.at) }} · {{ trace.completed ? `耗时 ${trace.elapsedMs} ms` : '测试进行中' }} · 敏感凭证已脱敏</div>
    <el-alert v-if="trace.error" :title="trace.error" type="error" :closable="false" show-icon />
    <el-row :gutter="20">
      <el-col :xs="24" :lg="12">
        <h4>浏览器 → DataBridge：提交测试配置</h4>
        <pre class="result">{{ trace.request.method }} {{ trace.request.url }}</pre>
        <div class="muted">请求 Header</div>
        <pre class="result">{{ json(trace.request.headers) }}</pre>
        <div class="muted">请求正文</div>
        <pre class="result">{{ trace.request.body === null ? '无请求正文' : trace.request.body }}</pre>
      </el-col>
      <el-col :xs="24" :lg="12">
        <h4>DataBridge → 浏览器：测试结果<span v-if="trace.response"> · HTTP {{ trace.response.status }} {{ trace.response.statusText }}</span></h4>
        <template v-if="trace.response">
          <div class="muted">响应 Header（包括 Request ID）</div>
          <pre class="result">{{ json(trace.response.headers) }}</pre>
          <div class="muted">响应正文</div>
          <pre class="result">{{ trace.response.body === null ? '响应正文未读取完成' : trace.response.body || '空响应正文' }}</pre>
        </template>
        <p v-else class="muted">{{ trace.completed ? '未收到服务器的 HTTP 响应，请查看上方错误原因。' : '等待服务器返回…' }}</p>
      </el-col>
    </el-row>
  </section>
</template>

<style scoped>
.test-trace { margin-top: 20px; border-top: 1px solid #e7ecf2; padding-top: 4px; }
h3 { font-size: 16px; margin-bottom: 8px; }
h4 { margin: 16px 0 8px; }
.el-alert { margin-top: 12px; }
pre.result { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
