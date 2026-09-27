<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onMounted, ref } from 'vue'
import { confirm, request, type Datasource } from '../api'

type Form = Omit<Datasource, 'id' | 'version'> & { id?: number; version?: number; password: string }

const sources = ref<Datasource[]>([])
const form = ref<Form>()
const saving = ref(false)

const load = async () => { sources.value = await request<Datasource[]>('/admin/datasources') }
onMounted(load)

function edit(source?: Datasource) {
  form.value = source
    ? { ...source, password: '' }
    : { name: '', host: '', port: 5432, database: '', username: '', password: '', ssl: 'disable', enabled: true }
}

async function save() {
  const value = form.value!
  saving.value = true
  try {
    await request(value.id ? `/admin/datasources/${value.id}` : '/admin/datasources', { method: value.id ? 'PUT' : 'POST', body: value })
    form.value = undefined
    ElMessage.success('已保存')
  } finally {
    saving.value = false
    await load()
  }
}

async function test(source: Datasource) {
  const result = await request<{ version: string; elapsedMs: number }>(`/admin/datasources/${source.id}/test`, { method: 'POST' })
  ElMessage.success(`连接成功（${result.elapsedMs}ms）：${result.version.split(' on ')[0]}`)
}

async function remove(source: Datasource) {
  if (!await confirm(`删除数据源「${source.name}」？`, '确认删除')) return
  await request(`/admin/datasources/${source.id}`, { method: 'DELETE' })
  await load()
}
</script>

<template>
  <div class="page-head">
    <div><h2>数据源</h2><p>PostgreSQL 数据源，请使用只授予 SELECT 权限的账号</p></div>
    <el-button type="primary" @click="edit()">新增数据源</el-button>
  </div>
  <el-card shadow="never">
    <el-table :data="sources" stripe>
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column label="地址" min-width="260">
        <template #default="{ row }">{{ row.host }}:{{ row.port }}/{{ row.database }}</template>
      </el-table-column>
      <el-table-column prop="username" label="用户名" min-width="120" />
      <el-table-column prop="ssl" label="SSL" width="90" />
      <el-table-column label="状态" width="80">
        <template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <el-button link type="primary" @click="test(row)">测试连接</el-button>
          <el-button link @click="edit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog :model-value="!!form" :title="form?.id ? '编辑数据源' : '新增数据源'" width="560px"
             :close-on-click-modal="!saving" :show-close="!saving" @close="form = undefined">
    <el-form v-if="form" label-width="90px" @submit.prevent="save">
      <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
      <el-form-item label="主机">
        <div style="display: flex; gap: 8px; width: 100%">
          <el-input v-model="form.host" placeholder="db.example.com" />
          <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width: 140px" />
        </div>
      </el-form-item>
      <el-form-item label="数据库"><el-input v-model="form.database" /></el-form-item>
      <el-form-item label="用户名"><el-input v-model="form.username" autocomplete="off" /></el-form-item>
      <el-form-item label="密码">
        <el-input v-model="form.password" type="password" show-password autocomplete="new-password" :placeholder="form.id ? '留空则保持原密码' : ''" />
      </el-form-item>
      <el-form-item label="SSL">
        <el-radio-group v-model="form.ssl">
          <el-radio value="disable">不加密</el-radio>
          <el-radio value="require">加密</el-radio>
          <el-radio value="verify">加密并校验证书</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="form = undefined">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
