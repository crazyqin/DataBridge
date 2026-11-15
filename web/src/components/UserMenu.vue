<script setup lang="ts">
import UiIcon from './UiIcon.vue'
defineProps<{ username: string; placement: 'top-start' | 'bottom-end' }>()
const emit = defineEmits<{ command: [command: 'password' | 'exports' | 'logout'] }>()
</script>

<template>
  <el-dropdown trigger="click" :placement="placement" @command="emit('command', $event)">
    <button type="button" class="user-chip"><span class="user-avatar">{{ username.slice(0, 1).toUpperCase() }}</span>{{ username }}<UiIcon name="chevron" class="user-caret" /></button>
    <template #dropdown><el-dropdown-menu>
      <el-dropdown-item command="password">修改密码</el-dropdown-item>
      <el-dropdown-item command="exports">完整导出</el-dropdown-item>
      <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
    </el-dropdown-menu></template>
  </el-dropdown>
</template>
