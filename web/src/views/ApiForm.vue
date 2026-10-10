<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { confirm, defaultExternalAuth, formatTimeInZone, MODE_LABELS, request, RequestError, type Api, type Datasource, type ExternalAuthTrace as AuthTrace } from '../api'
import FieldTable from './FieldTable.vue'
import ExternalAuthForm from './ExternalAuthForm.vue'
import ExternalAuthTrace from './ExternalAuthTrace.vue'
import TestRequestTrace from './TestRequestTrace.vue'
import type { RequestTrace } from '../request-trace'
import SyncHistoryDialog from './SyncHistoryDialog.vue'

const props = defineProps<{ api: Api | null }>()
const emit = defineEmits<{ close: [] }>()

const blank: Api = {
  name: '', code: '', path: '/open/', method: 'GET', auth: 'API_KEY', userAgents: [], mode: 'REALTIME', datasourceId: null,
  externalAuth: null,
  sql: '', params: [], fields: [], filters: [], keyFields: [], cron: '0 */30 * * * *',
  cronTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', allowEmpty: false,
  timeoutSeconds: 10, maxRows: 10000, enabled: false,
}

// Deep copy through JSON: the prop is a reactive proxy, which structuredClone rejects.
const clone = (api: Api): Api => JSON.parse(JSON.stringify(api))
const editable = (api: Api): Api => clone({ ...api, cronTimezone: api.cronTimezone || blank.cronTimezone, externalAuth: api.externalAuth ?? defaultExternalAuth() })

const saved = ref<Api | null>(props.api)
const form = ref<Api>(editable({ ...blank, ...props.api }))
const lists = ref(listsOf(form.value))
const sources = ref<Datasource[]>([])
const saving = ref(false)
const testing = ref(false)
const testingAuth = ref(false)
const authTrace = ref<AuthTrace>()
const requestTrace = ref<RequestTrace>()
const testError = ref('')
const showHistory = ref(false)
const testParams = ref('{}')
const testCredential = ref('')
const externalForm = ref<InstanceType<typeof ExternalAuthForm>>()
const externalConfig = computed({
  get: () => form.value.externalAuth ?? defaultExternalAuth(),
  set: value => { form.value.externalAuth = value },
})
const result = ref<{ elapsedMs: number; count: number; rows: unknown[]; externalAuthTrace?: AuthTrace }>()

const sourced = computed(() => form.value.mode !== 'MANUAL')

function listsOf(api: Api) {
  return { userAgents: api.userAgents.join('\n'), keyFields: api.keyFields.join(', '), filters: api.filters.join(', ') }
}

const split = (text: string, separator: RegExp) => text.split(separator).map(item => item.trim()).filter(Boolean)

function payload(): Api {
  const api = form.value
  return {
    ...api,
    externalAuth: api.auth === 'EXTERNAL' ? externalForm.value?.value() ?? api.externalAuth : null,
    userAgents: split(lists.value.userAgents, /\n/),
    keyFields: api.mode === 'SNAPSHOT' ? split(lists.value.keyFields, /[,，]/) : [],
    filters: api.mode === 'REALTIME' ? [] : split(lists.value.filters, /[,，]/),
    params: api.mode === 'REALTIME' ? api.params : [],
    fields: api.mode === 'REALTIME' ? [] : api.fields,
    datasourceId: sourced.value ? api.datasourceId : null,
    sql: sourced.value ? api.sql : null,
  }
}

