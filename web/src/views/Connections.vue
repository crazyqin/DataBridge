<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { confirm, CONNECTION_LABELS, formatTime, request, type ConnectionKind, type ConnectionSummary } from '../api'
import ConnectionEditor from './ConnectionEditor.vue'
import UiIcon from '../components/UiIcon.vue'
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
    <div><p class="eyebrow">SHARED CONNECTIONS</p><h2>连接管理</h2><p>统一维护身份服务、星辰平台和 DataSkill Studio。</p></div>
    <div class="page-actions"><el-button @click="editor = { kind: 'DATASKILL' }"><UiIcon name="plus" />新建 DataSkill Studio</el-button><el-button @click="editor = { kind: 'XINGCHEN' }"><UiIcon name="plus" />新建星辰平台</el-button><el-button type="primary" @click="editor = { kind: 'EXTERNAL_AUTH' }"><UiIcon name="plus" />新建身份服务</el-button></div>
  </div>
  <div class="info-strip"><span class="info-mark">i</span><span>已有 API 的配置会自动归入这里。修改连接后关联接口立即生效；正在使用的连接不能删除。</span></div>
  <el-card shadow="never" v-loading="loading">
    <div class="table-toolbar">
      <el-input v-model="search" clearable placeholder="搜索连接名称" style="max-width: 320px"><template #prefix><UiIcon name="search" /></template></el-input>
      <el-radio-group v-model="kind"><el-radio-button value="">全部</el-radio-button><el-radio-button value="EXTERNAL_AUTH">身份服务</el-radio-button><el-radio-button value="XINGCHEN">星辰平台</el-radio-button><el-radio-button value="DATASKILL">DataSkill Studio</el-radio-button></el-radio-group>
      <span class="muted toolbar-count">{{ visible.length }} 个连接</span>
    </div>
    <el-table :data="visible" empty-text="暂无匹配连接，可在右上角新建">
      <el-table-column label="连接" min-width="220"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="muted">{{ CONNECTION_LABELS[row.kind as ConnectionKind] }}</div></template></el-table-column>
      <el-table-column label="使用范围" min-width="240"><template #default="{ row }">
        <div v-if="row.usedBy.length" class="tag-list"><el-tag v-for="api in row.usedBy.slice(0, 3)" :key="api.id" type="info">{{ api.name }}</el-tag><span v-if="row.usedBy.length > 3" class="muted">等 {{ row.usedBy.length }} 个接口</span></div>
        <div v-if="row.usedByConnections.length" class="tag-list"><el-tag v-for="connection in row.usedByConnections" :key="connection.id" type="info">Studio：{{ connection.name }}</el-tag></div>
        <template v-if="row.kind === 'DATASKILL'"><el-tag :type="row.activeIntegration ? 'success' : 'info'">{{ row.activeIntegration ? '反馈入口已启用' : '反馈入口未启用' }}</el-tag><div class="muted">/open/dataskill/*</div></template>
        <span v-else-if="!row.usedBy.length && !row.usedByConnections.length" class="muted">尚未被使用</span>
      </template></el-table-column>
      <el-table-column label="更新时间" min-width="175"><template #default="{ row }">{{ formatTime(row.updatedAt) }}</template></el-table-column>
      <el-table-column label="操作" width="155"><template #default="{ row }">
        <el-button link type="primary" @click="editor = { id: row.id, kind: row.kind }">编辑配置</el-button>
        <el-tooltip :disabled="!row.usedBy.length && !row.usedByConnections.length && !row.activeIntegration" content="请先解除连接引用，或停用 Studio 反馈入口"><span><el-button link type="danger" :disabled="!!row.usedBy.length || !!row.usedByConnections.length || row.activeIntegration" @click="remove(row)">删除</el-button></span></el-tooltip>
      </template></el-table-column>
    </el-table>
  </el-card>
  <ConnectionEditor v-if="editor" :key="`${editor.kind}-${editor.id}`" :id="editor.id" :kind="editor.kind" @close="editor = undefined" @saved="editor = undefined; load()" />
</template>
