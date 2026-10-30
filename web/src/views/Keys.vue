<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { confirm, formatTime, request, type Api } from '../api'

interface Key { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; version: number; apiIds: number[] }

const keys = ref<Key[]>([])
const apis = ref<Api[]>([])
const created = ref<string>()
const loading = ref(false)
const saving = ref(false)
const editor = ref(false)
const editing = ref<Key>()
const name = ref('')
const apiIds = ref<number[]>([])
const eligibleApis = computed(() => apis.value.filter(api => api.auth === 'API_KEY'))
const apiLabel = (id: number) => {
  const api = apis.value.find(api => api.id === id)
  return api ? `${api.name} · ${api.method} ${api.path}${api.enabled ? '' : '（未启用）'}` : `接口 #${id}`
}

async function load() {
  loading.value = true
  try {
    const [nextKeys, nextApis] = await Promise.all([request<Key[]>('/admin/keys'), request<Api[]>('/admin/apis')])
    keys.value = nextKeys
    apis.value = nextApis
  } finally { loading.value = false }
}
onMounted(load)

async function openEditor(key?: Key) {
  await load()
  const current = key ? keys.value.find(item => item.id === key.id) : undefined
  if (key && !current) return ElMessage.warning('调用密钥已被吊销，请重新选择')
  editing.value = current
  name.value = current?.name ?? ''
  apiIds.value = [...(current?.apiIds ?? [])]
  editor.value = true
}

async function save() {
  if (saving.value) return
  if (!name.value.trim()) return ElMessage.warning('请填写调用方名称')
  saving.value = true
  try {
    const result = await request<Key & { key?: string }>(editing.value ? `/admin/keys/${editing.value.id}` : '/admin/keys', {
      method: editing.value ? 'PUT' : 'POST',
      body: { name: name.value.trim(), apiIds: apiIds.value, version: editing.value?.version },
    })
    editor.value = false
    if (result.key) created.value = result.key
    ElMessage.success(editing.value ? '授权已更新，后续调用立即生效' : 'Key 已创建')
    await load()
  } finally { saving.value = false }
}

async function copy() {
  await navigator.clipboard.writeText(created.value!)
  ElMessage.success('已复制')
}

async function revoke(key: Key) {
  if (!await confirm(`吊销「${key.name}」？使用它的客户端将立即无法调用接口。`, '确认吊销')) return
  await request(`/admin/keys/${key.id}`, { method: 'DELETE' })
  await load()
}
</script>

<template>
  <div class="page-head">
    <div><p class="eyebrow">ACCESS KEYS</p><h2>调用密钥</h2><p>每个 Key 只能调用已授权的接口；调用时在请求头 X-API-Key 中携带，建议每个调用方单独创建</p></div>
    <el-button type="primary" :disabled="loading" @click="openEditor()">创建 Key</el-button>
  </div>
  <el-alert v-if="keys.some(key => !key.apiIds.length)" title="存在未授权的 Key，当前无法调用任何 API Key 接口。请点击「编辑授权」选择允许访问的接口。" type="warning" :closable="false" class="key-notice" />
  <el-card v-loading="loading" shadow="never">
    <el-table :data="keys" empty-text="尚未创建调用密钥；使用外部身份验证的接口无需创建 API Key">
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column label="Key" width="140"><template #default="{ row }"><code>{{ row.prefix }}…</code></template></el-table-column>
      <el-table-column label="授权接口" min-width="170">
        <template #default="{ row }">
          <el-popover v-if="row.apiIds.length" placement="top" :width="360" trigger="hover">
            <template #reference><el-button link type="primary" :disabled="loading" @click="openEditor(row)">已授权 {{ row.apiIds.length }} 个接口</el-button></template>
            <div class="key-access-list"><div v-for="id in row.apiIds" :key="id">{{ apiLabel(id) }}</div></div>
          </el-popover>
          <el-tag v-else type="warning" size="small">未授权，无法调用</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" min-width="165"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="最近使用" min-width="165"><template #default="{ row }">{{ formatTime(row.lastUsedAt) || '从未使用' }}</template></el-table-column>
      <el-table-column label="操作" width="165" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" :disabled="loading" @click="openEditor(row)">编辑授权</el-button>
          <el-button link type="danger" :disabled="loading" @click="revoke(row)">吊销</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="editor" :title="editing ? '编辑 Key 授权' : '创建 Key'" width="640px" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="调用方名称" required><el-input v-model="name" maxlength="100" placeholder="如 CRM 系统" /></el-form-item>
      <el-form-item label="允许访问的接口">
        <el-select v-model="apiIds" multiple filterable clearable :multiple-limit="1000" placeholder="搜索接口名称或路径" style="width: 100%" no-data-text="暂无 API Key 接口，请先在接口管理中创建并保存">
          <el-option v-for="api in eligibleApis" :key="api.id" :value="api.id!" :label="apiLabel(api.id!)" />
        </el-select>
      </el-form-item>
      <el-alert :type="apiIds.length ? 'info' : 'warning'" :closable="false" :title="apiIds.length ? '仅允许访问选中的接口。新增或复制的接口需要单独授权；保存后立即生效。' : '未选择接口：此 Key 将无法调用任何 API Key 接口，可稍后再授权。'" />
    </el-form>
    <template #footer><el-button :disabled="saving" @click="editor = false">取消</el-button><el-button type="primary" :loading="saving" @click="save">{{ editing ? '保存授权' : '创建 Key' }}</el-button></template>
  </el-dialog>

  <el-dialog :model-value="!!created" title="Key 已创建" width="560px" @close="created = undefined">
    <el-alert type="warning" :closable="false" title="Key 只显示这一次，请立即保存。" style="margin-bottom: 12px" />
    <el-input :model-value="created" readonly class="mono"><template #append><el-button @click="copy">复制</el-button></template></el-input>
    <template #footer><el-button type="primary" @click="created = undefined">我已保存</el-button></template>
  </el-dialog>
</template>

<style scoped>
.key-notice { margin-bottom: 16px; }
.key-access-list { max-height: 300px; overflow: auto; overflow-wrap: anywhere; }
.key-access-list > div + div { margin-top: 8px; }
</style>