function fillCode() {
  if (form.value.code) return
  const code = form.value.path.replace(/^\/open\/?/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (code) form.value.code = /^[A-Za-z]/.test(code) ? code : `api_${code}`
}

/** Asks before a save that drops or rewrites stored rows. */
async function confirmDataChanges(next: Api): Promise<boolean> {
  const before = saved.value
  if (!before?.id || before.mode === 'REALTIME') return true
  if (before.mode !== next.mode) {
    return confirm(`切换数据模式会删除「${MODE_LABELS[before.mode]}」下已有的全部本地数据。`, '确认切换模式')
  }
  const changed = before.fields.filter(old => !next.fields.some(field => field.name === old.name && field.type === old.type))
  if (next.mode !== 'MANUAL' || !changed.length) return true
  return confirm(`字段 ${changed.map(field => field.name).join('、')} 被删除或改了类型，已有记录会随之转换，删除字段的值会丢失。`, '确认修改字段')
}

async function save() {
  fillCode()
  let body: Api
  try { body = payload() } catch (error) { ElMessage.error((error as Error).message); return }
  if (!await confirmDataChanges(body)) return
  saving.value = true
  try {
    const id = saved.value?.id
    const api = await request<Api>(id ? `/admin/apis/${id}` : '/admin/apis', { method: id ? 'PUT' : 'POST', body })
    saved.value = api
    form.value = editable(api)
    lists.value = listsOf(api)
    ElMessage.success('已保存')
  } finally {
    saving.value = false
  }
}

async function reload() {
  const api = await request<Api>(`/admin/apis/${saved.value!.id}`)
  saved.value = api
  form.value = editable(api)
  lists.value = listsOf(api)
}

/** Tests the form as it is now; parameters are sent verbatim so large numbers stay exact. */
async function test() {
  result.value = undefined
  authTrace.value = undefined
  requestTrace.value = undefined
  testError.value = ''
  let api: Api
  try {
    JSON.parse(testParams.value || '{}')
    api = payload()
  } catch (error) {
    testError.value = error instanceof Error ? error.message : '测试配置无效'
    return ElMessage.error((error as Error).message)
  }
  testing.value = true
  try {
    result.value = await request('/admin/apis/test', {
      method: 'POST',
      rawBody: `{"api":${JSON.stringify(api)},"params":${testParams.value.trim() || '{}'}}`,
      headers: api.auth === 'EXTERNAL' ? { 'X-DataBridge-Test-Credential': (api.externalAuth?.inputPrefix ?? '') + testCredential.value } : undefined,
      onTrace: trace => { requestTrace.value = trace },
    })
    authTrace.value = result.value?.externalAuthTrace
  } catch (error) {
    if (error instanceof RequestError) authTrace.value = error.externalAuthTrace
    else ElMessage.error(error instanceof Error ? error.message : '测试请求失败')
  } finally {
    testing.value = false
    testCredential.value = ''
  }
}

async function testAuth() {
  result.value = undefined
  authTrace.value = undefined
  requestTrace.value = undefined
  testError.value = ''
  let externalAuth
  try { externalAuth = externalForm.value?.value() ?? form.value.externalAuth } catch (error) {
    testError.value = error instanceof Error ? error.message : '身份验证配置无效'
    return ElMessage.error((error as Error).message)
  }
  testingAuth.value = true
  try {
    const response = await request<{ externalAuthTrace: AuthTrace }>('/admin/external-auth/test', {
      method: 'POST', body: { externalAuth },
      headers: { 'X-DataBridge-Test-Credential': (externalAuth?.inputPrefix ?? '') + testCredential.value },
      onTrace: trace => { requestTrace.value = trace },
    })
    authTrace.value = response.externalAuthTrace
  } catch (error) {
    if (error instanceof RequestError) authTrace.value = error.externalAuthTrace
    else ElMessage.error(error instanceof Error ? error.message : '测试请求失败')
  } finally {
    testingAuth.value = false
    testCredential.value = ''
  }
}

onMounted(async () => { sources.value = await request<Datasource[]>('/admin/datasources') })
</script>

<template>
  <div class="page-head">
    <div><h2>{{ saved?.id ? '编辑 API' : '新增 API' }}</h2><p>保存并启用后即可通过接口路径调用</p></div>
    <div>
      <el-button v-if="saved?.id" @click="reload">重新载入</el-button>
      <el-button @click="emit('close')">返回列表</el-button>
    </div>
  </div>
  <el-card shadow="never">
    <el-form label-width="120px" style="max-width: 960px" @submit.prevent="save">
      <el-row :gutter="20">
        <el-col :span="12"><el-form-item label="接口名称"><el-input v-model="form.name" /></el-form-item></el-col>
        <el-col :span="12">
          <el-form-item label="接口编码">
            <el-input v-model="form.code" placeholder="平台内唯一标识，留空按路径生成" />
          </el-form-item>
        </el-col>
      </el-row>
      <el-row :gutter="20">
        <el-col :span="12"><el-form-item label="接口路径"><el-input v-model="form.path" placeholder="/open/customer" @blur="fillCode" /></el-form-item></el-col>
        <el-col :span="12">
          <el-form-item label="请求方式">
            <el-radio-group v-model="form.method"><el-radio-button value="GET">GET</el-radio-button><el-radio-button value="POST">POST</el-radio-button></el-radio-group>
            <span class="muted" style="margin-left: 12px">{{ form.method === 'GET' ? '参数放在查询字符串' : '参数放在 JSON 请求体' }}</span>
          </el-form-item>
        </el-col>
      </el-row>
      <el-form-item label="访问方式">
        <el-radio-group v-model="form.auth">
          <el-radio value="API_KEY">需要 API Key</el-radio><el-radio value="PUBLIC">公开访问</el-radio>
          <el-radio value="EXTERNAL">外部身份验证</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="User-Agent">
        <el-input v-model="lists.userAgents" type="textarea" :rows="2" placeholder="每行一条，留空不限制；末尾 * 表示前缀匹配，如 MyClient/*" />
        <span class="muted">User-Agent 由客户端自行设置，只能做兼容性限制，不能代替身份认证。</span>
      </el-form-item>
      <el-form-item label="数据模式">
        <el-radio-group v-model="form.mode">
          <el-radio-button v-for="(label, mode) in MODE_LABELS" :key="mode" :value="mode">{{ label }}</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <ExternalAuthForm v-if="form.auth === 'EXTERNAL'" ref="externalForm" v-model="externalConfig" :mode="form.mode" />

      <template v-if="sourced">
        <el-form-item label="数据源">
          <el-select v-model="form.datasourceId" placeholder="选择数据源" style="width: 100%">
            <el-option v-for="source in sources" :key="source.id" :label="source.name" :value="source.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="SELECT SQL">
          <el-input v-model="form.sql" class="mono" type="textarea" :rows="8"
                    :placeholder="form.mode === 'REALTIME' ? 'SELECT id, name FROM customer WHERE id = :id' : 'SELECT id, name FROM product ORDER BY id'" />
        </el-form-item>
      </template>

      <el-form-item v-if="form.mode === 'REALTIME'" label="请求参数">
        <FieldTable v-model="form.params" add-label="添加参数" />
        <span class="muted">SQL 中用 :参数名 引用，业务参数需在这里声明类型；外部身份参数在验证配置中映射。</span>
      </el-form-item>

      <template v-if="form.mode === 'SNAPSHOT'">
        <el-form-item label="唯一键"><el-input v-model="lists.keyFields" placeholder="如 id，或 area_id, prod_id" /></el-form-item>
        <el-form-item label="同步 Cron">
          <el-input v-model="form.cron" class="mono" placeholder="秒 分 时 日 月 周，如 0 */30 * * * *" />
          <span v-if="saved?.nextSyncAt && saved.cronTimezone" class="muted">当前配置下次同步：{{ formatTimeInZone(saved.nextSyncAt, saved.cronTimezone) }}（{{ saved.cronTimezone }}）</span>
        </el-form-item>
        <el-form-item label="同步时区">
          <el-input v-model="form.cronTimezone" class="mono" placeholder="如 Asia/Shanghai" />
          <span class="muted">Cron 按此时区执行；修改后保存生效。</span>
        </el-form-item>
        <el-form-item label="空结果覆盖">
          <el-switch v-model="form.allowEmpty" /><span class="muted" style="margin-left: 12px">关闭时，空结果不会覆盖已有快照</span>
        </el-form-item>
        <el-form-item v-if="saved?.id" label="上次成功同步">
          <span class="muted">{{ saved.syncAt && saved.cronTimezone ? formatTimeInZone(saved.syncAt, saved.cronTimezone) : '尚未成功同步' }} · {{ saved.syncCount ?? 0 }} 行</span>
          <el-button link type="primary" style="margin-left: 12px" @click="showHistory = true">查看同步详情</el-button>
          <el-alert v-if="saved.syncError" :title="saved.syncError" type="error" :closable="false" />
        </el-form-item>
      </template>

      <template v-if="form.mode !== 'REALTIME'">
        <el-form-item :label="form.mode === 'MANUAL' ? '字段定义' : '字段类型'">
          <FieldTable v-model="form.fields" />
          <span v-if="form.mode === 'SNAPSHOT'" class="muted">可选；需要过滤的字段必须在这里声明类型。</span>
        </el-form-item>
        <el-form-item label="允许过滤"><el-input v-model="lists.filters" placeholder="可按等值过滤的字段，逗号分隔" /></el-form-item>
      </template>

      <el-row :gutter="20">
        <el-col v-if="sourced" :span="12">
          <el-form-item label="查询超时 (秒)"><el-input-number v-model="form.timeoutSeconds" :min="1" :max="120" /></el-form-item>
        </el-col>
        <el-col :span="12"><el-form-item label="最大行数"><el-input-number v-model="form.maxRows" :min="1" :max="100000" />
          <span class="muted">非分页请求及同步的上限；分页请求每页不超过此值</span>
        </el-form-item></el-col>
      </el-row>
      <el-form-item label="启用接口"><el-switch v-model="form.enabled" /></el-form-item>
      <el-form-item>
        <el-button type="primary" native-type="submit" :loading="saving">保存</el-button>
      </el-form-item>
    </el-form>

    <template v-if="sourced || form.auth === 'EXTERNAL'">
      <el-divider content-position="left">{{ form.auth === 'EXTERNAL' ? sourced ? '测试身份验证与 SQL' : '测试身份验证' : '测试当前 SQL' }}（不需要先保存）</el-divider>
      <div class="toolbar">
        <el-input v-if="sourced && form.mode === 'REALTIME'" v-model="testParams" class="mono" placeholder='测试参数 JSON，如 {"id": "10001"}' style="max-width: 480px" />
        <el-input v-if="form.auth === 'EXTERNAL'" v-model="testCredential" type="password" autocomplete="off"
                  placeholder="测试凭证（不含前缀），本次测试后清空" style="max-width: 340px" />
        <el-button v-if="form.auth === 'EXTERNAL'" :loading="testingAuth" :disabled="testing" @click="testAuth">测试身份验证</el-button>
        <el-button v-if="sourced" :loading="testing" :disabled="testingAuth" @click="test">执行 SQL 测试</el-button>
        <span v-if="result" class="muted">返回 {{ result.count }} 行 · {{ result.elapsedMs }}ms{{ result.count === form.maxRows ? '（已截断到最大行数）' : '' }}</span>
      </div>
      <el-alert v-if="testError" :title="`测试请求未发送：${testError}`" type="error" :closable="false" show-icon />
      <el-divider v-if="authTrace && form.auth === 'EXTERNAL'" content-position="left">外部身份服务请求与响应</el-divider>
      <ExternalAuthTrace v-if="authTrace && form.auth === 'EXTERNAL'" :trace="authTrace" />
      <el-divider v-if="result" content-position="left">SQL 查询结果</el-divider>
      <pre v-if="result" class="result">{{ JSON.stringify(result.rows, null, 2) }}</pre>
      <TestRequestTrace v-if="requestTrace" :trace="requestTrace" :external-auth="form.auth === 'EXTERNAL'" />
    </template>
  </el-card>
  <SyncHistoryDialog v-if="showHistory && saved?.id" :api="saved" @close="showHistory = false" />
</template>
