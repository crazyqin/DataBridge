<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CONNECTION_LABELS, defaultExternalAuth, request, RequestError, type Connection, type ConnectionKind, type ExternalAuthConfig, type ExternalAuthTrace as AuthTrace } from '../api'
import ExternalAuthForm from './ExternalAuthForm.vue'
import ExternalAuthTrace from './ExternalAuthTrace.vue'
const props = defineProps<{ id?: number; kind: ConnectionKind }>()
const emit = defineEmits<{ close: []; saved: [connection: Connection] }>()
const name = ref('')
const version = ref<number>()
const usedBy = ref<Connection['usedBy']>([])
const auth = ref(defaultExternalAuth())
const baseUrl = ref('')
const loading = ref(!!props.id)
const saving = ref(false)
const testing = ref(false)
const credential = ref('')
const trace = ref<AuthTrace>()
const externalForm = ref<InstanceType<typeof ExternalAuthForm>>()
const configValue = () => props.kind === 'EXTERNAL_AUTH' ? externalForm.value!.value() : { baseUrl: baseUrl.value }
onMounted(async () => {
  if (!props.id) return
  try {
    const connection = await request<Connection>(`/admin/connections/${props.id}`)
    name.value = connection.name; version.value = connection.version; usedBy.value = connection.usedBy
    if (connection.kind === 'EXTERNAL_AUTH') auth.value = connection.config as ExternalAuthConfig
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
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="连接名称" required><el-input v-model="name" :placeholder="kind === 'EXTERNAL_AUTH' ? '如：统一身份服务' : '如：生产星辰平台'" maxlength="100" /></el-form-item>
        <ExternalAuthForm v-if="kind === 'EXTERNAL_AUTH' && !loading" ref="externalForm" v-model="auth" mode="REALTIME" shared />
        <template v-else-if="kind === 'XINGCHEN'">
          <el-form-item label="平台基础地址" required><el-input v-model="baseUrl" placeholder="https://agent.example.com/v1" autocomplete="off" /></el-form-item>
          <div class="auth-guide">包含 /v1；系统自动追加 /chat-messages/{app_id}。各应用的 app_id、api_key 和公钥在 API 中单独配置。</div>
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
