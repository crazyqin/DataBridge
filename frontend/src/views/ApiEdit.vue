<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { request } from '../api'
const props = defineProps<{ api?: any }>()
const emit = defineEmits<{ saved: []; close: [] }>()
const sources = ref<any[]>([])
const form = ref<any>({})
const keys = ref('')
const filters = ref('')
const agentRules = ref('')
const saving = ref(false)
const testing = ref(false)
const result = ref<any>(null)
function reset() {
  form.value = props.api ? structuredClone(props.api) : { name:'', code:'', path:'/open/', httpMethod:'GET', authMode:'API_KEY', allowedUserAgents:[], dataMode:'REALTIME', enabled:false, paramSchema:[], manualSchema:[], rowKeyFields:[], filterFields:[], timeoutSeconds:10, maxRows:10000, syncCron:'0 */30 * * * *', allowEmptySync:false }
  keys.value = (form.value.rowKeyFields || []).join(', ')
  filters.value = (form.value.filterFields || []).join(', ')
  agentRules.value = (form.value.allowedUserAgents || []).join('\n')
  result.value = null
}
watch(() => props.api, reset, { immediate:true })
onMounted(async () => { sources.value = await request('/admin/datasources') })
function payload() { return { ...form.value, rowKeyFields:keys.value.split(',').map((s:string)=>s.trim()).filter(Boolean), filterFields:filters.value.split(',').map((s:string)=>s.trim()).filter(Boolean), allowedUserAgents:agentRules.value.split('\n').map(s=>s.trim()).filter(Boolean) } }
async function save() {
  saving.value=true
  try { fillCode(); const body=payload(); const saved=await request(form.value.id ? `/admin/apis/${form.value.id}` : '/admin/apis',form.value.id?'PUT':'POST',body); form.value=saved; ElMessage.success('API 已保存'); emit('saved') }
  finally { saving.value=false }
}
async function test() {
  if (!form.value.id) { ElMessage.warning('请先保存 API'); return }
  let params:any={}
  if (form.value.dataMode==='REALTIME') {
    const answer=await ElMessageBox.prompt('输入测试参数 JSON，例如 {"id": "10001"}', '测试 SQL', { inputValue:'{}', inputType:'textarea' })
    try { params=JSON.parse(answer.value) } catch { ElMessage.error('JSON 格式错误'); return }
  }
  testing.value=true
  try { result.value=await request(`/admin/apis/${form.value.id}/test`,'POST',params); ElMessage.success(`执行成功，返回 ${result.value.count} 行`) }
  finally { testing.value=false }
}
function addField(target:'paramSchema'|'manualSchema') { form.value[target].push({ name:'',type:'string',required:false }) }
function fillCode() {
  if (!form.value.code) {
    const code=String(form.value.path || '').replace(/^\/open\//, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
    form.value.code=/^[A-Za-z]/.test(code) ? code : `api_${code}`
  }
}
</script>
<template>
  <div class="page-head"><div><h2>{{ form.id ? '编辑 API' : '新增 API' }}</h2><p>配置完成后启用，即可通过统一入口调用</p></div><el-button @click="emit('close')">返回列表</el-button></div>
  <el-card shadow="never"><el-form label-width="120px" style="max-width:950px" @submit.prevent="save">
    <el-row :gutter="20"><el-col :span="12"><el-form-item label="接口名称"><el-input v-model="form.name"/></el-form-item></el-col><el-col :span="12"><el-form-item label="接口编码"><div style="width:100%"><el-input v-model="form.code" placeholder="如 customer_query"/><small style="color:#8997a8">平台内的唯一标识，不影响访问地址；留空时按路径自动填写</small></div></el-form-item></el-col></el-row>
    <el-row :gutter="20"><el-col :span="12"><el-form-item label="接口路径"><el-input v-model="form.path" placeholder="/open/customer" @blur="fillCode"/></el-form-item></el-col><el-col :span="12"><el-form-item label="请求方式"><el-select v-model="form.httpMethod" style="width:100%"><el-option label="GET" value="GET"/><el-option label="POST" value="POST"/></el-select></el-form-item></el-col></el-row>
    <el-form-item label="访问方式"><el-radio-group v-model="form.authMode"><el-radio value="API_KEY">API Key 鉴权</el-radio><el-radio value="PUBLIC">公开访问</el-radio></el-radio-group></el-form-item>
    <el-form-item label="允许的 User-Agent"><div style="width:100%"><el-input v-model="agentRules" type="textarea" :rows="3" placeholder="每行一条；留空表示不限制。例：MyClient/1.0 或 MyClient/*"/><small style="color:#8997a8">精确匹配；末尾 * 表示前缀匹配。User-Agent 可被客户端自行设置，不能代替 API Key。</small></div></el-form-item>
    <el-form-item label="数据模式"><el-radio-group v-model="form.dataMode"><el-radio-button value="REALTIME">实时查询</el-radio-button><el-radio-button value="SNAPSHOT">定时同步</el-radio-button><el-radio-button value="MANUAL">手工维护</el-radio-button></el-radio-group></el-form-item>
    <template v-if="form.dataMode!=='MANUAL'"><el-form-item label="数据源"><el-select v-model="form.datasourceId" style="width:100%" placeholder="选择数据源"><el-option v-for="source in sources" :key="source.id" :label="source.name" :value="source.id"/></el-select></el-form-item>
      <el-form-item label="SELECT SQL"><el-input v-model="form.sqlText" type="textarea" :rows="8" class="code-editor" placeholder="SELECT id, name FROM table WHERE id = :id"/></el-form-item></template>
    <template v-if="form.dataMode==='REALTIME' || form.dataMode==='SNAPSHOT'"><el-form-item :label="form.dataMode==='REALTIME' ? '请求参数' : '字段类型'"><div style="width:100%"><el-table :data="form.paramSchema" size="small"><el-table-column label="字段名"><template #default="scope"><el-input v-model="scope.row.name"/></template></el-table-column><el-table-column label="类型" width="155"><template #default="scope"><el-select v-model="scope.row.type"><el-option v-for="t in ['string','integer','decimal','boolean','date','datetime']" :key="t" :value="t" :label="t"/></el-select></template></el-table-column><el-table-column label="必填" width="75"><template #default="scope"><el-switch v-model="scope.row.required"/></template></el-table-column><el-table-column width="70"><template #default="scope"><el-button link type="danger" @click="form.paramSchema.splice(scope.$index,1)">删除</el-button></template></el-table-column></el-table><el-button text type="primary" @click="addField('paramSchema')">+ 添加字段</el-button></div></el-form-item></template>
    <template v-if="form.dataMode==='SNAPSHOT'"><el-form-item label="唯一键"><el-input v-model="keys" placeholder="prod_id 或 area_id, prod_id"/></el-form-item><el-form-item label="同步 Cron"><el-input v-model="form.syncCron" placeholder="0 */30 * * * *"/></el-form-item><el-form-item label="空结果覆盖"><el-switch v-model="form.allowEmptySync"/><span style="margin-left:12px;color:#8b97a8">默认关闭，防止意外清空快照</span></el-form-item>
      <el-form-item v-if="form.id" label="上次同步"><span>{{ form.lastSyncAt || '尚未同步' }} · {{ form.lastSyncStatus || '未运行' }} · {{ form.lastSyncCount ?? 0 }} 行</span></el-form-item><el-alert v-if="form.lastSyncError" :title="form.lastSyncError" type="error" :closable="false" style="margin-bottom:16px"/></template>
    <template v-if="form.dataMode==='MANUAL'"><el-form-item label="字段定义"><div style="width:100%"><el-table :data="form.manualSchema" size="small"><el-table-column label="字段名"><template #default="scope"><el-input v-model="scope.row.name"/></template></el-table-column><el-table-column label="类型" width="155"><template #default="scope"><el-select v-model="scope.row.type"><el-option v-for="t in ['string','integer','decimal','boolean','date','datetime']" :key="t" :value="t" :label="t"/></el-select></template></el-table-column><el-table-column label="必填" width="75"><template #default="scope"><el-switch v-model="scope.row.required"/></template></el-table-column><el-table-column width="70"><template #default="scope"><el-button link type="danger" @click="form.manualSchema.splice(scope.$index,1)">删除</el-button></template></el-table-column></el-table><el-button text type="primary" @click="addField('manualSchema')">+ 添加字段</el-button></div></el-form-item></template>
    <el-form-item v-if="form.dataMode!=='REALTIME'" label="允许等值过滤"><el-input v-model="filters" placeholder="字段名，多个用逗号分隔"/></el-form-item>
    <el-row :gutter="20"><el-col :span="12"><el-form-item label="查询超时 (秒)"><el-input-number v-model="form.timeoutSeconds" :min="1" :max="120"/></el-form-item></el-col><el-col :span="12"><el-form-item label="最大行数"><el-input-number v-model="form.maxRows" :min="1" :max="100000"/></el-form-item></el-col></el-row>
    <el-form-item label="启用接口"><el-switch v-model="form.enabled"/></el-form-item><el-form-item><el-button type="primary" :loading="saving" @click="save">保存配置</el-button><el-button v-if="form.id && form.dataMode!=='MANUAL'" :loading="testing" @click="test">测试 SQL</el-button></el-form-item>
  </el-form><el-divider v-if="result"/><div v-if="result"><strong>测试结果 · {{ result.count }} 行 · {{ result.elapsedMs }}ms</strong><pre class="result-pre">{{ JSON.stringify(result.data,null,2) }}</pre></div></el-card>
</template>
<style scoped>.result-pre { max-height:350px;overflow:auto;background:#f4f6f8;padding:15px;border-radius:5px; }</style>
