<script setup lang="ts">
import { FIELD_TYPES, type Field } from '../api'

defineProps<{ addLabel?: string }>()
const fields = defineModel<Field[]>({ required: true })
</script>

<template>
  <div style="width: 100%">
    <el-table :data="fields" size="small" empty-text="暂无字段">
      <el-table-column label="字段名">
        <template #default="{ row }"><el-input v-model="row.name" /></template>
      </el-table-column>
      <el-table-column label="类型" width="150">
        <template #default="{ row }">
          <el-select v-model="row.type"><el-option v-for="type in FIELD_TYPES" :key="type" :value="type" :label="type" /></el-select>
        </template>
      </el-table-column>
      <el-table-column label="必填" width="70">
        <template #default="{ row }"><el-switch v-model="row.required" /></template>
      </el-table-column>
      <el-table-column width="70">
        <template #default="{ $index }"><el-button link type="danger" @click="fields.splice($index, 1)">删除</el-button></template>
      </el-table-column>
    </el-table>
    <el-button text type="primary" @click="fields.push({ name: '', type: 'string', required: false })">+ {{ addLabel ?? '添加字段' }}</el-button>
  </div>
</template>
