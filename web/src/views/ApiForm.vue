<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'
import { confirm, defaultAccessPolicy, defaultXingchen, formatTimeInZone, MODE_LABELS, request, RequestError, type Api, type ConnectionKind, type ConnectionSummary, type Datasource, type ExternalAuthTrace as AuthTrace } from '../api'
import XingchenForm from './XingchenForm.vue'
import FieldTable from './FieldTable.vue'
import ConnectionEditor from './ConnectionEditor.vue'
import ExternalAuthTrace from './ExternalAuthTrace.vue'
import TestRequestTrace from './TestRequestTrace.vue'
import type { RequestTrace } from '../request-trace'
import { completeTestParams } from '../test-params'
import SyncHistoryDialog from './SyncHistoryDialog.vue'
import ProjectEditor from './ProjectEditor.vue'
import AccessPolicyForm from './AccessPolicyForm.vue'
import type { Project, AccessDecision } from '../api'
const authorization = ref<AccessDecision>()

const props = defineProps<{ api: Api | null; initialProjectId?: number }>()
const emit = defineEmits<{ close: [] }>()

const blank: Api = {
  accessPolicy: defaultAccessPolicy(),
  projectIds: props.initialProjectId ? [props.initialProjectId] : [],
  name: '', code: '', path: '/open/', method: 'GET', auth: 'API_KEY', userAgents: [], mode: 'REALTIME', datasourceId: null,
  externalAuth: null, xingchen: null, authConnectionId: null, xingchenConnectionId: null,
  sql: '', params: [], fields: [], filters: [], keyFields: [], cron: '0 */30 * * * *',
  cronTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', allowEmpty: false,
  timeoutSeconds: 10, maxRows: 10000, enabled: false,
}

// Deep copy through JSON: the prop is a reactive proxy, which structuredClone rejects.
const clone = (api: Api): Api => JSON.parse(JSON.stringify(api))
const editable = (api: Api): Api => clone({ ...api, cronTimezone: api.cronTimezone || blank.cronTimezone, xingchen: api.xingchen ?? defaultXingchen() })

const saved = ref<Api | null>(props.api)
const form = ref<Api>(editable({ ...blank, ...props.api }))
const lists = ref(listsOf(form.value))
const sources = ref<Datasource[]>([])
const saving = ref(false)
const testing = ref(false)
const authTrace = ref<AuthTrace>()
const requestTrace = ref<RequestTrace>()
const testError = ref('')
const showHistory = ref(false)
const testParams = ref('{}')
const testCredential = ref('')
const connections = ref<ConnectionSummary[]>([])
const projects = ref<Project[]>([])
const creatingProject = ref(false)
async function projectSaved(project: Project) {
  projects.value = await request<Project[]>('/admin/projects')
  form.value.projectIds = [...new Set([...form.value.projectIds, project.id])]
  creatingProject.value = false
}
const diagnostics = ref<string[]>([])
const connectionEditor = ref<{ id?: number; kind: ConnectionKind }>()
const authConnections = computed(() => connections.value.filter(item => item.kind === 'EXTERNAL_AUTH'))
const platforms = computed(() => connections.value.filter(item => item.kind === 'XINGCHEN'))
const selectedAuth = computed(() => authConnections.value.find(item => item.id === form.value.authConnectionId))
const selectedPlatform = computed(() => platforms.value.find(item => item.id === form.value.xingchenConnectionId))
const modeHints = { REALTIME: '执行 SQL，实时取得数据库结果', SNAPSHOT: '定时同步，提供稳定的本地快照', MANUAL: '直接维护数据，无需数据库', XINGCHEN: '验证身份后转发智能体请求' }
async function loadConnections() {
  connections.value = await request<ConnectionSummary[]>('/admin/connections')
  if (!form.value.authConnectionId && authConnections.value.length === 1) form.value.authConnectionId = authConnections.value[0].id
  if (!form.value.xingchenConnectionId && platforms.value.length === 1) form.value.xingchenConnectionId = platforms.value[0].id
}
async function connectionSaved(connection: { id: number; kind: ConnectionKind }) {
  connectionEditor.value = undefined
  await loadConnections()
  if (connection.kind === 'EXTERNAL_AUTH') form.value.authConnectionId = connection.id
  else form.value.xingchenConnectionId = connection.id
}
watch(selectedAuth, connection => {
  if (!form.value.accessPolicy.staffBinding && connection) form.value.accessPolicy.staffBinding = connection.bindings.find(b => b.type === 'string')?.name ?? ''
  const app = form.value.xingchen
  if (app && connection && !connection.bindings.some(binding => binding.name === app.staffCodeBinding && binding.type === 'string')) {
    app.staffCodeBinding = connection.bindings.find(binding => binding.type === 'string')?.name ?? ''
  }
})
const result = ref<{ elapsedMs: number; count?: number; rows?: unknown[]; response?: unknown; externalAuthTrace?: AuthTrace; authorization?: AccessDecision }>()

