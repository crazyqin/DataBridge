<script setup lang="ts">
import { computed } from 'vue'
const value = defineModel<unknown>({ required: true })
const kind = computed({
  get: () => value.value === null ? 'null' : typeof value.value,
  set: type => { value.value = type === 'boolean' ? true : type === 'number' ? 0 : type === 'null' ? null : '' },
})
</script>
<template>
  <div class="scalar-value">
    <el-select v-model="kind" aria-label="值类型" style="width: 100px; flex-shrink: 0">
      <el-option value="string" label="文本" /><el-option value="number" label="数字" />
      <el-option value="boolean" label="布尔" /><el-option value="null" label="空值" />
    </el-select>
    <el-select v-if="kind === 'boolean'" :model-value="value as boolean" @update:model-value="value = $event">
      <el-option :value="true" label="true" /><el-option :value="false" label="false" />
    </el-select>
    <el-input-number v-else-if="kind === 'number'" :model-value="value as number" :controls="false" @update:model-value="value = $event ?? 0" />
    <el-input v-else-if="kind === 'string'" :model-value="value as string" placeholder="直接输入文本，无需引号" @update:model-value="value = $event" />
    <span v-else>null</span>
  </div>
</template>
