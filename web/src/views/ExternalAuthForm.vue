<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { FIELD_TYPES, FIELD_TYPE_LABELS, type ExternalAuthConfig, type Mode } from '../api'
import ScalarValue from './ScalarValue.vue'

defineProps<{ mode: Mode; shared?: boolean }>()
const config = defineModel<ExternalAuthConfig>({ required: true })
const headers = ref<{ name: string; value: string }[]>([])
const dynamicHeadersText = ref('{}')
const bodyText = ref('{}')
const advanced = ref<string[]>([])
const signature = ref({ clientId: '', clientSecret: '', clientHeader: 'X-Client-Id', timeHeader: 'X-Call-Time', digestHeader: 'X-Digest' })
const showSignature = ref(false)
watch(() => config.value, value => {
  value.successConditions ??= []
  headers.value = Object.entries(value.headers).map(([name, value]) => ({ name, value }))
  dynamicHeadersText.value = JSON.stringify(value.dynamicHeaders ?? {}, null, 2)
  bodyText.value = JSON.stringify(value.body, null, 2)
  if (headers.value.length || Object.keys(value.dynamicHeaders ?? {}).length || Object.keys(value.body).length) advanced.value = ['advanced']
}, { immediate: true })
watch(() => config.value.method, method => {
  if (method === 'GET' && ['json', 'form'].includes(config.value.tokenLocation)) config.value.tokenLocation = 'header'
})
const destination = computed(() => ({ header: '请求头', query: 'URL 查询参数', json: 'JSON 字段', form: '表单字段' })[config.value.tokenLocation])
function readObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`${label}不是有效的 JSON`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象`)
  return parsed as Record<string, unknown>
}
function value(): ExternalAuthConfig {
  const names = headers.value.map(header => header.name.trim().toLowerCase())
  if (names.some(name => !name) || new Set(names).size !== names.length) throw new Error('附加请求头名称不能为空或重复')
  return {
    ...config.value,
    headers: Object.fromEntries(headers.value.map(header => [header.name.trim(), header.value])),
    dynamicHeaders: readObject(dynamicHeadersText.value, '动态 Header') as ExternalAuthConfig['dynamicHeaders'],
    body: config.value.method === 'GET' ? {} : readObject(bodyText.value, '附加请求体'),
  }
}
function preset(kind: string) {
  config.value.inputHeader = 'Authorization'
  config.value.inputPrefix = 'Bearer '
  config.value.tokenLocation = kind === 'bearer' ? 'header' : kind === 'query' ? 'query' : 'json'
  config.value.tokenName = kind === 'bearer' ? 'Authorization' : 'token'
  config.value.tokenPrefix = kind === 'bearer' ? 'Bearer ' : ''
  config.value.method = kind === 'query' ? 'GET' : 'POST'
}
function applySignature() {
  try {
    const s = signature.value
    if (![s.clientId, s.clientSecret, s.clientHeader, s.timeHeader, s.digestHeader].every(Boolean)) throw new Error('请完整填写签名字段')
    const names = [s.clientHeader, s.timeHeader, s.digestHeader].map(name => name.toLowerCase())
    if (new Set(names).size !== names.length) throw new Error('三个请求头名称不能相同')
    const dynamic = readObject(dynamicHeadersText.value, '动态 Header')
    if (Object.keys(dynamic).some(name => names.includes(name.toLowerCase())) || headers.value.some(header => names.includes(header.name.toLowerCase()))) {
      throw new Error('签名请求头与已有配置重名，请先移除对应旧项或使用其他名称')
    }
    dynamic[s.timeHeader] = { type: 'timestamp', unit: 'milliseconds' }
    dynamic[s.digestHeader] = { type: 'digest', algorithm: 'md5', encoding: 'hex', parts: [
      { type: 'literal', value: s.clientId },
      { type: 'digest', algorithm: 'md5', encoding: 'hex', parts: [{ type: 'literal', value: s.clientSecret }] },
      { type: 'timestamp', unit: 'milliseconds' },
    ] }
    headers.value.push({ name: s.clientHeader, value: s.clientId })
    dynamicHeadersText.value = JSON.stringify(dynamic, null, 2)
    s.clientSecret = ''
    showSignature.value = false
    ElMessage.success('已生成签名配置，保存 API 后生效')
  } catch (error) { ElMessage.error((error as Error).message) }
}
defineExpose({ value })
</script>

<template>
  <el-divider content-position="left">外部身份验证</el-divider>
  <div class="auth-guide">调用者携带凭证 → DataBridge 请求身份服务 → 检查成功条件 → 取得工号或用户信息</div>
  <div class="config-step"><strong>1 · 调用者怎样提供凭证</strong><p>这是调用当前 /open/ 接口时携带的请求头。</p></div>
  <el-form-item label="快捷填入">
    <el-button size="small" @click="preset('bearer')">Bearer 直接转交</el-button>
    <el-button size="small" @click="preset('query')">转为查询参数</el-button>
    <el-button size="small" @click="preset('json')">转为 JSON 字段</el-button>
    <div class="muted">仅填写凭证传递相关字段；选择后可继续修改。</div>
  </el-form-item>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item label="来源请求头"><el-input v-model="config.inputHeader" placeholder="Authorization" /></el-form-item></el-col>
    <el-col :span="12"><el-form-item label="移除的前缀"><el-input v-model="config.inputPrefix" placeholder="如 Bearer 后加一个空格；可留空" /></el-form-item></el-col>
  </el-row>
  <div class="config-step"><strong>2 · 将凭证发给哪个身份服务</strong><p>按身份服务的文档填写地址、接收位置和字段名。</p></div>
  <el-form-item label="验证地址"><el-input v-model="config.url" placeholder="https://identity.example.com/verify" /></el-form-item>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item label="验证请求方式">
      <el-select v-model="config.method"><el-option label="GET" value="GET" /><el-option label="POST" value="POST" /></el-select>
    </el-form-item></el-col>
    <el-col :span="12"><el-form-item label="验证超时 (秒)"><el-input-number v-model="config.timeoutSeconds" :min="1" :max="30" /></el-form-item></el-col>
  </el-row>
  <el-form-item label="服务接收位置">
    <el-radio-group v-model="config.tokenLocation">
      <el-radio value="header">请求头</el-radio><el-radio value="query">查询参数</el-radio>
      <el-radio value="json" :disabled="config.method === 'GET'">JSON 字段</el-radio><el-radio value="form" :disabled="config.method === 'GET'">表单字段</el-radio>
    </el-radio-group>
  </el-form-item>
  <el-row :gutter="20">
    <el-col :span="12"><el-form-item :label="config.tokenLocation === 'header' ? '目标请求头' : '目标字段名'"><el-input v-model="config.tokenName" placeholder="如 Authorization 或 userToken" /></el-form-item></el-col>
    <el-col :span="12"><el-form-item label="添加的前缀"><el-input v-model="config.tokenPrefix" placeholder="如 Bearer 后加一个空格；可留空" /></el-form-item></el-col>
  </el-row>
  <div class="auth-guide">从 {{ config.inputHeader || '来源请求头' }} 移除 {{ JSON.stringify(config.inputPrefix) || '空前缀' }}，再添加 {{ JSON.stringify(config.tokenPrefix) }}，发送到{{ destination }} {{ config.tokenName || '（待填写）' }}。</div>
  <el-collapse v-model="advanced" class="auth-advanced">
    <el-collapse-item name="advanced" title="附加配置：固定请求头、签名与请求体（按需展开）">
      <el-form-item label="附加请求头">
        <div style="width: 100%">
          <el-table :data="headers" size="small" empty-text="无需附加请求头">
            <el-table-column label="名称"><template #default="{ row }"><el-input v-model="row.name" placeholder="X-Client-Id" /></template></el-table-column>
            <el-table-column label="固定值"><template #default="{ row }"><el-input v-model="row.value" type="password" show-password autocomplete="off" /></template></el-table-column>
            <el-table-column width="65"><template #default="{ $index }"><el-button link type="danger" @click="headers.splice($index, 1)">删除</el-button></template></el-table-column>
          </el-table>
          <el-button text type="primary" @click="headers.push({ name: '', value: '' })">+ 添加请求头</el-button>
        </div>
      </el-form-item>
      <el-form-item label="动态 Header">
        <div style="width: 100%">
          <el-button size="small" @click="showSignature = !showSignature">常用签名生成器</el-button>
          <div v-if="showSignature" class="signature-builder">
            <p>适用公式：MD5(clientId + MD5(clientSecret) + 毫秒时间戳)。请求头名称按身份服务文档填写。</p>
            <el-input v-model="signature.clientId" placeholder="clientId" aria-label="签名 clientId" />
            <el-input v-model="signature.clientSecret" type="password" show-password autocomplete="off" placeholder="clientSecret" aria-label="签名 clientSecret" />
            <el-input v-model="signature.clientHeader" placeholder="clientId 请求头名" aria-label="clientId 请求头名" />
            <el-input v-model="signature.timeHeader" placeholder="时间戳请求头名" aria-label="时间戳请求头名" />
            <el-input v-model="signature.digestHeader" placeholder="摘要请求头名" aria-label="摘要请求头名" />
            <el-button type="primary" size="small" @click="applySignature">生成并填入</el-button>
          </div>
          <el-input v-model="dynamicHeadersText" type="textarea" :rows="5" class="mono" style="margin-top: 10px" />
          <div class="muted">复杂签名可编辑 JSON：literal 固定值、timestamp 时间戳、digest 摘要。支持 md5 / sha256 / sha512；同一次请求使用同一时间戳。配置加密保存。</div>
        </div>
      </el-form-item>
      <el-form-item v-if="config.method === 'POST'" label="附加请求体">
        <el-input v-model="bodyText" type="textarea" :rows="2" class="mono" placeholder='{"audience":"data-api"}' />
        <span class="muted">JSON 对象；实际凭证覆盖同名字段。表单字段仅支持标量。</span>
      </el-form-item>
    </el-collapse-item>
  </el-collapse>
  <div class="config-step"><strong>3 · 怎样判断验证成功</strong><p>所有条件都满足才允许继续。文本直接输入，无需添加引号。</p></div>
  <el-form-item label="成功 HTTP 状态"><el-input-number v-model="config.successStatus" :min="200" :max="299" /></el-form-item>
  <el-form-item label="响应成功字段"><el-input v-model="config.successPath" placeholder="如 active、code；留空不检查该字段" /></el-form-item>
  <el-form-item v-if="config.successPath" label="应等于"><ScalarValue v-model="config.successValue" /></el-form-item>
  <el-form-item label="其他必要条件">
    <div style="width: 100%">
      <el-table :data="config.successConditions" size="small" empty-text="无额外条件">
        <el-table-column label="响应字段路径"><template #default="{ row }"><el-input v-model="row.path" placeholder="如 data.status" /></template></el-table-column>
        <el-table-column label="应等于" min-width="240"><template #default="{ row }"><ScalarValue v-model="row.value" /></template></el-table-column>
        <el-table-column width="65"><template #default="{ $index }"><el-button link type="danger" @click="config.successConditions.splice($index, 1)">删除</el-button></template></el-table-column>
      </el-table>
      <el-button text type="primary" :disabled="config.successConditions.length >= 20" @click="config.successConditions.push({ path: '', value: true })">+ 添加条件</el-button>
      <div v-if="!config.successPath && !config.successConditions.length" class="muted">当前仅检查 HTTP 状态。如身份服务用 HTTP 200 表示业务失败，请补充响应成功字段。</div>
    </div>
  </el-form-item>
  <div class="config-step"><strong>4 · 从验证结果取得身份</strong><p>例如响应 {"data":{"staffCode":"00123"}}，字段路径填 data.staffCode。工号用 string 保留前导零。</p></div>
  <el-form-item label="身份参数映射">
    <div style="width: 100%">
      <el-table :data="config.bindings" size="small" empty-text="未配置映射：仅验证访问身份">
        <el-table-column label="响应字段路径"><template #default="{ row }"><el-input v-model="row.path" placeholder="data.staffCode" /></template></el-table-column>
        <el-table-column label="身份参数名"><template #default="{ row }"><el-input v-model="row.name" placeholder="_auth_staff_code" /></template></el-table-column>
        <el-table-column label="类型" width="125"><template #default="{ row }"><el-select v-model="row.type"><el-option v-for="type in FIELD_TYPES" :key="type" :value="type" :label="FIELD_TYPE_LABELS[type]" /></el-select></template></el-table-column>
        <el-table-column width="65"><template #default="{ $index }"><el-button link type="danger" @click="config.bindings.splice($index, 1)">删除</el-button></template></el-table-column>
      </el-table>
      <el-button text type="primary" :disabled="!['REALTIME', 'XINGCHEN'].includes(mode)" @click="config.bindings.push({ name: mode === 'XINGCHEN' || shared ? '_auth_staff_code' : '_auth_subject', path: '', type: 'string' })">+ 添加身份字段</el-button>
      <div class="muted">{{ shared ? '所有引用此连接的 API 可使用这些身份字段；执行时只提取当前 API 需要的字段。' : mode === 'XINGCHEN' ? '在下方星辰配置中选择工号身份参数，系统自动加密。' : mode === 'REALTIME' ? 'SQL 中用 :_auth_subject 等参数引用；每项映射都必须在 SQL 中使用。' : '当前模式仅验证身份，不支持身份映射。' }} 调用者不能覆盖身份参数。</div>
    </div>
  </el-form-item>
  <p class="muted">在下方测试身份验证，确认成功条件和身份字段路径。测试凭证仅用于本次请求。</p>
  <el-divider />
</template>
