<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CONNECTION_LABELS, defaultExternalAuth, request, RequestError, type Connection, type ConnectionKind, type ConnectionSummary, type DataSkillConfig, type ExternalAuthConfig, type ExternalAuthTrace as AuthTrace } from '../api'
import ExternalAuthForm from './ExternalAuthForm.vue'
import ExternalAuthTrace from './ExternalAuthTrace.vue'
const props = defineProps<{ id?: number; kind: ConnectionKind }>()
const emit = defineEmits<{ close: []; saved: [connection: Connection] }>()
const name = ref('')
const version = ref<number>()
const usedBy = ref<Connection['usedBy']>([])
const usedByConnections = ref<Connection['usedByConnections']>([])
const identities = ref<ConnectionSummary[]>([])
const studio = ref<DataSkillConfig>({ baseUrl: '', serviceToken: '', authConnectionId: null, staffCodeBinding: '', identityProvider: 'uap', enabled: false })
const hasServiceToken = ref(false)
const serviceTokenSha256 = ref('')
const selectedIdentity = computed(() => identities.value.find(c => c.id === studio.value.authConnectionId))
const staffBindings = computed(() => selectedIdentity.value?.bindings.filter(b => b.type === 'string') || [])
const gatewayOrigin = window.location.origin
function selectIdentity() {
  if (!staffBindings.value.some(b => b.name === studio.value.staffCodeBinding)) {
    studio.value.staffCodeBinding = staffBindings.value.find(b => b.name === '_auth_staff_code')?.name || staffBindings.value[0]?.name || ''
  }
}
function generateToken() {
  studio.value.serviceToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, '0')).join('')
}
const auth = ref(defaultExternalAuth())
const baseUrl = ref('')
const loading = ref(!!props.id || props.kind === 'DATASKILL')
const saving = ref(false)
const testing = ref(false)
const credential = ref('')
const trace = ref<AuthTrace>()
const externalForm = ref<InstanceType<typeof ExternalAuthForm>>()
const configValue = () => props.kind === 'EXTERNAL_AUTH' ? externalForm.value!.value()
  : props.kind === 'DATASKILL' ? { ...studio.value } : { baseUrl: baseUrl.value }
onMounted(async () => {
  try {
    if (props.kind === 'DATASKILL') {
      identities.value = (await request<ConnectionSummary[]>('/admin/connections')).filter(c => c.kind === 'EXTERNAL_AUTH')
      if (identities.value.length === 1) { studio.value.authConnectionId = identities.value[0]!.id; selectIdentity() }
    }
    if (!props.id) return
    const connection = await request<Connection>(`/admin/connections/${props.id}`)
    name.value = connection.name; version.value = connection.version; usedBy.value = connection.usedBy
    usedByConnections.value = connection.usedByConnections
    if (connection.kind === 'EXTERNAL_AUTH') auth.value = connection.config as ExternalAuthConfig
    else if (connection.kind === 'DATASKILL') {
      studio.value = connection.config as DataSkillConfig
      hasServiceToken.value = !!connection.hasServiceToken
      serviceTokenSha256.value = connection.serviceTokenSha256 || ''
    }
    else baseUrl.value = (connection.config as { baseUrl: string }).baseUrl
  } finally { loading.value = false }
})
async function save() {
  let config
  try { config = configValue() } catch (error) { return ElMessage.error((error as Error).message) }
  saving.value = true
  try {
    const connection = await request<Connection>(props.id ? `/admin/connections/${props.id}` : '/admin/connections', {
      method: props.id ? 'PUT' : 'POST', body: { kind: props.kind, name: name.value, version: version.value, config },
    })
    ElMessage.success('连接已保存')
    emit('saved', connection)
  } finally { saving.value = false }
}
async function test() {
  let externalAuth
  try { externalAuth = configValue() as ExternalAuthConfig } catch (error) { return ElMessage.error((error as Error).message) }
  testing.value = true; trace.value = undefined
  try {
    const result = await request<{ externalAuthTrace: AuthTrace }>('/admin/external-auth/test', {
      method: 'POST', body: { externalAuth }, headers: { 'X-DataBridge-Test-Credential': externalAuth.inputPrefix + credential.value },
    })
    trace.value = result.externalAuthTrace
    ElMessage.success('身份验证通过')
  } catch (error) { if (error instanceof RequestError) trace.value = error.externalAuthTrace }
  finally { testing.value = false; credential.value = '' }
}
</script>

