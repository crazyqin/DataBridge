<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { request } from '../api'
const rows = ref<any[]>([])
const dialog = ref(false)
const form = ref<any>({})
const saving = ref(false)
async function load() { rows.value = await request('/admin/datasources') }
onMounted(load)
function edit(row?: any) { form.value = row ? { ...row, password: '' } : { name: '', dbType: 'POSTGRESQL', jdbcUrl: '', username: '', password: '', enabled: true }; dialog.value = true }
async function save() {
  saving.value = true
  try { await request(form.value.id ? `/admin/datasources/${form.value.id}` : '/admin/datasources', form.value.id ? 'PUT' : 'POST', form.value); dialog.value = false; ElMessage.success('已保存'); await load() }
  finally { saving.value = false }
}
async function test(row: any) { const result = await request(`/admin/datasources/${row.id}/test`, 'POST'); ElMessage.success(`${result.database} 连接成功，耗时 ${result.elapsedMs}ms`) }
async function remove(row: any) { await ElMessageBox.confirm(`删除数据源「${row.name}」？`, '确认删除', { type: 'warning' }); await request(`/admin/datasources/${row.id}`, 'DELETE'); await load() }
</script>
<template>
  <div class="page-head"><div><h2>数据源</h2><p>使用专用只读账号连接外部数据库</p></div><el-button type="primary" @click="edit()">新增数据源</el-button></div>
  <el-card shadow="never"><el-table :data="rows" stripe><el-table-column prop="name" label="名称" min-width="130"/><el-table-column prop="dbType" label="类型" width="130"/>
    <el-table-column prop="jdbcUrl" label="JDBC URL" min-width="260" show-overflow-tooltip/><el-table-column label="状态" width="90"><template #default="scope"><el-tag :type="scope.row.enabled ? 'success' : 'info'">{{ scope.row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
    <el-table-column label="操作" width="230"><template #default="scope"><el-button link type="primary" @click="test(scope.row)">测试连接</el-button><el-button link @click="edit(scope.row)">编辑</el-button><el-button link type="danger" @click="remove(scope.row)">删除</el-button></template></el-table-column></el-table></el-card>
  <el-dialog v-model="dialog" :title="form.id ? '编辑数据源' : '新增数据源'" width="620px"><el-form label-width="115px" @submit.prevent="save">
    <el-form-item label="名称"><el-input v-model="form.name"/></el-form-item><el-form-item label="数据库类型"><el-select v-model="form.dbType" style="width:100%"><el-option label="PostgreSQL" value="POSTGRESQL"/><el-option label="MySQL" value="MYSQL"/><el-option label="Oracle" value="ORACLE"/></el-select></el-form-item>
    <el-form-item label="JDBC URL"><el-input v-model="form.jdbcUrl" placeholder="jdbc:postgresql://host:5432/database"/></el-form-item><el-form-item label="Driver Class"><el-input :model-value="{POSTGRESQL:'org.postgresql.Driver',MYSQL:'com.mysql.cj.jdbc.Driver',ORACLE:'oracle.jdbc.OracleDriver'}[form.dbType as 'POSTGRESQL'|'MYSQL'|'ORACLE']" disabled/></el-form-item>
    <el-form-item label="用户名"><el-input v-model="form.username"/></el-form-item><el-form-item label="密码"><el-input v-model="form.password" type="password" show-password :placeholder="form.id ? '留空则保持原密码' : '请输入密码'"/></el-form-item><el-form-item label="启用"><el-switch v-model="form.enabled"/></el-form-item>
  </el-form><template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template></el-dialog>
</template>
