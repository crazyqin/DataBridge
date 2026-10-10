<script setup lang="ts">
import { ref, watch } from 'vue'
import { FIELD_TYPES, type ExternalAuthConfig, type Mode } from '../api'

defineProps<{ mode: Mode }>()
const config = defineModel<ExternalAuthConfig>({ required: true })
const headersText = ref('{}')
const dynamicHeadersText = ref('{}')
const bodyText = ref('{}')
const successText = ref('true')
const conditions = ref<{ path: string; valueText: string }[]>([])
watch(() => config.value, value => {
  headersText.value = JSON.stringify(value.headers, null, 2)
  dynamicHeadersText.value = JSON.stringify(value.dynamicHeaders ?? {}, null, 2)
  bodyText.value = JSON.stringify(value.body, null, 2)
  successText.value = JSON.stringify(value.successValue)
  conditions.value = (value.successConditions ?? []).map(condition => ({ path: condition.path, valueText: JSON.stringify(condition.value) }))
}, { immediate: true })
watch(() => config.value.method, method => {
  if (method === 'GET' && ['json', 'form'].includes(config.value.tokenLocation)) config.value.tokenLocation = 'header'
})

function readJson(value: string, label: string): unknown {
  try { return JSON.parse(value) } catch { throw new Error(`${label}不是有效的 JSON`) }
}

function value(): ExternalAuthConfig {
  return {
    ...config.value,
    headers: readJson(headersText.value, '附加 Header') as Record<string, string>,
    dynamicHeaders: readJson(dynamicHeadersText.value, '动态 Header') as ExternalAuthConfig['dynamicHeaders'],
    body: config.value.method === 'GET' ? {} : readJson(bodyText.value, '附加请求体') as Record<string, unknown>,
    successValue: readJson(successText.value, '成功判定值'),
    successConditions: conditions.value.map((condition, index) => ({
      path: condition.path, value: readJson(condition.valueText, `附加成功条件第 ${index + 1} 项的判定值`),
    })),
  }
}

function signatureExample() {
  dynamicHeadersText.value = JSON.stringify({
    'X-Call-Time': { type: 'timestamp', unit: 'milliseconds' },
    'X-Digest': {
      type: 'digest', algorithm: 'md5', encoding: 'hex', parts: [
        { type: 'literal', value: 'client-id' },
        { type: 'digest', algorithm: 'md5', encoding: 'hex', parts: [{ type: 'literal', value: 'client-secret' }] },
        { type: 'timestamp', unit: 'milliseconds' },
      ],
    },
  }, null, 2)
}
defineExpose({ value })
</script>

