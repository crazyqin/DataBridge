<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { formatTimeInZone, request, type Api } from '../api'

interface SyncLog {
  id: number
  startedAt: string
  finishedAt: string | null
  trigger: 'MANUAL' | 'SCHEDULED'
  status: 'RUNNING' | 'SUCCESS' | 'FAILED'
  rowCount: number | null
  error: string | null
}

const props = defineProps<{ api: Api }>()
const emit = defineEmits<{ close: [] }>()
const items = ref<SyncLog[]>([])
const nextBefore = ref<number | null>(null)
const loading = ref(false)

async function load(more = false) {
  loading.value = true
  try {
    const query = more && nextBefore.value ? `?before=${nextBefore.value}` : ''
    const page = await request<{ items: SyncLog[]; nextBefore: number | null }>(`/admin/apis/${props.api.id}/sync-history${query}`)
    items.value = more ? [...items.value, ...page.items] : page.items
    nextBefore.value = page.nextBefore
  } finally {
    loading.value = false
  }
}

function elapsed(row: SyncLog): string {
  if (!row.finishedAt) return '—'
  return `${Math.max(0, new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime())} ms`
}

onMounted(() => load())
</script>

<template>
  <el-dialog :model-value="true" :title="`${api.name} · 同步详情`" width="900px" @close="emit('close')">
    <div class="toolbar"><el-button :loading="loading" @click="load()">刷新</el-button></div>
    <el-table v-loading="loading" :data="items" stripe max-height="520" empty-text="暂无同步记录">
      <el-table-column :label="`开始时间 (${api.cronTimezone})`" min-width="220">
        <template #default="{ row }">{{ formatTimeInZone(row.startedAt, api.cronTimezone!) }}</template>
      </el-table-column>
      <el-table-column label="触发方式" width="100"><template #default="{ row }">{{ row.trigger === 'SCHEDULED' ? '定时' : '手动' }}</template></el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'SUCCESS' ? 'success' : row.status === 'FAILED' ? 'danger' : 'info'">
            {{ row.status === 'SUCCESS' ? '成功' : row.status === 'FAILED' ? '失败' : '进行中' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="耗时" width="115"><template #default="{ row }">{{ elapsed(row) }}</template></el-table-column>
      <el-table-column label="行数" width="80"><template #default="{ row }">{{ row.rowCount ?? '—' }}</template></el-table-column>
      <el-table-column prop="error" label="错误详情" min-width="190" show-overflow-tooltip />
    </el-table>
    <div v-if="nextBefore" style="text-align: center; margin-top: 12px"><el-button :loading="loading" @click="load(true)">加载更多</el-button></div>
  </el-dialog>
</template>
