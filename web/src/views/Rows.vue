<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, reactive, ref } from 'vue'
import { confirm, display, formatTime, MODE_LABELS, request, type Api, type Field, type StoredRow } from '../api'

const PAGE_SIZE = 50

const apis = ref<Api[]>([])
const apiId = ref<number>()
const api = computed(() => apis.value.find(item => item.id === apiId.value))
const rows = ref<StoredRow[]>([])
const total = ref(0)
const allTotal = ref(0)
const page = ref(1)
const searchDraft = ref('')
const search = ref('')
const dragKey = ref<string>()
const editor = reactive({ open: false, saving: false, row: undefined as StoredRow | undefined, values: {} as Record<string, unknown> })
const remarkEditor = reactive({ open: false, saving: false, row: undefined as StoredRow | undefined, value: '' })
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
  const result = await request<{ items: StoredRow[]; total: number; allTotal: number }>(
    `/admin/apis/${id}/rows?page=${page.value}&pageSize=${PAGE_SIZE}&search=${encodeURIComponent(search.value)}`)
  if (current !== loadId) return // a newer selection or page is loading
  if (!result.items.length && page.value > 1 && result.total > 0) {
    page.value = Math.ceil(result.total / PAGE_SIZE)
    return loadRows()
  }
  rows.value = result.items
  total.value = result.total
  allTotal.value = result.allTotal
}

async function selectApi() {
  page.value = 1
  rows.value = []
  searchDraft.value = ''
  search.value = ''
  await loadRows()
}

async function applySearch() {
  search.value = searchDraft.value.trim()
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

async function move(key: string, position: number, jump = false) {
  await request(`/admin/apis/${apiId.value}/rows/${encodeURIComponent(key)}/move`, { method: 'POST', body: { position } })
  if (jump) page.value = search.value ? 1 : Math.ceil(position / PAGE_SIZE)
  await loadRows()
}

async function drop(row: StoredRow) {
  const key = dragKey.value
  dragKey.value = undefined
  if (key && key !== row.key) await move(key, row.position)
}

async function dropAdjacent(direction: -1 | 1) {
  const key = dragKey.value
  dragKey.value = undefined
  const targetPage = page.value + direction
  if (!key || targetPage < 1 || targetPage > Math.ceil(total.value / PAGE_SIZE)) return
  const id = apiId.value
  const result = await request<{ items: StoredRow[] }>(
    `/admin/apis/${id}/rows?page=${targetPage}&pageSize=${PAGE_SIZE}&search=${encodeURIComponent(search.value)}`)
  const target = direction < 0 ? result.items.at(-1) : result.items[0]
  if (!target) return
  await request(`/admin/apis/${id}/rows/${encodeURIComponent(key)}/move`, { method: 'POST', body: { position: target.position } })
  page.value = targetPage
  await loadRows()
}

async function moveTo(row: StoredRow) {
  const result = await ElMessageBox.prompt(`当前是第 ${row.position} 位；请输入在全部 ${allTotal.value} 条数据中的目标位置`, '移动记录', {
    inputValue: String(row.position), inputPattern: /^[1-9]\d*$/,
    inputErrorMessage: '请输入有效的位置',
    inputValidator: value => Number(value) <= allTotal.value || `位置不能超过 ${allTotal.value}`,
  }).catch(() => null)
  if (!result) return
  await move(row.key, Number(result.value), true)
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

function editRemark(row: StoredRow) {
  remarkEditor.row = row
  remarkEditor.value = row.remark
  remarkEditor.open = true
}

async function saveRemark() {
  const row = remarkEditor.row
  if (!row || remarkEditor.saving) return
  remarkEditor.saving = true
  try {
    await request(`/admin/apis/${apiId.value}/rows/${encodeURIComponent(row.key)}/remark`, {
      method: 'PATCH', body: { version: row.version, remark: remarkEditor.value },
    })
    remarkEditor.open = false
    ElMessage.success('备注已保存')
    await loadRows()
  } finally {
    remarkEditor.saving = false
  }
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
    <el-input v-if="api" v-model="searchDraft" clearable placeholder="搜索所有记录的字段值" style="width: 280px"
              @keyup.enter="applySearch" @clear="applySearch" />
    <el-button v-if="api" @click="applySearch">查询</el-button>
    <span v-if="api" class="muted">
      {{ search ? `匹配 ${total} / ${allTotal} 条` : `共 ${total} 条` }}<template v-if="api.mode === 'SNAPSHOT'"> · 上次同步 {{ api.syncAt ? formatTime(api.syncAt) : '尚未同步' }}</template>
    </span>
    <el-button v-if="api?.mode === 'SNAPSHOT'" link @click="resetSort">恢复默认排序</el-button>
  </div>
  <div v-if="api?.mode === 'SNAPSHOT' && total > PAGE_SIZE" class="toolbar">
    <span class="muted">拖动排序图标到：</span>
    <span v-if="page > 1" class="sort-target" :class="{ active: dragKey }"
          @dragover.prevent @drop.prevent="dropAdjacent(-1)">上一页末尾</span>
    <span v-if="page * PAGE_SIZE < total" class="sort-target" :class="{ active: dragKey }"
          @dragover.prevent @drop.prevent="dropAdjacent(1)">下一页开头</span>
    <span class="muted">点击位次可直接指定目标位置</span>
  </div>
  <el-card shadow="never">
    <el-empty v-if="!api" description="请先创建定时同步或手工维护的 API" />
    <el-table v-else :data="rows" stripe row-key="key">
      <el-table-column v-if="api.mode === 'SNAPSHOT'" label="排序" width="150" fixed="left">
        <template #default="{ row }">
          <span class="drag" draggable="true" title="拖动调整顺序"
                @dragstart="dragKey = row.key" @dragend="dragKey = undefined" @dragover.prevent @drop.prevent="drop(row)">☰</span>
          <el-button link type="primary" title="移动到指定位置" @click="moveTo(row)">第 {{ row.position }} 位</el-button>
        </template>
      </el-table-column>
      <el-table-column v-for="name in columns" :key="name" :label="name" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">{{ display(row.data[name]) }}</template>
      </el-table-column>
      <el-table-column label="备注" width="260" fixed="right">
        <template #default="{ row }">
          <div class="remark-cell">
            <span class="remark-preview" :title="row.remark">{{ row.remark || '暂无备注' }}</span>
            <el-button link type="primary" @click="editRemark(row)">{{ row.remark ? '编辑' : '添加' }}</el-button>
          </div>
        </template>
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

  <el-dialog v-model="remarkEditor.open" title="编辑备注" width="540px"
             :close-on-click-modal="!remarkEditor.saving" :show-close="!remarkEditor.saving"
             :close-on-press-escape="!remarkEditor.saving">
    <el-input v-model="remarkEditor.value" type="textarea" :rows="5" maxlength="2000" show-word-limit
              placeholder="输入这条记录的备注；清空后保存可删除备注" />
    <template #footer>
      <el-button :disabled="remarkEditor.saving" @click="remarkEditor.open = false">取消</el-button>
      <el-button type="primary" :loading="remarkEditor.saving" @click="saveRemark">保存</el-button>
    </template>
  </el-dialog>
</template>
