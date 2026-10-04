# Changelog

## v1.0.0 - 2026-09-28

首个正式版本。

### 功能
- 支持 PostgreSQL 数据源与参数化只读 SQL。
- 支持实时查询、定时同步快照和手工维护三种数据模式。
- 支持 GET / POST 开放接口、API Key、分页、过滤、超时和最大行数控制。
- 支持定时同步的独立时区、同步历史和失败保护。
- 支持快照/手工数据排序、跨页调整位置和逐条备注。
- 平台配置使用内嵌 SQLite，单进程、单数据卷部署。
- 提供 Docker / Docker Compose / Portainer 部署方式。

### 安全
- 数据源查询在 PostgreSQL READ ONLY 事务中执行。
- 数据源密码使用 AES-256-GCM 加密保存。
- 管理员密码使用 scrypt 哈希。
- API Key 仅保存 SHA-256 哈希。
- 提供登录限流、CSRF 防护、查询超时和并发限制。

### 说明
- 当前外部数据源仅支持 PostgreSQL。
- 当前仅支持单实例部署。