<template>
  <el-divider content-position="left">外部身份验证</el-divider>
  <el-form-item label="验证地址">
    <el-input v-model="config.url" placeholder="https://identity.example.com/verify" />
  </el-form-item>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item label="验证请求方式">
      <el-select v-model="config.method"><el-option label="GET" value="GET" /><el-option label="POST" value="POST" /></el-select>
    </el-form-item></el-col>
    <el-col :span="12"><el-form-item label="验证超时 (秒)">
      <el-input-number v-model="config.timeoutSeconds" :min="1" :max="30" />
    </el-form-item></el-col>
  </el-row>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item label="凭证来源 Header"><el-input v-model="config.inputHeader" placeholder="Authorization" /></el-form-item></el-col>
    <el-col :span="12"><el-form-item label="来源前缀"><el-input v-model="config.inputPrefix" placeholder="如 Bearer 后加一个空格；无前缀则留空" /></el-form-item></el-col>
  </el-row>
  <el-form-item label="凭证传递位置">
    <el-radio-group v-model="config.tokenLocation">
      <el-radio value="header">Header</el-radio>
      <el-radio value="query">查询参数</el-radio>
      <el-radio value="json" :disabled="config.method === 'GET'">JSON 字段</el-radio>
      <el-radio value="form" :disabled="config.method === 'GET'">表单字段</el-radio>
    </el-radio-group>
    <span class="muted">从来源 Header 去掉前缀后，将凭证发送给验证服务。对应 Python requests 的 params 时，选择「查询参数」。</span>
  </el-form-item>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item :label="config.tokenLocation === 'header' ? '目标 Header' : '目标字段'"><el-input v-model="config.tokenName" placeholder="如 Authorization 或 token" /></el-form-item></el-col>
    <el-col :span="12"><el-form-item label="目标前缀"><el-input v-model="config.tokenPrefix" placeholder="如 Bearer 后加一个空格；无前缀则留空" /></el-form-item></el-col>
  </el-row>
  <p v-if="config.tokenLocation === 'query'" class="muted">目标字段是验证地址中的查询参数名，区分大小写且必须与验证服务要求的名称完全一致，例如 userToken。</p>
  <el-form-item label="附加 Header">
    <el-input v-model="headersText" type="textarea" :rows="2" class="mono" placeholder='{"X-Client-Id":"my-app"}' />
    <span class="muted">JSON 对象，填写验证服务需要的固定 Header。配置加密保存。</span>
  </el-form-item>
  <el-form-item label="动态 Header">
    <div style="width: 100%">
      <el-input v-model="dynamicHeadersText" type="textarea" :rows="6" class="mono" placeholder='{"X-Call-Time":{"type":"timestamp","unit":"milliseconds"}}' />
      <el-button v-if="dynamicHeadersText.trim() === '{}'" text type="primary" @click="signatureExample">填入时间戳和摘要示例</el-button>
      <div class="muted">JSON 对象；literal 为固定文本，timestamp 为毫秒或秒时间戳，digest 按 parts 顺序拼接后计算摘要，支持 md5 / sha256 / sha512 和 hex / base64，可嵌套。一次请求共用一个时间戳，动态值覆盖同名固定 Header。</div>
    </div>
  </el-form-item>
  <el-form-item v-if="config.method === 'POST'" label="附加请求体">
    <el-input v-model="bodyText" type="textarea" :rows="2" class="mono" placeholder='{"audience":"data-api"}' />
    <span class="muted">JSON 对象；实际凭证会覆盖同名字段。表单字段仅支持标量值。</span>
  </el-form-item>
  <el-form-item label="成功 HTTP 状态"><el-input-number v-model="config.successStatus" :min="200" :max="299" /></el-form-item>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item label="成功判定路径"><el-input v-model="config.successPath" placeholder="如 active、code；留空跳过此项" /></el-form-item></el-col>
    <el-col :span="12"><el-form-item label="等于 (JSON)"><el-input v-model="successText" :disabled="!config.successPath" placeholder='如 true、0、"ok"' /></el-form-item></el-col>
  </el-row>
  <el-form-item label="附加成功条件">
    <div style="width: 100%">
      <el-table :data="conditions" size="small" empty-text="未配置附加条件">
        <el-table-column label="响应字段路径">
          <template #default="{ row }"><el-input v-model="row.path" placeholder="如 data.status、data.enabled" /></template>
        </el-table-column>
        <el-table-column label="等于 (JSON)">
          <template #default="{ row }"><el-input v-model="row.valueText" placeholder='如 "active"、true、0' /></template>
        </el-table-column>
        <el-table-column width="65"><template #default="{ $index }"><el-button link type="danger" @click="conditions.splice($index, 1)">删除</el-button></template></el-table-column>
      </el-table>
      <el-button text type="primary" :disabled="conditions.length >= 20" @click="conditions.push({ path: '', valueText: 'true' })">+ 添加条件</el-button>
      <div class="muted">HTTP 状态、成功判定和所有附加条件必须同时满足，才能提取身份参数并查询数据。最多 20 条；字符串需用双引号，路径不能重复。无响应字段条件时仅检查 HTTP 状态。</div>
    </div>
  </el-form-item>
  <el-form-item label="身份参数映射">
    <div style="width: 100%">
      <el-table :data="config.bindings" size="small" empty-text="未配置映射：仅验证访问身份">
        <el-table-column label="SQL 参数名">
          <template #default="{ row }"><el-input v-model="row.name" placeholder="_auth_subject" /></template>
        </el-table-column>
        <el-table-column label="响应字段路径">
          <template #default="{ row }"><el-input v-model="row.path" placeholder="data.user.id" /></template>
        </el-table-column>
        <el-table-column label="参数类型" width="135">
          <template #default="{ row }"><el-select v-model="row.type"><el-option v-for="type in FIELD_TYPES" :key="type" :value="type" :label="type" /></el-select></template>
        </el-table-column>
        <el-table-column width="65"><template #default="{ $index }"><el-button link type="danger" @click="config.bindings.splice($index, 1)">删除</el-button></template></el-table-column>
      </el-table>
      <el-button text type="primary" :disabled="mode !== 'REALTIME'" @click="config.bindings.push({ name: '_auth_', path: '', type: 'string' })">+ 添加映射</el-button>
      <div class="muted">实时查询可用 :_auth_subject 等参数限定数据范围。路径按点分隔，如 data.user.id；每项映射都必须有值并在 SQL 中使用，调用者不能覆盖。</div>
      <div v-if="mode !== 'REALTIME'" class="muted">当前模式只验证访问身份，不支持身份参数映射。</div>
    </div>
  </el-form-item>
  <el-divider />
</template>
