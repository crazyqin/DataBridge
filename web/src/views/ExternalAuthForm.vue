<script setup lang="ts">
import { ref, watch } from 'vue'
import { FIELD_TYPES, type ExternalAuthConfig, type Mode } from '../api'

defineProps<{ mode: Mode }>()
const config = defineModel<ExternalAuthConfig>({ required: true })
const headersText = ref('{}')
const bodyText = ref('{}')
const successText = ref('true')
watch(() => config.value, value => {
  headersText.value = JSON.stringify(value.headers, null, 2)
  bodyText.value = JSON.stringify(value.body, null, 2)
  successText.value = JSON.stringify(value.successValue)
}, { immediate: true })
watch(() => config.value.method, method => {
  if (method === 'GET') config.value.tokenLocation = 'header'
})

function readJson(value: string, label: string): unknown {
  try { return JSON.parse(value) } catch { throw new Error(`${label}不是有效的 JSON`) }
}

function value(): ExternalAuthConfig {
  return {
    ...config.value,
    headers: readJson(headersText.value, '附加 Header') as Record<string, string>,
    body: config.value.method === 'GET' ? {} : readJson(bodyText.value, '附加请求体') as Record<string, unknown>,
    successValue: readJson(successText.value, '成功判定值'),
  }
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
      <el-radio value="json" :disabled="config.method === 'GET'">JSON 字段</el-radio>
      <el-radio value="form" :disabled="config.method === 'GET'">表单字段</el-radio>
    </el-radio-group>
    <span class="muted">从来源 Header 去掉前缀后，将凭证发送给验证服务。</span>
  </el-form-item>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item :label="config.tokenLocation === 'header' ? '目标 Header' : '目标字段'"><el-input v-model="config.tokenName" placeholder="如 Authorization 或 token" /></el-form-item></el-col>
    <el-col :span="12"><el-form-item label="目标前缀"><el-input v-model="config.tokenPrefix" placeholder="如 Bearer 后加一个空格；无前缀则留空" /></el-form-item></el-col>
  </el-row>
  <el-form-item label="附加 Header">
    <el-input v-model="headersText" type="textarea" :rows="2" class="mono" placeholder='{"X-Client-Id":"my-app"}' />
    <span class="muted">JSON 对象，仅发送这里配置的 Header 和凭证。配置加密保存。</span>
  </el-form-item>
  <el-form-item v-if="config.method === 'POST'" label="附加请求体">
    <el-input v-model="bodyText" type="textarea" :rows="2" class="mono" placeholder='{"audience":"data-api"}' />
    <span class="muted">JSON 对象；实际凭证会覆盖同名字段。表单字段仅支持标量值。</span>
  </el-form-item>
  <el-form-item label="成功 HTTP 状态"><el-input-number v-model="config.successStatus" :min="200" :max="299" /></el-form-item>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item label="成功判定路径"><el-input v-model="config.successPath" placeholder="如 active、code；留空仅检查 HTTP 状态" /></el-form-item></el-col>
    <el-col :span="12"><el-form-item label="等于 (JSON)"><el-input v-model="successText" :disabled="!config.successPath" placeholder='如 true、0、"ok"' /></el-form-item></el-col>
  </el-row>
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