const sourced = computed(() => ['REALTIME', 'SNAPSHOT'].includes(form.value.mode))
const forwarding = computed(() => form.value.mode === 'XINGCHEN')
const parameterized = computed(() => form.value.mode === 'REALTIME' || forwarding.value)
let generatedTestParams = '{}'

function fillTestParams(manual = false) {
  if (!parameterized.value) return
  const template = completeTestParams(form.value.params)!
  const current = testParams.value === generatedTestParams ? '{}' : testParams.value
  const completed = completeTestParams(form.value.params, current)
  if (completed === null) {
    if (manual) ElMessage.warning('请先将测试参数改为有效的 JSON 对象，当前内容已保留')
    return
  }
  testParams.value = completed
  generatedTestParams = template
}
watch([() => form.value.params, parameterized], () => fillTestParams(), { deep: true, immediate: true })

watch(() => form.value.mode, mode => {
  if (mode !== 'XINGCHEN') return
  form.value.auth = 'EXTERNAL'
  form.value.timeoutSeconds = 60
  form.value.method = 'POST'
  if (!form.value.params.length) form.value.params = [
    { name: 'q', type: 'string', required: true }, { name: 'conversation_id', type: 'string', required: false },
  ]

})

function listsOf(api: Api) {
  return { userAgents: api.userAgents.join('\n'), keyFields: api.keyFields.join(', '), filters: api.filters.join(', ') }
}

const split = (text: string, separator: RegExp) => text.split(separator).map(item => item.trim()).filter(Boolean)

function payload(): Api {
  const api = form.value
  return {
    ...api,
    externalAuth: null,
    accessPolicy: api.auth === 'EXTERNAL' ? api.accessPolicy : defaultAccessPolicy(false),
    authConnectionId: api.auth === 'EXTERNAL' ? api.authConnectionId : null,
    xingchenConnectionId: forwarding.value ? api.xingchenConnectionId : null,
    xingchen: forwarding.value && api.xingchen ? { ...api.xingchen, baseUrl: '' } : null,
    userAgents: split(lists.value.userAgents, /\n/),
    keyFields: api.mode === 'SNAPSHOT' ? split(lists.value.keyFields, /[,，]/) : [],
    filters: parameterized.value ? [] : split(lists.value.filters, /[,，]/),
    params: parameterized.value ? api.params : [],
    fields: parameterized.value ? [] : api.fields,
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
  if (!before?.id || ['REALTIME', 'XINGCHEN'].includes(before.mode)) return true
  if (before.mode !== next.mode) {
    return confirm(`切换数据模式会删除「${MODE_LABELS[before.mode]}」下已有的全部本地数据。`, '确认切换模式')
  }
  const changed = before.fields.filter(old => !next.fields.some(field => field.name === old.name && field.type === old.type))
  if (next.mode !== 'MANUAL' || !changed.length) return true
  return confirm(`字段 ${changed.map(field => field.name).join('、')} 被删除或改了类型，已有记录会随之转换，删除字段的值会丢失。`, '确认修改字段')
}

async function save() {
  if (saving.value) return
  fillCode()
  let body: Api
  try { body = payload() } catch (error) { ElMessage.error((error as Error).message); return }
  if (!body.name.trim() || body.path === '/open/' || body.auth === 'EXTERNAL' && !body.authConnectionId || forwarding.value && !body.xingchenConnectionId) {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    return ElMessage.warning('请填写接口名称、路径，并选择需要的连接')
  }
  if (!await confirmDataChanges(body)) return
  saving.value = true
  try {
    const id = saved.value?.id
    const api = await request<Api>(id ? `/admin/apis/${id}` : '/admin/apis', { method: id ? 'PUT' : 'POST', body })
    saved.value = api
    form.value = editable(api)
    lists.value = listsOf(api)
    ElMessage.success(api.enabled ? '已保存并启用' : '已保存为草稿')
    if (api.enabled) emit('close')
  } finally {
    saving.value = false
  }
}

async function reload() {
  await Promise.all([loadConnections(), request<Project[]>('/admin/projects').then(items => { projects.value = items })])
  const api = await request<Api>(`/admin/apis/${saved.value!.id}`)
  saved.value = api
  form.value = editable(api)
  lists.value = listsOf(api)
}

/** Tests the form as it is now; parameters are sent verbatim so large numbers stay exact. */
async function test() {
  authorization.value = undefined
  result.value = undefined
  authTrace.value = undefined
  requestTrace.value = undefined
  testError.value = ''
  let api: Api
  const params = parameterized.value ? testParams.value.trim() || '{}' : '{}'
  try {
    JSON.parse(params)
    api = payload()
  } catch (error) {
    testError.value = error instanceof Error ? error.message : '测试配置无效'
    return ElMessage.error((error as Error).message)
  }
  testing.value = true
  try {
    result.value = await request('/admin/apis/test', {
      method: 'POST',
      rawBody: `{"api":${JSON.stringify(api)},"params":${params}}`,
      headers: api.auth === 'EXTERNAL' ? { 'X-DataBridge-Test-Credential': (selectedAuth.value?.inputPrefix ?? '') + testCredential.value } : undefined,
      onTrace: trace => { requestTrace.value = trace },
    })
    authTrace.value = result.value?.externalAuthTrace
    authorization.value = result.value?.authorization
  } catch (error) {
    if (error instanceof RequestError) { authorization.value = error.authorization; authTrace.value = error.externalAuthTrace; testError.value = error.message; diagnostics.value = ['auth', 'request'] }
    else ElMessage.error(error instanceof Error ? error.message : '测试请求失败')
  } finally {
    testing.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadConnections(), request<Datasource[]>('/admin/datasources').then(items => { sources.value = items }),
    request<Project[]>('/admin/projects').then(items => { projects.value = items })])
  if (!props.api && authConnections.value.length === 1) form.value.auth = 'EXTERNAL'
})
</script>

