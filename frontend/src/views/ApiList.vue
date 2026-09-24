<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { request } from '../api'
import ApiEdit from './ApiEdit.vue'
const rows=ref<any[]>([])
const editing=ref<any|undefined>(undefined)
const showEdit=ref(false)
async function load() { rows.value=await request('/admin/apis') }
onMounted(load)
function edit(row?:any) { editing.value=row;showEdit.value=true }
async function toggle(row:any) { await request(`/admin/apis/${row.id}/${row.enabled?'disable':'enable'}`,'POST'); await load() }
async function sync(row:any) { const result=await request(`/admin/apis/${row.id}/sync`,'POST'); ElMessage.success(`同步完成，${result.count} 行`); await load() }
async function remove(row:any) { await ElMessageBox.confirm(`删除 API「${row.name}」及其本地数据？`,'确认删除',{type:'warning'}); await request(`/admin/apis/${row.id}`,'DELETE'); await load() }
</script>
<template>
  <ApiEdit v-if="showEdit" :api="editing" @saved="load();showEdit=false" @close="showEdit=false"/>
  <template v-else><div class="page-head"><div><h2>API 管理</h2><p>通过配置发布实时、快照或手工数据接口</p></div><el-button type="primary" @click="edit()">新增 API</el-button></div>
    <el-card shadow="never"><el-table :data="rows" stripe><el-table-column prop="name" label="名称" min-width="135"/><el-table-column prop="code" label="编码" min-width="130"/><el-table-column prop="path" label="路径" min-width="180"/>
      <el-table-column label="模式" width="125"><template #default="scope"><el-tag :type="scope.row.dataMode==='REALTIME'?'primary':scope.row.dataMode==='SNAPSHOT'?'warning':'success'">{{ scope.row.dataMode }}</el-tag></template></el-table-column>
      <el-table-column label="访问方式" width="125"><template #default="scope"><el-tag :type="scope.row.authMode==='PUBLIC'?'info':'warning'">{{ scope.row.authMode==='PUBLIC'?'公开':'API Key' }}</el-tag></template></el-table-column>
      <el-table-column label="状态" width="80"><template #default="scope"><el-tag :type="scope.row.enabled?'success':'info'">{{ scope.row.enabled?'启用':'停用' }}</el-tag></template></el-table-column>
      <el-table-column prop="lastSyncStatus" label="同步状态" width="100"/><el-table-column label="操作" width="260"><template #default="scope"><el-button link type="primary" @click="edit(scope.row)">编辑</el-button><el-button link @click="toggle(scope.row)">{{scope.row.enabled?'停用':'启用'}}</el-button><el-button v-if="scope.row.dataMode==='SNAPSHOT'" link @click="sync(scope.row)">立即同步</el-button><el-button link type="danger" @click="remove(scope.row)">删除</el-button></template></el-table-column></el-table></el-card>
  </template>
</template>
