<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onMounted, reactive, ref } from 'vue'
import { request, type LogWindow } from './api'
import Apis from './views/Apis.vue'
import Keys from './views/Keys.vue'
import Logs from './views/Logs.vue'
import Rows from './views/Rows.vue'
import Connections from './views/Connections.vue'
import Overview from './views/Overview.vue'
import UiIcon from './components/UiIcon.vue'
import UserMenu from './components/UserMenu.vue'
import Exports from './views/Exports.vue'
import Directory from './views/Directory.vue'

const pages = { overview: '工作台', apis: '接口管理', rows: '数据维护', logs: '调用日志', connections: '连接', directory: '人员目录', keys: '调用密钥', exports: '完整导出' } as const
type Page = keyof typeof pages
const workspace = ['overview', 'apis', 'rows', 'logs'] as const
const settings = ['connections', 'directory', 'keys'] as const
const icons = { overview: 'overview', apis: 'apis', rows: 'rows', logs: 'logs', connections: 'connections', directory: 'user', keys: 'keys', exports: 'exports' } as const

const username = ref<string>()
const checking = ref(true)
const page = ref<Page>('overview')
const createApi = ref(false)
const failedWindow = ref<LogWindow>()
const showDatabases = ref(false)
function navigate(next: Page | 'sources') {
  createApi.value = false
  failedWindow.value = undefined
  showDatabases.value = next === 'sources'
  page.value = next === 'sources' ? 'connections' : next
}
function showFailures(window: LogWindow) { failedWindow.value = window; page.value = 'logs' }
function startApi() { createApi.value = true; page.value = 'apis' }
function userCommand(command: string) {
  if (command === 'password') password.open = true
  else if (command === 'exports') navigate('exports')
  else signOut()
}
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
      <template #header><div class="brand"><span class="brand-symbol"><UiIcon name="bridge" /></span><div>数桥 <small>DataBridge</small></div></div></template>
      <h1>欢迎回来</h1><p class="login-intro">统一连接数据与智能体服务</p><el-form @submit.prevent="signIn">
        <el-form-item><el-input v-model="login.username" aria-label="管理员账号" placeholder="管理员账号" autocomplete="username"><template #prefix><UiIcon name="user" /></template></el-input></el-form-item>
        <el-form-item><el-input v-model="login.password" aria-label="密码" type="password" show-password placeholder="密码" autocomplete="current-password"><template #prefix><UiIcon name="keys" /></template></el-input></el-form-item>
        <el-button type="primary" native-type="submit" :loading="login.busy" style="width: 100%">登录<UiIcon name="arrow" class="trailing-icon" /></el-button>
      </el-form>
    </el-card>
    <span class="login-caption">让数据与服务，轻松相连。</span>
  </div>

  <el-container v-else-if="username" class="layout">
    <el-aside width="200px" class="sidebar">
      <div class="sidebar-brand"><span class="brand-symbol"><UiIcon name="bridge" /></span><div>数桥 <small>DataBridge</small></div></div>
      <el-menu :default-active="page" @select="navigate($event as Page)">
        <el-menu-item v-for="key in workspace" :key="key" :index="key"><UiIcon :name="icons[key]" />{{ pages[key] }}</el-menu-item>
        <div class="menu-divider"></div>
        <el-menu-item v-for="key in settings" :key="key" :index="key"><UiIcon :name="icons[key]" />{{ pages[key] }}</el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <UserMenu :username="username" placement="top-start" @command="userCommand" />
        <span>v1.8.0</span>
      </div>
    </el-aside>
    <el-container>
      <el-header class="topbar">
        <el-select class="mobile-nav" :model-value="page" aria-label="导航" @update:model-value="navigate($event as Page)"><el-option v-for="key in [...workspace, ...settings]" :key="key" :value="key" :label="pages[key]" /></el-select>
        <UserMenu :username="username" placement="bottom-end" @command="userCommand" />
      </el-header>
      <el-main>
        <Overview v-if="page === 'overview'" @navigate="navigate" @create="startApi" @failures="showFailures" />
        <Connections v-else-if="page === 'connections'" :databases="showDatabases" />
        <Directory v-else-if="page === 'directory'" />
        <Apis v-else-if="page === 'apis'" :initial-create="createApi" />
        <Rows v-else-if="page === 'rows'" />
        <Logs v-else-if="page === 'logs'" :failed-window="failedWindow" />
        <Exports v-else-if="page === 'exports'" />
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
