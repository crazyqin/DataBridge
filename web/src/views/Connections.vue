<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { confirm, CONNECTION_LABELS, formatTime, request, type ConnectionKind, type ConnectionSummary } from '../api'
import ConnectionEditor from './ConnectionEditor.vue'
const connections = ref<ConnectionSummary[]>([])
const search = ref('')
const kind = ref<ConnectionKind | ''>('')
const loading = ref(false)
const editor = ref<{ id?: number; kind: ConnectionKind }>()
const visible = computed(() => connections.value.filter(item => (!kind.value || item.kind === kind.value) && item.name.toLowerCase().includes(search.value.toLowerCase())))
async function load() {
  loading.value = true
  try { connections.value = await request<ConnectionSummary[]>('/admin/connections') } finally { loading.value = false }
}
async function remove(connection: ConnectionSummary) {
  if (!await confirm(`删除连接「${connection.name}」？`, '删除连接')) return
  await request(`/admin/connections/${connection.id}`, { method: 'DELETE' }); await load()
}
onMounted(load)
</script>

<template>
  <div class="page-head">
    <div><p class="eyebrow">SHARED CONNECTIONS</p><h2>连接管理</h2><p>统一维护身份服务和平台地址，API 选择后即可复用。</p></div>
    <div class="page-actions"><el-button @click="editor = { kind: 'XINGCHEN' }">新建星辰平台</el-button><el-button type="primary" @click="editor = { kind: 'EXTERNAL_AUTH' }">新建身份服务</el-button></div>
  </div>
  <div class="info-strip"><span class="info-mark">i</span><span>已有 API 的配置会自动归入这里。修改连接后关联接口立即生效；正在使用的连接不能删除。</span></div>
  <el-card shadow="never" v-loading="loading">
    <div class="table-toolbar">
      <el-input v-model="search" clearable placeholder="搜索连接名称" style="max-width: 320px" />
      <el-radio-group v-model="kind"><el-radio-button value="">全部</el-radio-button><el-radio-button value="EXTERNAL_AUTH">身份服务</el-radio-button><el-radio-button value="XINGCHEN">星辰平台</el-radio-button></el-radio-group>
      <span class="muted toolbar-count">{{ visible.length }} 个连接</span>
    </div>
    <el-table :data="visible" empty-text="暂无匹配连接，可在右上角新建">
      <el-table-column label="连接" min-width="220"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="muted">{{ CONNECTION_LABELS[row.kind as ConnectionKind] }}</div></template></el-table-column>
      <el-table-column label="使用范围" min-width="240"><template #default="{ row }">
        <div v-if="row.usedBy.length" class="tag-list"><el-tag v-for="api in row.usedBy.slice(0, 3)" :key="api.id" type="info">{{ api.name }}</el-tag><span v-if="row.usedBy.length > 3" class="muted">等 {{ row.usedBy.length }} 个接口</span></div>
        <span v-else class="muted">尚未被 API 使用</span>
      </template></el-table-column>
      <el-table-column label="更新时间" min-width="175"><template #default="{ row }">{{ formatTime(row.updatedAt) }}</template></el-table-column>
      <el-table-column label="操作" width="155"><template #default="{ row }">
        <el-button link type="primary" @click="editor = { id: row.id, kind: row.kind }">编辑配置</el-button>
        <el-tooltip :disabled="!row.usedBy.length" content="请先为关联 API 更换连接"><span><el-button link type="danger" :disabled="!!row.usedBy.length" @click="remove(row)">删除</el-button></span></el-tooltip>
      </template></el-table-column>
    </el-table>
  </el-card>
  <ConnectionEditor v-if="editor" :key="`${editor.kind}-${editor.id}`" :id="editor.id" :kind="editor.kind" @close="editor = undefined" @saved="editor = undefined; load()" />
</template>
