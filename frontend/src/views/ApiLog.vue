<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { request } from '../api'
const apis=ref<any[]>([])
const rows=ref<any[]>([])
const filter=ref<{apiId?:number;success?:boolean;from?:string;to?:string}>({})
async function load() { const params=new URLSearchParams();Object.entries(filter.value).forEach(([key,value])=>{if(value!==undefined && value!=='')params.set(key,String(value))});rows.value=await request('/admin/logs'+(params.size?'?'+params.toString():'')) }
onMounted(async()=>{apis.value=await request('/admin/apis');await load()})
</script>
<template><div class="page-head"><div><h2>调用日志</h2><p>仅记录调用结果和错误摘要，不保存请求数据</p></div></div>
  <div class="toolbar"><el-select v-model="filter.apiId" clearable placeholder="全部 API" style="width:200px"><el-option v-for="api in apis" :key="api.id" :label="api.name" :value="api.id"/></el-select>
    <el-select v-model="filter.success" clearable placeholder="全部结果" style="width:150px"><el-option label="成功" :value="true"/><el-option label="失败" :value="false"/></el-select>
    <el-date-picker v-model="filter.from" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" placeholder="开始时间"/><el-date-picker v-model="filter.to" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" placeholder="结束时间"/><el-button type="primary" @click="load">查询</el-button></div>
  <el-card shadow="never"><el-table :data="rows" stripe><el-table-column prop="requestTime" label="请求时间" min-width="165"/><el-table-column prop="requestId" label="Request ID" min-width="250" show-overflow-tooltip/><el-table-column prop="apiId" label="API ID" width="85"/><el-table-column prop="dataSource" label="模式" width="120"/><el-table-column prop="elapsedMs" label="耗时 (ms)" width="110"/><el-table-column prop="rowCount" label="行数" width="80"/><el-table-column label="结果" width="80"><template #default="scope"><el-tag :type="scope.row.success?'success':'danger'">{{scope.row.success?'成功':'失败'}}</el-tag></template></el-table-column><el-table-column prop="errorMessage" label="错误" min-width="180" show-overflow-tooltip/></el-table></el-card>
</template>
