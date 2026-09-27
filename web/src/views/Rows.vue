<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, reactive, ref } from 'vue'
import { confirm, display, formatTime, MODE_LABELS, request, type Api, type Field, type StoredRow } from '../api'

const PAGE_SIZE = 50

const apis = ref<Api[]>([])
const apiId = ref<number>()
const api = computed(() => apis.value.find(item => item.id === apiId.value))
const rows = ref<StoredRow[]>([])
const total = ref(0)
const page = ref(1)
const dragFrom = ref<number>()
const editor = reactive({ open: false, saving: false, row: undefined as StoredRow | undefined, values: {} as Record<string, unknown> })
let loadId = 0

const columns = computed(() => api.value?.mode === 'MANUAL'
  ? api.value.fields.map(field => field.name)
  : [...new Set(rows.value.flatMap(row => Object.keys(row.data)))])

async function loadApis() {
  apis.value = (await request<Api[]>('/admin/apis')).filter(item => item.mode !== 'REALTIME')
  if (!api.value) apiId.value = apis.value[0]?.id
  await loadRows()
}

async function loadRows() {
  const current = ++loadId
  const id = apiId.value
  if (!id) return
  const result = await request<{ items: StoredRow[]; total: number }>(`/admin/apis/${id}/rows?page=${page.value}&pageSize=${PAGE_SIZE}`)
  if (current !== loadId) return // a newer selection or page is loading
  if (!result.items.length && page.value > 1 && result.total > 0) {
    page.value = Math.ceil(result.total / PAGE_SIZE)
    return loadRows()
  }
  rows.value = result.items
  total.value = result.total
}

async function selectApi() {
  page.value = 1
  rows.value = []
  await loadRows()
}

async function sync() {
  try {
    const result = await request<{ count: number }>(`/admin/apis/${apiId.value}/sync`, { method: 'POST' })
    ElMessage.success(`同步完成，${result.count} 行`)
  } finally {
    await loadApis()
  }
}

async function drop(index: number) {
  const from = dragFrom.value
  dragFrom.value = undefined
  if (from === undefined || from === index) return
  const position = (page.value - 1) * PAGE_SIZE + index + 1
  await request(`/admin/apis/${apiId.value}/rows/${rows.value[from].key}/move`, { method: 'POST', body: { position } })
  await loadRows()
}

async function resetSort() {
  if (!await confirm('清除所有人工排序，恢复为 SQL 返回的顺序？', '恢复默认排序')) return
  await request(`/admin/apis/${apiId.value}/sort`, { method: 'DELETE' })
  await loadRows()
}

function edit(row?: StoredRow) {
  const fields = api.value!.fields
  editor.row = row
  editor.values = Object.fromEntries(fields.map(field =>
    [field.name, row && Object.hasOwn(row.data, field.name) ? row.data[field.name] : field.type === 'boolean' && field.required ? false : null]))
  editor.open = true
}

async function save() {
  if (editor.saving) return
  editor.saving = true
  try {
    const row = editor.row
    const base = `/admin/apis/${apiId.value}/rows`
    await request(row ? `${base}/${row.key}` : base, {
      method: row ? 'PUT' : 'POST',
      body: row ? { version: row.version, data: editor.values } : editor.values,
    })
    editor.open = false
    ElMessage.success('已保存')
    await loadRows()
  } finally {
    editor.saving = false
  }
}

async function remove(row: StoredRow) {
  if (!await confirm('删除这条记录？', '确认删除')) return
  await request(`/admin/apis/${apiId.value}/rows/${row.key}?version=${row.version}`, { method: 'DELETE' })
  await loadRows()
}

const booleanChoice = (field: Field) => editor.values[field.name] === true ? 'true' : editor.values[field.name] === false ? 'false' : ''

onMounted(loadApis)
</script>

<template>
  <div class="page-head">
    <div><h2>数据维护</h2><p>定时同步的数据可以拖动调整顺序；手工维护的数据可以增删改</p></div>
    <div>
      <el-button v-if="api?.mode === 'SNAPSHOT'" @click="sync">立即同步</el-button>
      <el-button v-if="api?.mode === 'MANUAL'" type="primary" @click="edit()">新增记录</el-button>
    </div>
  </div>
  <div class="toolbar">
    <el-select v-model="apiId" placeholder="选择 API" style="width: 320px" @change="selectApi">
      <el-option v-for="item in apis" :key="item.id" :label="`${item.name}（${MODE_LABELS[item.mode]}）`" :value="item.id!" />
    </el-select>
    <span v-if="api" class="muted">
      共 {{ total }} 条<template v-if="api.mode === 'SNAPSHOT'"> · 上次同步 {{ api.syncAt ? formatTime(api.syncAt) : '尚未同步' }}</template>
    </span>
    <el-button v-if="api?.mode === 'SNAPSHOT'" link @click="resetSort">恢复默认排序</el-button>
  </div>
  <el-card shadow="never">
    <el-empty v-if="!api" description="请先创建定时同步或手工维护的 API" />
    <el-table v-else :data="rows" stripe row-key="key">
      <el-table-column v-if="api.mode === 'SNAPSHOT'" label="排序" width="64">
        <template #default="{ $index }">
          <span class="drag" draggable="true" title="拖动调整顺序"
                @dragstart="dragFrom = $index" @dragover.prevent @drop.prevent="drop($index)">☰</span>
        </template>
      </el-table-column>
      <el-table-column v-for="name in columns" :key="name" :label="name" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ display(row.data[name]) }}</template>
      </el-table-column>
      <el-table-column v-if="api.mode === 'MANUAL'" label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="edit(row)">修改</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
  <el-pagination v-if="total > PAGE_SIZE" v-model:current-page="page" :page-size="PAGE_SIZE" :total="total"
                 layout="prev, pager, next" style="margin-top: 16px; justify-content: flex-end" @current-change="loadRows" />

  <el-dialog v-model="editor.open" :title="editor.row ? '修改记录' : '新增记录'" width="540px"
             :close-on-click-modal="!editor.saving" :show-close="!editor.saving" :close-on-press-escape="!editor.saving">
    <el-form v-if="api" label-width="120px" @submit.prevent="save">
      <el-form-item v-for="field in api.fields" :key="field.name" :label="field.name" :required="field.required">
        <el-switch v-if="field.type === 'boolean' && field.required" v-model="editor.values[field.name]" />
        <el-select v-else-if="field.type === 'boolean'" :model-value="booleanChoice(field)" style="width: 100%"
                   @change="editor.values[field.name] = $event === '' ? null : $event === 'true'">
          <el-option label="未设置" value="" /><el-option label="是" value="true" /><el-option label="否" value="false" />
        </el-select>
        <el-date-picker v-else-if="field.type === 'date' || field.type === 'datetime'" v-model="editor.values[field.name]"
                        :type="field.type" :value-format="field.type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ss'" style="width: 100%" />
        <el-input v-else v-model="editor.values[field.name] as string" :inputmode="field.type === 'string' ? 'text' : 'decimal'" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="editor.saving" @click="editor.open = false">取消</el-button>
      <el-button type="primary" :loading="editor.saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