<template>
  <div class="page-head">
    <h2>{{ saved?.id ? form.name || '编辑接口' : '创建接口' }}</h2>
    <div class="page-actions"><el-button v-if="saved?.id" text @click="reload">重新载入</el-button><el-button @click="emit('close')">返回列表</el-button></div>
  </div>
  <el-form class="api-editor" label-position="top" @submit.prevent="save">
    <section class="editor-section">
      <div class="section-heading"><h3>基本信息</h3></div>
      <div class="mode-grid">
        <button v-for="(label, mode) in MODE_LABELS" :key="mode" type="button" class="mode-card" :class="{ selected: form.mode === mode }" :aria-pressed="form.mode === mode" @click="form.mode = mode">
          <strong>{{ label }}</strong><span>{{ modeHints[mode] }}</span>
        </button>
      </div>
      <div class="form-grid" style="margin-top: 24px">
        <el-form-item label="接口名称" required><el-input v-model="form.name" placeholder="如：通讯录查询" /></el-form-item>
        <el-form-item label="接口路径" required><el-input v-model="form.path" placeholder="/open/contacts" @blur="fillCode" /></el-form-item>
      </div>
      <el-form-item label="调用方式"><el-radio-group v-model="form.method"><el-radio-button value="GET">GET · 查询参数</el-radio-button><el-radio-button value="POST">POST · JSON 请求体</el-radio-button></el-radio-group></el-form-item>
    </section>

    <section class="editor-section">
      <div class="section-heading"><h3>谁可以调用</h3></div>
      <el-form-item>
        <el-radio-group v-model="form.auth"><el-radio value="EXTERNAL">外部身份验证</el-radio><el-radio value="API_KEY" :disabled="forwarding">API Key</el-radio><el-radio value="PUBLIC" :disabled="forwarding">公开访问</el-radio></el-radio-group>
      </el-form-item>
      <el-form-item v-if="form.auth === 'EXTERNAL'" label="身份服务" required>
        <div class="connection-picker">
          <el-select v-model="form.authConnectionId" filterable placeholder="选择已配置的身份服务"><el-option v-for="connection in authConnections" :key="connection.id" :label="connection.name" :value="connection.id" /></el-select>
          <el-button @click="connectionEditor = { kind: 'EXTERNAL_AUTH' }">新建</el-button>
          <el-button v-if="selectedAuth" text @click="connectionEditor = { kind: 'EXTERNAL_AUTH', id: selectedAuth.id }">编辑</el-button>
        </div>
        <div v-if="selectedAuth" class="field-help">调用者通过 {{ selectedAuth.inputHeader }} 提供凭证 · 可使用 {{ selectedAuth.bindings.length }} 个身份字段</div>
      </el-form-item>
      <el-form-item v-if="forwarding" label="星辰平台" required>
        <div class="connection-picker">
          <el-select v-model="form.xingchenConnectionId" filterable placeholder="选择已配置的星辰平台"><el-option v-for="connection in platforms" :key="connection.id" :label="connection.name" :value="connection.id" /></el-select>
          <el-button @click="connectionEditor = { kind: 'XINGCHEN' }">新建</el-button>
          <el-button v-if="selectedPlatform" text @click="connectionEditor = { kind: 'XINGCHEN', id: selectedPlatform.id }">编辑</el-button>
        </div>
      </el-form-item>
      <AccessPolicyForm v-if="form.auth === 'EXTERNAL'" v-model="form.accessPolicy" :bindings="selectedAuth?.bindings" :fixed-binding="forwarding ? form.xingchen?.staffCodeBinding : undefined" />
      <el-alert v-if="form.auth === 'API_KEY'" title="保存后在「调用密钥」中为 Key 授权此接口，调用方在 X-API-Key 请求头中携带 Key。" type="info" :closable="false" />
      <el-alert v-if="form.auth === 'PUBLIC'" title="启用后，任何能访问此地址的调用方都可以获取数据。" type="warning" :closable="false" />
    </section>

    <section class="editor-section">
      <div class="section-heading"><h3>{{ MODE_LABELS[form.mode] }}</h3></div>
      <template v-if="sourced">
        <el-form-item label="数据源" required><el-select v-model="form.datasourceId" placeholder="选择 PostgreSQL 数据源" style="width: 100%"><el-option v-for="source in sources" :key="source.id" :label="source.name" :value="source.id" /></el-select><div v-if="!sources.length" class="field-help">还没有数据源，请先在「连接 → 数据库」中添加。</div></el-form-item>
        <el-form-item label="SELECT SQL" required><el-input v-model="form.sql" class="mono" type="textarea" :rows="7" :placeholder="form.mode === 'REALTIME' ? 'SELECT id, name FROM customer WHERE id = :id' : 'SELECT id, name FROM product ORDER BY id'" /></el-form-item>
        <div v-if="form.mode === 'REALTIME' && form.auth === 'EXTERNAL' && selectedAuth?.bindings.length" class="identity-hint"><strong>可用身份参数</strong><div class="tag-list"><code v-for="binding in selectedAuth.bindings" :key="binding.name">:{{ binding.name }}</code></div><p class="muted">直接在 SQL 中引用，调用者不能覆盖。</p></div>
      </template>
      <el-form-item v-if="parameterized" label="请求参数"><FieldTable v-model="form.params" add-label="添加参数" /><div v-if="!forwarding" class="field-help">SQL 中用 :参数名 引用。</div></el-form-item>
      <XingchenForm v-if="forwarding && form.xingchen" v-model="form.xingchen" :params="form.params" :bindings="selectedAuth?.bindings ?? []" />
      <template v-if="!parameterized">
        <el-form-item :label="form.mode === 'MANUAL' ? '数据字段' : '需要类型转换的字段（可选）'"><FieldTable v-model="form.fields" /></el-form-item>
        <el-form-item label="允许按哪些字段过滤"><el-input v-model="lists.filters" placeholder="字段名用逗号分隔，留空不开放过滤" /></el-form-item>
      </template>
      <template v-if="form.mode === 'SNAPSHOT'">
        <el-form-item label="唯一键" required><el-input v-model="lists.keyFields" placeholder="如 id；组合键用逗号分隔" /></el-form-item>
        <div class="form-grid">
          <el-form-item label="同步 Cron" required><el-input v-model="form.cron" class="mono" placeholder="秒 分 时 日 月 周" /><div class="field-help">默认每 30 分钟同步一次</div></el-form-item>
          <el-form-item label="同步时区"><el-input v-model="form.cronTimezone" placeholder="Asia/Shanghai" /></el-form-item>
        </div>
        <el-form-item label="允许空结果覆盖快照"><el-switch v-model="form.allowEmpty" /></el-form-item>
        <div v-if="saved?.id" class="info-strip"><span>上次同步：{{ saved.syncAt ? formatTimeInZone(saved.syncAt, saved.cronTimezone!) : '尚未同步' }} · {{ saved.syncCount ?? 0 }} 行</span><el-button link type="primary" @click="showHistory = true">同步详情</el-button></div>
        <el-alert v-if="saved?.syncError" :title="saved.syncError" type="error" :closable="false" />
      </template>
    </section>

    <section v-if="sourced || forwarding || form.auth === 'EXTERNAL'" class="editor-section">
      <div class="section-heading"><h3>测试</h3><span>无需先保存{{ forwarding ? ' · 星辰测试使用 blocking 模式' : '' }}</span></div>
      <el-form-item v-if="form.auth === 'EXTERNAL'" label="身份凭证"><el-input v-model="testCredential" type="password" clearable autocomplete="off" placeholder="输入身份凭证（不含前缀）" /></el-form-item>
      <el-form-item v-if="parameterized" label="测试参数（JSON）">
        <el-input v-model="testParams" type="textarea" :autosize="{ minRows: 3, maxRows: 14 }" class="mono" placeholder="{}" />
        <div class="field-help">已按请求参数生成模板，修改值即可。<el-button link type="primary" @click="fillTestParams(true)">补齐参数模板</el-button></div>
      </el-form-item>
      <div class="toolbar">
        <el-button type="primary" plain :loading="testing" @click="test">{{ forwarding ? '测试星辰转发' : sourced ? '执行 SQL 测试' : '测试身份与权限' }}</el-button>
        <span v-if="result" class="result-status">{{ result.count === undefined ? '转发完成' : `返回 ${result.count} 行` }} · {{ result.elapsedMs }} ms</span>
      </div>
      <el-alert v-if="authorization" :title="`${authorization.allowed ? '允许' : '拒绝'}：${authorization.reason} · ${authorization.rule ?? '—'} · 目录版本 ${authorization.directoryVersion}`" :type="authorization.allowed ? 'success' : 'warning'" :closable="false" />
      <el-alert v-if="testError" :title="testError" type="error" :closable="false" show-icon />
      <pre v-if="result" class="result">{{ JSON.stringify(result.response ?? result.rows, null, 2) }}</pre>
      <el-collapse v-if="authTrace || requestTrace" v-model="diagnostics">
        <el-collapse-item v-if="authTrace" title="身份服务诊断 · 请求、响应与成功条件" name="auth"><ExternalAuthTrace :trace="authTrace" /></el-collapse-item>
        <el-collapse-item v-if="requestTrace" title="测试请求详情 · 已脱敏" name="request"><TestRequestTrace :trace="requestTrace" :external-auth="form.auth === 'EXTERNAL'" /></el-collapse-item>
      </el-collapse>
    </section>
    <div v-if="form.mode === 'MANUAL'" class="info-strip">保存后在「数据维护」中录入数据，再启用接口。</div>

    <el-collapse class="advanced-panel"><el-collapse-item title="更多设置 · 编码、项目、超时与 User-Agent" name="advanced">
      <div class="form-grid">
        <el-form-item label="接口编码（英文）"><el-input v-model="form.code" maxlength="100" placeholder="留空按接口路径自动生成" /><div class="field-help">以字母开头，可含字母、数字和下划线；不影响调用地址。</div></el-form-item>
        <el-form-item label="所属项目">
          <div class="connection-picker">
            <el-select v-model="form.projectIds" multiple filterable clearable collapse-tags collapse-tags-tooltip :max-collapse-tags="3" placeholder="未归类">
              <el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" />
            </el-select>
            <el-button @click="creatingProject = true">新建项目</el-button>
          </div>
        </el-form-item>
        <el-form-item v-if="sourced || forwarding" label="请求超时（秒）"><el-input-number v-model="form.timeoutSeconds" :min="1" :max="120" /></el-form-item>
        <el-form-item v-if="!forwarding" label="最大行数"><el-input-number v-model="form.maxRows" :min="1" :max="1000000" /></el-form-item>
      </div>
      <el-form-item label="允许的 User-Agent"><el-input v-model="lists.userAgents" type="textarea" :rows="2" placeholder="留空不限制；每行一条，末尾 * 表示前缀匹配" /></el-form-item>
    </el-collapse-item></el-collapse>

    <div class="editor-footer"><div><el-switch v-model="form.enabled" active-text="启用接口" /><span class="muted">{{ form.enabled ? '保存后立即可调用' : '保存为草稿，暂不对外提供服务' }}</span></div><el-button type="primary" native-type="submit" :loading="saving">{{ form.enabled ? '保存并启用' : '保存草稿' }}</el-button></div>
  </el-form>
  <ConnectionEditor v-if="connectionEditor" :key="`${connectionEditor.kind}-${connectionEditor.id}`" :id="connectionEditor.id" :kind="connectionEditor.kind" @close="connectionEditor = undefined" @saved="connectionSaved" />
  <SyncHistoryDialog v-if="showHistory && saved?.id" :api="saved" @close="showHistory = false" />
  <ProjectEditor v-if="creatingProject" @close="creatingProject = false" @saved="projectSaved" />
</template>
