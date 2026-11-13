<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { request, type AccessPolicy, type AccessRule, type AccessDecision, type StaffMember, type ExternalAuthConfig } from '../api'
const policy = defineModel<AccessPolicy>({ required: true })
const props = defineProps<{ bindings?: ExternalAuthConfig['bindings']; fixedBinding?: string }>()
const options = ref<{ departments: (string | null)[][]; employmentUnified: string[]; employmentLocal: string[]; posts: string[] }>({ departments: [], employmentUnified: [], employmentLocal: [], posts: [] })
const members = ref<StaffMember[]>([])
const searchBusy = ref(false)
const previewStaff = ref('')
const decision = ref<AccessDecision>()
const previewBusy = ref(false)
const fields = [{ key: 'employmentUnified', label: '用工方式 · 统一工号' }, { key: 'employmentLocal', label: '用工方式 · 本地' }, { key: 'posts', label: '岗位（任一命中）' }] as const
const groups = [{ key: 'allow', label: '允许规则' }, { key: 'deny', label: '拒绝规则（优先）' }] as const
const emptyRule = (): AccessRule => ({ staffNos: [], departments: [], employmentUnified: [], employmentLocal: [], posts: [] })
watch(() => props.fixedBinding, value => { if (value !== undefined) policy.value.staffBinding = value }, { immediate: true })
watch(policy, () => { decision.value = undefined }, { deep: true })
watch(previewStaff, () => { decision.value = undefined })
let sequence = 0
async function search(query: string) {
  const current = ++sequence; searchBusy.value = true
  try { const result = await request<{ items: StaffMember[] }>(`/admin/directory/members?search=${encodeURIComponent(query)}`); if (current === sequence) members.value = result.items }
  finally { if (current === sequence) searchBusy.value = false }
}
type DepartmentNode = { value: string; label: string; children: DepartmentNode[] }
const tree = computed(() => {
  const nodes = new Map<string, DepartmentNode>(), roots: DepartmentNode[] = []
  for (const path of [...options.value.departments].sort((a, b) => a.length - b.length)) {
    const key = JSON.stringify(path), node = { value: key, label: path.filter(Boolean).join(' / '), children: [] }
    nodes.set(key, node)
    let parent = path.slice(0, -1)
    while (parent.length && !parent.at(-1)) parent = parent.slice(0, -1)
    const ancestor = nodes.get(JSON.stringify(parent))
    if (ancestor) ancestor.children.push(node); else roots.push(node)
  }
  return roots
})
function setDepartments(rule: AccessRule, values: string[]) {
  rule.departments = values.map(value => rule.departments.find(scope => JSON.stringify(scope.path) === value) ?? { path: JSON.parse(value), descendants: true })
}
async function preview() {
  previewBusy.value = true
  try { decision.value = await request('/admin/access/preview', { method: 'POST', body: { policy: policy.value, staffNo: previewStaff.value } }) }
  finally { previewBusy.value = false }
}
onMounted(async () => { await Promise.all([request<typeof options.value>('/admin/directory/options').then(value => { options.value = value }), search('')]) })
</script>

<template>
  <div class="access-policy">
    <el-form-item label="开启人员授权"><el-switch v-model="policy.enabled" /><span class="field-help">{{ policy.enabled ? '未命中允许规则时拒绝调用' : '未开启：身份验证通过即可调用' }}</span></el-form-item>
    <template v-if="policy.enabled">
      <el-form-item v-if="fixedBinding === undefined" label="授权使用的工号映射" required><el-select v-model="policy.staffBinding" placeholder="选择身份服务返回的工号"><el-option v-for="binding in (bindings ?? []).filter(item => item.type === 'string')" :key="binding.name" :value="binding.name" :label="`${binding.name} ← ${binding.path}`" /></el-select></el-form-item>
      <p class="muted">每组内所有条件同时满足，组间任一满足。同一条件多选为任一命中；拒绝规则优先。人员必须存在于当前目录。</p>
      <section v-for="group in groups" :key="group.key" class="policy-group">
        <div class="section-heading"><h3>{{ group.label }}</h3><el-button @click="policy[group.key].push(emptyRule())">添加规则</el-button></div>
        <p v-if="!policy[group.key].length" class="muted">{{ group.key === 'allow' ? '尚无允许规则，开启授权后所有人均无法调用。' : '未配置拒绝规则。' }}</p>
        <div v-for="(rule, index) in policy[group.key]" :key="index" class="policy-rule">
          <div class="section-heading"><strong>规则 {{ index + 1 }}</strong><el-button type="danger" text @click="policy[group.key].splice(index, 1)">删除规则</el-button></div>
          <el-form-item label="指定人员"><el-select v-model="rule.staffNos" multiple filterable remote :remote-method="search" :loading="searchBusy" placeholder="搜索工号或姓名；留空不限人员"><el-option v-for="person in members" :key="person.staffNo" :value="person.staffNo" :label="`${person.name}（${person.staffNo}）`" /></el-select></el-form-item>
          <el-form-item label="部门"><el-tree-select :model-value="rule.departments.map(scope => JSON.stringify(scope.path))" :data="tree" multiple filterable check-strictly show-checkbox placeholder="选择部门；留空不限部门" @update:model-value="setDepartments(rule, $event)" /></el-form-item>
          <div v-for="scope in rule.departments" :key="JSON.stringify(scope.path)" class="department-scope"><span>{{ scope.path.filter(Boolean).join(' / ') }}</span><el-checkbox v-model="scope.descendants">包含下级</el-checkbox><el-tag v-if="!options.departments.some(path => JSON.stringify(path) === JSON.stringify(scope.path))" type="warning">目录中已不存在</el-tag></div>
          <el-form-item v-for="field in fields" :key="field.key" :label="field.label"><el-select v-model="rule[field.key]" multiple filterable placeholder="请选择；留空不限"><el-option v-for="value in [...new Set([...options[field.key], ...rule[field.key]])]" :key="value" :value="value" :label="options[field.key].includes(value) ? value : `${value}（目录中已不存在）`" /></el-select></el-form-item>
        </div>
      </section>
    </template>
    <div class="toolbar"><el-select v-model="previewStaff" aria-label="选择人员预览权限" filterable remote :remote-method="search" :loading="searchBusy" placeholder="选择人员预览权限"><el-option v-for="person in members" :key="person.staffNo" :value="person.staffNo" :label="`${person.name}（${person.staffNo}）`" /></el-select><el-button :disabled="!previewStaff" :loading="previewBusy" @click="preview">预览权限</el-button></div>
    <el-alert v-if="decision" :type="decision.allowed ? 'success' : 'warning'" :title="`${decision.allowed ? '允许' : '拒绝'}：${decision.reason}${decision.rule ? ' · ' + decision.rule : ''} · 目录版本 ${decision.directoryVersion}`" :closable="false" />
  </div>
</template>

<style scoped>
.policy-group { margin: 20px 0; }
.policy-rule { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 16px; margin: 12px 0; }
.access-policy :deep(.el-select), .access-policy :deep(.el-tree-select) { width: 100%; }
.department-scope { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 0 0 12px; }
.toolbar :deep(.el-select) { max-width: 360px; }
</style>
