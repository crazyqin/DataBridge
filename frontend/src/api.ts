import { ElMessage } from 'element-plus'

export async function signIn(username: string, password: string) {
  const response = await fetch('/auth/login', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  })
  if (!response.ok) { ElMessage.error('账号或密码错误'); throw new Error('login failed') }
}

export async function signOut() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
}

export async function request<T = any>(path: string, method = 'GET', body?: unknown, silent = false): Promise<T> {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401) window.dispatchEvent(new Event('auth-expired'))
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const message = error.message || `请求失败 (${response.status})`
    if (!silent) ElMessage.error(message)
    throw new Error(message)
  }
  return response.status === 204 ? undefined as T : response.json()
}
