<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onMounted, ref } from 'vue'
import { confirm, formatTime, request } from '../api'

interface Key { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }

const keys = ref<Key[]>([])
const name = ref('')
const created = ref<string>()

const load = async () => { keys.value = await request<Key[]>('/admin/keys') }
onMounted(load)

async function create() {
  const result = await request<{ key: string }>('/admin/keys', { method: 'POST', body: { name: name.value } })
  created.value = result.key
  name.value = ''
  await load()
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
    <div><h2>API Key</h2><p>调用「需要 API Key」的接口时，在请求头 X-API-Key 中携带；建议每个调用方单独创建</p></div>
  </div>
  <div class="toolbar">
    <el-input v-model="name" placeholder="调用方名称，如 CRM 系统" style="width: 280px" @keyup.enter="create" />
    <el-button type="primary" :disabled="!name.trim()" @click="create">创建 Key</el-button>
  </div>
  <el-card shadow="never">
    <el-table :data="keys" stripe>
      <el-table-column prop="name" label="名称" min-width="160" />
      <el-table-column label="Key" width="160"><template #default="{ row }"><code>{{ row.prefix }}…</code></template></el-table-column>
      <el-table-column label="创建时间" min-width="165"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="最近使用" min-width="165"><template #default="{ row }">{{ formatTime(row.lastUsedAt) || '从未使用' }}</template></el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }"><el-button link type="danger" @click="revoke(row)">吊销</el-button></template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog :model-value="!!created" title="Key 已创建" width="560px" @close="created = undefined">
    <el-alert type="warning" :closable="false" title="Key 只显示这一次，请立即保存。" style="margin-bottom: 12px" />
    <el-input :model-value="created" readonly class="mono"><template #append><el-button @click="copy">复制</el-button></template></el-input>
    <template #footer><el-button type="primary" @click="created = undefined">我已保存</el-button></template>
  </el-dialog>
</template>
