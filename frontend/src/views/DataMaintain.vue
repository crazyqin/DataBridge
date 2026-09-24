<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { request } from '../api'
const apis=ref<any[]>([])
const apiId=ref<number|undefined>()
const api=computed(() => apis.value.find(a=>a.id===apiId.value))
const rows=ref<any[]>([])
const dialog=ref(false)
const editKey=ref<string|undefined>()
const form=ref<any>({})
const dragging=ref<number|undefined>()
async function loadApis() { apis.value=(await request<any[]>('/admin/apis')).filter(a=>a.dataMode!=='REALTIME'); if(!apiId.value && apis.value.length) apiId.value=apis.value[0].id; await loadRows() }
async function loadRows() { rows.value=apiId.value ? await request(`/admin/apis/${apiId.value}/rows`) : [] }
onMounted(loadApis)
function beginDrag(index:number) { dragging.value=index }
function drop(index:number) { if(dragging.value===undefined)return; const [item]=rows.value.splice(dragging.value,1);rows.value.splice(index,0,item);dragging.value=undefined }
async function saveSort() { await request(`/admin/apis/${apiId.value}/sort`,'PUT',rows.value.map((row,index)=>({rowKey:row.rowKey,sortNo:index+1})));ElMessage.success('排序已保存');await loadRows() }
async function resetSort() { await request(`/admin/apis/${apiId.value}/sort`,'DELETE');ElMessage.success('已恢复默认排序');await loadRows() }
async function sync() { const result=await request(`/admin/apis/${apiId.value}/sync`,'POST');ElMessage.success(`同步完成，${result.count} 行`);await loadApis() }
function edit(row?:any) { editKey.value=row?.rowKey;form.value=row?{...row.dataJson}:{};dialog.value=true }
async function saveManual() { await request(editKey.value?`/admin/apis/${apiId.value}/rows/${editKey.value}`:`/admin/apis/${apiId.value}/rows`,editKey.value?'PUT':'POST',form.value);dialog.value=false;ElMessage.success('已保存');await loadRows() }
async function remove(row:any) { await ElMessageBox.confirm('删除这条手工数据？','确认删除',{type:'warning'});await request(`/admin/apis/${apiId.value}/rows/${row.rowKey}`,'DELETE');await loadRows() }
function format(value:any) { return value===null || value===undefined?'':String(value) }
</script>
<template>
  <div class="page-head"><div><h2>数据维护</h2><p>快照数据仅可调整顺序；手工数据可以增删改</p></div><div><el-button v-if="api?.dataMode==='SNAPSHOT'" @click="sync">立即同步</el-button><el-button v-if="api?.dataMode==='MANUAL'" type="primary" @click="edit()">新增数据</el-button></div></div>
  <div class="toolbar"><el-select v-model="apiId" placeholder="选择 API" style="width:300px" @change="loadRows"><el-option v-for="item in apis" :key="item.id" :label="`${item.name} (${item.dataMode})`" :value="item.id"/></el-select><span v-if="api" style="color:#8997a8">共 {{rows.length}} 条 <template v-if="api.dataMode==='SNAPSHOT'">· 上次同步 {{api.lastSyncAt||'尚未同步'}}</template></span></div>
  <el-card shadow="never"><el-empty v-if="!api" description="请先创建 SNAPSHOT 或 MANUAL API"/>
    <template v-else><div v-if="api.dataMode==='SNAPSHOT'" class="toolbar"><el-button type="primary" @click="saveSort">保存排序</el-button><el-button @click="resetSort">恢复默认排序</el-button><span style="color:#8997a8">拖动左侧符号调整顺序</span></div>
      <el-table :data="rows" stripe row-key="rowKey"><el-table-column v-if="api.dataMode==='SNAPSHOT'" label="拖动" width="65"><template #default="scope"><span class="row-drag" draggable="true" @dragstart="beginDrag(scope.$index)" @dragover.prevent @drop.prevent="drop(scope.$index)">☰</span></template></el-table-column>
        <el-table-column v-for="field in (api.dataMode==='MANUAL'?api.manualSchema:Object.keys(rows[0]?.dataJson||{}).map(name=>({name})))" :key="field.name" :label="field.name" min-width="120"><template #default="scope">{{format(scope.row.dataJson?.[field.name])}}</template></el-table-column>
        <el-table-column v-if="api.dataMode==='MANUAL'" label="操作" width="150"><template #default="scope"><el-button link type="primary" @click="edit(scope.row)">修改</el-button><el-button link type="danger" @click="remove(scope.row)">删除</el-button></template></el-table-column></el-table>
    </template></el-card>
  <el-dialog v-model="dialog" :title="editKey?'修改数据':'新增数据'" width="550px"><el-form v-if="api" label-width="120px" @submit.prevent="saveManual"><el-form-item v-for="field in api.manualSchema" :key="field.name" :label="field.name" :required="field.required">
    <el-switch v-if="field.type==='boolean'" v-model="form[field.name]"/><el-input-number v-else-if="field.type==='integer'||field.type==='decimal'" v-model="form[field.name]" style="width:100%"/><el-date-picker v-else-if="field.type==='date'||field.type==='datetime'" v-model="form[field.name]" :type="field.type==='date'?'date':'datetime'" :value-format="field.type==='date'?'YYYY-MM-DD':'YYYY-MM-DDTHH:mm:ss'" style="width:100%"/><el-input v-else v-model="form[field.name]"/>
  </el-form-item></el-form><template #footer><el-button @click="dialog=false">取消</el-button><el-button type="primary" @click="saveManual">保存</el-button></template></el-dialog>
</template>
