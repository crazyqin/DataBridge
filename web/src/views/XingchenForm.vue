<script setup lang="ts">
import { computed } from 'vue'
import type { ExternalAuthConfig, Field, XingchenConfig } from '../api'
const props = defineProps<{ params: Field[]; bindings: ExternalAuthConfig['bindings'] }>()
const config = defineModel<XingchenConfig>({ required: true })
const strings = computed(() => props.params.filter(param => param.type === 'string'))
</script>

<template>
  <el-divider content-position="left">星辰平台连接</el-divider>
  <el-alert type="info" :closable="false" show-icon title="先验证调用者身份，再加密工号并转发。平台凭据由管理员配置，加密保存。" />
  <el-form-item label="基础地址" style="margin-top: 18px">
    <el-input v-model="config.baseUrl" placeholder="https://agent.example.com/v1" autocomplete="off" />
    <span class="muted">填写平台文档中的基础 URL（包含 /v1）；系统自动追加 /chat-messages/{app_id}。</span>
  </el-form-item>
  <el-form-item label="app_id"><el-input v-model="config.appId" placeholder="应用 ID" autocomplete="off" /></el-form-item>
  <el-form-item label="api_key"><el-input v-model="config.apiKey" type="password" show-password autocomplete="off" placeholder="应用 API Key" /></el-form-item>
  <el-form-item label="public_key">
    <el-input v-model="config.publicKey" type="textarea" :rows="3" placeholder="04 开头的 130 位十六进制 SM2 公钥" />
  </el-form-item>
  <el-form-item label="工号身份参数">
    <el-select v-model="config.staffCodeBinding" placeholder="选择已验证的工号">
      <el-option v-for="binding in bindings.filter(item => item.type === 'string')" :key="binding.name" :value="binding.name" :label="binding.name" />
    </el-select>
    <span class="muted">来自上方身份映射，类型用 string 保留前导零。每次请求自动加密为 Znt-Staff-Code。</span>
  </el-form-item>
  <el-divider content-position="left">智能体入参</el-divider>
  <el-form-item label="变量映射">
    <div style="width: 100%">
      <el-table :data="config.inputMappings" size="small" empty-text="未配置工作流变量">
        <el-table-column label="调用者请求参数">
          <template #default="{ row }"><el-select v-model="row.parameter"><el-option v-for="param in params" :key="param.name" :value="param.name" /></el-select></template>
        </el-table-column>
        <el-table-column label="智能体变量（input_data 内）">
          <template #default="{ row }"><el-input v-model="row.variable" placeholder="q" /></template>
        </el-table-column>
        <el-table-column width="65"><template #default="{ $index }"><el-button link type="danger" @click="config.inputMappings.splice($index, 1)">删除</el-button></template></el-table-column>
      </el-table>
      <el-button text type="primary" @click="config.inputMappings.push({ parameter: '', variable: '' })">+ 添加映射</el-button>
      <div class="muted">OA 通讯录查询：请求参数 q → 智能体变量 q，即 input_data.q。新增请求参数可在下方声明。</div>
    </div>
  </el-form-item>
  <el-form-item label="提问 query">
    <el-select v-model="config.queryParam" clearable placeholder="可选，选择提问参数"><el-option v-for="param in strings" :key="param.name" :value="param.name" /></el-select>
    <span class="muted">通常也选 q，同时填入顶层 query。</span>
  </el-form-item>
  <el-form-item label="会话 ID 参数">
    <el-select v-model="config.conversationParam" clearable placeholder="可选，用于多轮对话"><el-option v-for="param in strings" :key="param.name" :value="param.name" /></el-select>
    <span class="muted">首次调用可不传；后续传回平台返回的 conversation_id。</span>
  </el-form-item>
  <el-form-item label="响应方式">
    <el-radio-group v-model="config.responseMode"><el-radio value="blocking">完整 JSON</el-radio><el-radio value="streaming">SSE 流式</el-radio></el-radio-group>
    <span class="muted">保留平台响应格式。JSON 的 answer 可能是 JSON 字符串；SSE 调用方需处理 message、message_end 和 error 事件。</span>
  </el-form-item>
</template>