<template>
  <el-drawer :model-value="true" :title="`${id ? '编辑' : '新建'}${CONNECTION_LABELS[kind]}`" size="min(960px, 96vw)"
             :close-on-click-modal="!saving && !testing" :show-close="!saving && !testing" :close-on-press-escape="!saving && !testing" @close="emit('close')">
    <div v-loading="loading">
      <p class="muted">配置一次，多接口复用。地址和凭据加密保存。</p>
      <div v-if="usedBy.length" class="connection-impact">
        <strong>保存后将立即应用到 {{ usedBy.length }} 个接口</strong>
        <div class="tag-list"><el-tag v-for="api in usedBy" :key="api.id" type="info">{{ api.name }}</el-tag></div>
      </div>
      <div v-if="usedByConnections.length" class="connection-impact">
        <strong>以下 Studio 连接正在使用此身份服务</strong>
        <div class="tag-list"><el-tag v-for="connection in usedByConnections" :key="connection.id" type="info">{{ connection.name }}</el-tag></div>
      </div>
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="连接名称" required><el-input v-model="name" :placeholder="kind === 'EXTERNAL_AUTH' ? '如：统一身份服务' : kind === 'DATASKILL' ? '如：团队 DataSkill Studio' : '如：生产星辰平台'" maxlength="100" /></el-form-item>
        <ExternalAuthForm v-if="kind === 'EXTERNAL_AUTH' && !loading" ref="externalForm" v-model="auth" mode="REALTIME" shared />
        <template v-else-if="kind === 'XINGCHEN'">
          <el-form-item label="平台基础地址" required><el-input v-model="baseUrl" placeholder="https://agent.example.com/v1" autocomplete="off" /></el-form-item>
          <div class="auth-guide">包含 /v1；系统自动追加 /chat-messages/{app_id}。各应用的 app_id、api_key 和公钥在 API 中单独配置。</div>
        </template>
        <template v-else-if="kind === 'DATASKILL'">
          <el-form-item label="Studio 根地址" required><el-input v-model="studio.baseUrl" placeholder="https://studio.example.com（不含 /api）" autocomplete="off" /></el-form-item>
          <el-form-item label="Studio 服务凭据" :required="!hasServiceToken">
            <el-input v-model="studio.serviceToken" type="password" show-password autocomplete="new-password" :placeholder="hasServiceToken ? '已配置；留空保留，填写新值则替换' : '至少 32 个字符，或点击生成'" maxlength="4096"><template #append><el-button @click="generateToken">生成凭据</el-button></template></el-input>
          </el-form-item>
          <p class="muted">服务凭据用于 DataBridge 连接 Studio。个人 UAP 凭据由调用者提供，不保存在这里。</p>
          <el-form-item v-if="serviceTokenSha256" label="已保存服务凭据的 SHA-256"><el-input :model-value="serviceTokenSha256" readonly /></el-form-item>
          <div class="auth-guide">保存后重新打开可查看 SHA-256，将它用于 Studio 端的服务认证配置。更换凭据时需同步更新 Studio。</div>
          <el-form-item label="UAP 身份服务连接" required>
            <el-select v-model="studio.authConnectionId" placeholder="选择已配置的身份服务" style="width:100%" @change="selectIdentity"><el-option v-for="identity in identities" :key="identity.id" :value="identity.id" :label="identity.name" /></el-select>
          </el-form-item>
          <el-alert v-if="!identities.length" title="请先在连接管理中新建 UAP 身份服务，并配置 string 类型的工号映射。" type="info" :closable="false" />
          <el-form-item label="工号映射" required><el-select v-model="studio.staffCodeBinding" placeholder="选择 string 类型的身份字段" style="width:100%"><el-option v-for="binding in staffBindings" :key="binding.name" :value="binding.name" :label="`${binding.name} ← ${binding.path}`" /></el-select></el-form-item>
          <el-form-item label="身份服务标识" required><el-input v-model="studio.identityProvider" placeholder="uap，与 Studio 端配置一致" maxlength="64" /></el-form-item>
          <el-form-item label="启用反馈入口"><el-switch v-model="studio.enabled" /><span class="muted" style="margin-left:12px">同一时间只启用一个 Studio 连接；保存后立即生效。</span></el-form-item>
          <div class="auth-guide">
            <strong>Skill 反馈入口</strong><p><code>{{ gatewayOrigin }}/open/dataskill/feedback</code></p>
            <p v-if="selectedIdentity">个人凭据 Header：{{ selectedIdentity.inputHeader }}；前缀：{{ selectedIdentity.inputPrefix || '无' }}。UAP 返回的工号须与 Studio 用户名一致。</p>
            <p>同时提供反馈状态、撤回和 Skill 更新入口，无需另建业务 API。</p>
          </div>
        </template>
      </el-form>
      <section v-if="kind === 'EXTERNAL_AUTH'" class="test-panel">
        <div class="section-heading"><h3>验证连接</h3><span>可以测试尚未保存的配置</span></div>
        <div class="toolbar">
          <el-input v-model="credential" type="password" autocomplete="off" placeholder="测试凭证（不含前缀）" style="max-width: 400px" />
          <el-button :loading="testing" :disabled="saving || loading" @click="test">测试身份验证</el-button>
        </div>
        <ExternalAuthTrace v-if="trace" :trace="trace" />
      </section>
    </div>
    <template #footer>
      <el-button :disabled="saving || testing" @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="testing || loading" @click="save">保存连接</el-button>
    </template>
  </el-drawer>
</template>
