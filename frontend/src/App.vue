<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { request, signIn, signOut } from './api'
import DatasourceList from './views/DatasourceList.vue'
import ApiList from './views/ApiList.vue'
import DataMaintain from './views/DataMaintain.vue'
import ApiLog from './views/ApiLog.vue'
const signedIn = ref(false)
const loading = ref(false)
const credentials = ref({ username: '', password: '' })
const username = ref('')
const passwordDialog = ref(false)
const passwordForm = ref({ currentPassword: '', newPassword: '', confirmPassword: '' })
const tab = ref('datasources')
async function login() {
  loading.value = true
  try {
    await signIn(credentials.value.username, credentials.value.password)
    const session = await request<{ username: string }>('/admin/session')
    username.value = session.username
    credentials.value.password = ''
    signedIn.value = true
  }
  catch { signedIn.value = false }
  finally { loading.value = false }
}
async function logout() { await signOut(); signedIn.value = false; username.value = '' }
async function changePassword() {
  if (passwordForm.value.newPassword.length < 12) { ElMessage.error('新密码至少 12 位'); return }
  if (passwordForm.value.newPassword !== passwordForm.value.confirmPassword) { ElMessage.error('两次新密码不一致'); return }
  await request('/admin/password', 'POST', { currentPassword: passwordForm.value.currentPassword, newPassword: passwordForm.value.newPassword })
  passwordDialog.value = false
  passwordForm.value = { currentPassword: '', newPassword: '', confirmPassword: '' }
  ElMessage.success('密码已修改')
}
onMounted(async () => {
  window.addEventListener('auth-expired', () => signedIn.value = false)
  try { const session = await request<{ username: string }>('/admin/session', 'GET', undefined, true); username.value = session.username; signedIn.value = true }
  catch { signedIn.value = false }
})
</script>
<template>
  <div v-if="!signedIn" class="login-wrap">
    <el-card class="login-card"><template #header><div class="brand">数桥 <span>DataBridge</span></div></template>
      <p>轻量数据 API 服务平台</p>
      <el-form @submit.prevent="login"><el-form-item><el-input v-model="credentials.username" placeholder="管理员账号" /></el-form-item>
        <el-form-item><el-input v-model="credentials.password" type="password" show-password placeholder="密码" /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="loading" style="width:100%">登录</el-button></el-form>
    </el-card>
  </div>
  <el-container v-else class="layout">
    <el-aside width="220px" class="sidebar"><div class="sidebar-brand">数桥 <small>DataBridge</small></div>
      <el-menu :default-active="tab" @select="tab = $event" background-color="#142235" text-color="#d7e0eb" active-text-color="#fff">
        <el-menu-item index="datasources">数据源</el-menu-item><el-menu-item index="apis">API 管理</el-menu-item>
        <el-menu-item index="data">数据维护</el-menu-item><el-menu-item index="logs">调用日志</el-menu-item>
      </el-menu><el-button text class="logout" @click="logout">退出登录</el-button>
    </el-aside>
    <el-container><el-header class="topbar"><strong>{{ {datasources:'数据源',apis:'API 管理',data:'数据维护',logs:'调用日志'}[tab as 'datasources'|'apis'|'data'|'logs'] }}</strong><div class="topbar-actions"><span>{{ username }}</span><el-button text @click="passwordDialog=true">修改密码</el-button></div></el-header>
      <el-main><DatasourceList v-if="tab==='datasources'" /><ApiList v-else-if="tab==='apis'" /><DataMaintain v-else-if="tab==='data'" /><ApiLog v-else /></el-main>
    </el-container>
  </el-container>
  <el-dialog v-model="passwordDialog" title="修改管理员密码" width="450px" @closed="passwordForm={ currentPassword:'', newPassword:'', confirmPassword:'' }">
    <el-form label-width="105px" @submit.prevent="changePassword">
      <el-form-item label="当前密码"><el-input v-model="passwordForm.currentPassword" type="password" show-password autocomplete="current-password" /></el-form-item>
      <el-form-item label="新密码"><el-input v-model="passwordForm.newPassword" type="password" show-password autocomplete="new-password" placeholder="至少 12 位" /></el-form-item>
      <el-form-item label="确认新密码"><el-input v-model="passwordForm.confirmPassword" type="password" show-password autocomplete="new-password" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="passwordDialog=false">取消</el-button><el-button type="primary" @click="changePassword">保存新密码</el-button></template>
  </el-dialog>
</template>
