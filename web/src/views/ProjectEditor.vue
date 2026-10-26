<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { request, type Project } from '../api'

const props = defineProps<{ project?: Project }>()
const emit = defineEmits<{ close: []; saved: [project: Project] }>()
const name = ref(props.project?.name ?? '')
const description = ref(props.project?.description ?? '')
const saving = ref(false)
async function save() {
  if (saving.value) return
  if (!name.value.trim()) return ElMessage.warning('请填写项目名称')
  saving.value = true
  try {
    const project = await request<Project>(props.project ? `/admin/projects/${props.project.id}` : '/admin/projects', {
      method: props.project ? 'PUT' : 'POST', body: { name: name.value.trim(), description: description.value.trim(), version: props.project?.version },
    })
    ElMessage.success(props.project ? '项目已更新' : '项目已创建')
    emit('saved', project)
  } finally { saving.value = false }
}
</script>

<template>
  <el-dialog :model-value="true" :title="project ? '编辑项目' : '新建项目'" width="480px" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving" @close="emit('close')">
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="项目名称" required><el-input v-model="name" maxlength="100" placeholder="如：通讯录 skill、订单审批" autofocus /></el-form-item>
      <el-form-item label="项目说明"><el-input v-model="description" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="说明这个项目用于哪个 skill 或业务功能" /></el-form-item>
    </el-form>
    <template #footer><el-button :disabled="saving" @click="emit('close')">取消</el-button><el-button type="primary" :loading="saving" @click="save">{{ project ? '保存项目' : '创建项目' }}</el-button></template>
  </el-dialog>
</template>
