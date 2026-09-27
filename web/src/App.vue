<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onMounted, reactive, ref } from 'vue'
import { request } from './api'
import Apis from './views/Apis.vue'
import Keys from './views/Keys.vue'
import Logs from './views/Logs.vue'
import Rows from './views/Rows.vue'
import Sources from './views/Sources.vue'

const pages = { sources: '数据源', apis: 'API 管理', rows: '数据维护', logs: '调用日志', keys: 'API Key' } as const
type Page = keyof typeof pages

const username = ref<string>()
const checking = ref(true)
const page = ref<Page>('apis')
const login = reactive({ username: '', password: '', busy: false })
const password = reactive({ open: false, current: '', next: '', confirm: '', busy: false })

async function signIn() {
  login.busy = true
  try {
    const session = await request<{ username: string }>('/auth/login', { method: 'POST', body: { username: login.username, password: login.password } })
    username.value = session.username
    login.password = ''
  } finally {
    login.busy = false
  }
}

async function signOut() {
  await request('/auth/logout', { method: 'POST' })
  username.value = undefined
}

async function changePassword() {
  if (password.next.length < 12) return ElMessage.error('新密码至少 12 位')
  if (password.next !== password.confirm) return ElMessage.error('两次输入的新密码不一致')
  password.busy = true
  try {
    await request('/admin/password', { method: 'POST', body: { currentPassword: password.current, newPassword: password.next } })
    Object.assign(password, { open: false, current: '', next: '', confirm: '' })
    username.value = undefined
    ElMessage.success('密码已修改，请重新登录')
  } finally {
    password.busy = false
  }
}

onMounted(async () => {
  window.addEventListener('auth-expired', () => { username.value = undefined })
  try {
    username.value = (await request<{ username: string | null }>('/auth/session', { silent: true })).username ?? undefined
  } finally {
    checking.value = false
  }
})
</script>

<template>
  <div v-if="!username && !checking" class="login-wrap">
    <el-card class="login-card">
      <template #header><div class="brand">数桥 <span>DataBridge</span></div></template>
      <el-form @submit.prevent="signIn">
        <el-form-item><el-input v-model="login.username" placeholder="管理员账号" autocomplete="username" /></el-form-item>
        <el-form-item><el-input v-model="login.password" type="password" show-password placeholder="密码" autocomplete="current-password" /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="login.busy" style="width: 100%">登录</el-button>
      </el-form>
    </el-card>
  </div>

  <el-container v-else-if="username" class="layout">
    <el-aside width="200px" class="sidebar">
      <div class="sidebar-brand">数桥 <small>DataBridge</small></div>
      <el-menu :default-active="page" background-color="#142235" text-color="#d7e0eb" active-text-color="#fff" @select="page = $event as Page">
        <el-menu-item v-for="(label, key) in pages" :key="key" :index="key">{{ label }}</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="topbar">
        <strong>{{ pages[page] }}</strong>
        <div class="topbar-actions">
          <span>{{ username }}</span>
          <el-button text @click="password.open = true">修改密码</el-button>
          <el-button text @click="signOut">退出</el-button>
        </div>
      </el-header>
      <el-main>
        <Sources v-if="page === 'sources'" />
        <Apis v-else-if="page === 'apis'" />
        <Rows v-else-if="page === 'rows'" />
        <Logs v-else-if="page === 'logs'" />
        <Keys v-else />
      </el-main>
    </el-container>
  </el-container>

  <el-dialog v-model="password.open" title="修改管理员密码" width="440px" :close-on-click-modal="!password.busy">
    <el-form label-width="96px" @submit.prevent="changePassword">
      <el-form-item label="当前密码"><el-input v-model="password.current" type="password" show-password autocomplete="current-password" /></el-form-item>
      <el-form-item label="新密码"><el-input v-model="password.next" type="password" show-password autocomplete="new-password" placeholder="至少 12 位" /></el-form-item>
      <el-form-item label="确认新密码"><el-input v-model="password.confirm" type="password" show-password autocomplete="new-password" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="password.busy" @click="password.open = false">取消</el-button>
      <el-button type="primary" :loading="password.busy" @click="changePassword">保存</el-button>
    </template>
  </el-dialog>
</template>
