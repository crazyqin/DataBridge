# DataBridge 补充审查：df48814

日期：2026-09-25。范围：当前提交 `df48814`、上一轮构建的 `databridge:standalone-amd64`，以及前后端和部署脚本。

使用独立临时容器和数据库，完成 HTTP、受控并发、Chromium 浏览器测试及代码检查。以下列出本轮发现的 20 项可复现问题，以及 14 项具有明确代码或配置依据的条件性风险。未将条件性风险写成已经发生的故障，也不能据此证明项目已不存在其他缺陷。

## 可复现的问题

### B01 高：旧数据源编辑页面可以重新启用已停用的数据源

- 读取启用状态的数据源，另一个请求将其停用，开放查询返回 400；再用旧配置仅修改名称并保存，返回 200，`enabled` 恢复为 true，匿名查询重新返回 200。
- 数据源更新没有客户端版本检查；`poolLock` 只能串行执行请求，无法识别过期表单。
- 位置：`backend/src/main/java/com/databridge/DatasourceService.java:35`；`frontend/src/views/DatasourceList.vue:14`。
- 建议：数据源配置增加版本号，更新时比较客户端版本；不能仅依靠进程内锁。

### B02 中：切换数据源配置后，旧同步结果仍可写入快照

- 用 API 行锁暂停旧同步的写入阶段，将同一数据源从旧 schema 切换到新 schema，保存返回 200，再释放写入。
- 旧同步返回 200，开放快照输出 `old-source`；此时直接测试同一 API 的 SQL 已返回 `new-source`。
- 同步只核对 API 的 `configVersion`，数据源的 URL、账号等变化不属于该版本。
- 位置：`backend/src/main/java/com/databridge/ApiService.java:187`、`:195`；`DatasourceService.java:47`。
- 建议：同步捕获并核对数据源版本，或在数据源变更时使相关同步版本失效。

### B03 中：停用 API 后，定时任务仍可能再成功写入一次

- 暂停定时回调的启用状态读取，使其保留旧配置；停用接口返回 200 后释放回调。
- 实测 `enabled=false`，但 `last_sync_at` 从空变为新的成功时间，并写入了一行快照。
- 回调先检查启用状态，再调用 `sync(id)`；后者重新读取停用后的配置版本，并没有接收回调原有的版本。这里确认的是一次晚到的成功同步，不是持续重复同步。
- 位置：`backend/src/main/java/com/databridge/ApiService.java:165`、`:184`。
- 建议：定时执行携带预期配置版本，并在写入事务内再次检查启用状态和版本。

### B04 中：字段迁移修改了记录，却没有更新记录版本

- 将手工字段 `value` 从 string 改为 integer，再改回 string，数据从 `"001"` 变为 `"1"`，但 `rowVersion` 始终为 0。
- 使用迁移前记录，仅修改另一个字段并以版本 0 保存，返回 200，`value` 被恢复为 `"001"`。
- 位置：`backend/src/main/java/com/databridge/ApiService.java:135`、`:143`。
- 建议：迁移实际修改数据时递增 `row_version`；记录编辑同时考虑字段定义版本。

### B05 中：SQL 时间数组仍会丢失精度和时区

- `TIME '10:20:30.123456'` 的标量输出正确，放入 ARRAY 后输出 `"10:20:30"`。
- TIMETZ 数组把 `10:20:30.123456+08:00` 输出为 `02:20:30`；TIMESTAMPTZ 数组也失去 `Z` 偏移标记。
- 数组递归转换没有沿用元素的 JDBC 类型信息，使用的旧 JDBC 对象可能已经丢失精度。
- 位置：`backend/src/main/java/com/databridge/SqlService.java:190`、`:200`。
- 建议：按数组基类型读取和转换元素，保持标量与数组的时间约定一致。

### B06 中：带时区快照时间字段不能按 datetime 类型正确过滤

- 同步 TIMESTAMPTZ 后存储 `2026-09-25T02:00Z`。
- 字段定义为 datetime 时，传相同带时区值返回 400；传不带时区的对应值返回 200，但查不到记录。
- 标量输出使用 OffsetDateTime，过滤转换仅接受 LocalDateTime。
- 位置：`backend/src/main/java/com/databridge/SqlService.java:114`、`:194`；`ApiService.java:324`。
- 建议：明确支持带时区的字段类型及规范化规则，统一同步输出、请求解析和本地比较。

### B07 中：旧版 TIME、部分 TIMESTAMPTZ 唯一键的人工排序仍会丢失

- 按旧版本格式构造已有数据及 `[2,1]` 排序，升级后的同步返回成功，但结果变为 `[1,2]`，排序表记录数降为 0。
- 已复现两类：旧 TIME 丢失小数秒的格式；旧 TIMESTAMPTZ 使用无偏移、固定秒数的格式。
- 当前兼容逻辑只尝试有限的 timestamp 字符串形式。
- 位置：`backend/src/main/java/com/databridge/RowKeys.java:23`；`PlatformRepository.java:65`。
- 建议：按已发布版本的真实格式迁移，并处理一对多或歧义情况；继续避免按任意字符串内容猜类型。

### B08 中：数值相同的小数可绕过快照唯一键检查

- SQL 返回 `1.0::numeric` 和 `1.00::numeric`，配置该列为唯一键，同步仍返回 200 并保存两条记录。
- 行键分别基于 JSON `1.0` 和 `1.00` 计算，生成不同哈希。
- 位置：`backend/src/main/java/com/databridge/RowKeys.java:11`；`ApiService.java:192`。
- 建议：按字段类型规范化唯一键的数值表示，再判重和生成稳定行键。

### B09 中：本地过滤查询的异常日志仍泄露参数原文

- 向公开 MANUAL 接口提交允许过滤的字符串字段，值为测试标记加 `\u0000`。
- PostgreSQL JSONB 转换失败，返回 409；容器日志中出现标记原文及 JSON 片段。
- 外部 SQL 执行路径的脱敏没有覆盖平台查询异常。OpenController 写入异常 message，通用错误处理器再次写入完整异常。
- 位置：`backend/src/main/java/com/databridge/OpenController.java:41`；`ApiErrorHandler.java:29`；`PlatformRepository.java:83`。
- 建议：统一数据库异常脱敏，并将不可存储的字符作为明确输入错误处理。

### B10 中：页面测试 SQL 时仍会改写大整数参数

- Chromium 在测试参数框输入 `{"id":9007199254740993}`，实际 HTTP 请求发送 `9007199254740992`，后端返回 200。
- 同一路径也会损失高精度小数；本项影响 SQL 测试请求，不是此前已修复的手工记录数字编辑。
- 位置：`frontend/src/views/ApiEdit.vue:35`。
- 建议：使用无损解析，或根据参数定义要求精确数值以字符串输入并验证。

### B11 中：MySQL、Oracle 的合法字符串语法仍被拒绝

- MySQL SQL `SELECT 'it\'s' AS txt` 和 Oracle SQL `SELECT q'[it's]' AS txt FROM dual` 在配置保存时均返回 400 `SQL string is not closed`。
- 当前扫描器仅为 PostgreSQL 的 E 字符串实现反斜杠转义，没有按数据源方言处理字符串。
- MySQL 示例以未启用 NO_BACKSLASH_ESCAPES 为前提；Oracle q 引号为官方支持语法。这里验证的是应用配置校验，不是两种数据库的完整实库执行。
- 位置：`backend/src/main/java/com/databridge/SqlService.java:52`、`:60`。
- 依据：[MySQL 字符串文档](https://dev.mysql.com/doc/refman/8.0/en/string-literals.html)、[Oracle 字面量文档](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Literals.html)。
- 建议：让校验与参数扫描共享明确的数据源方言设置。

### B12 低：永远不会触发的 Cron 可以保存并显示启用

- `0 0 0 31 2 *` 保存成功且 enabled=true。
- 使用项目实际 Spring 依赖运行 CronExpression，下一次触发时间为 null；调度返回 null 时应用没有报错。
- 位置：`backend/src/main/java/com/databridge/ApiService.java:86`、`:169`。
- 建议：保存前验证下一次触发时间，并在页面展示时区和下次执行时间。

### B13 低：不存在的资源及不支持的方法被返回为 500

- `/admin/no_such_endpoint`、`/missing-asset.js` 均返回 500；向只允许 GET 的 `/admin/session` 发 POST 也返回 500。
- 通用异常处理没有保留框架原有的 404、405 语义。
- 位置：`backend/src/main/java/com/databridge/ApiErrorHandler.java:25`。
- 建议：明确处理资源不存在、请求方法和媒体类型异常，保留对应的 4xx。

### B14 低：输入结构、长度和布尔类型的校验仍不完整

- 单行快照的排序体为 `[null]` 时返回 500。
- 数据源名称为 101 个字符时返回 409 `data conflict`，而不是长度输入错误。
- 数据源请求传 `enabled:"false"` 时保存成功，实际值为 true。
- 位置：`backend/src/main/java/com/databridge/ApiService.java:246`；`DatasourceService.java:36`、`:38`；`ApiErrorHandler.java:30`。
- 建议：使用明确请求类型和字段校验，拒绝错误 JSON 类型及 null 集合元素。

### B15 低：部分明显无效的参数/过滤配置可以保存

- SQL 使用未声明的 `:missing`，API 保存成功，调用时才返回 400。
- MANUAL 的 filterFields 包含未在 manualSchema 定义的字段，配置仍保存成功。
- 位置：`backend/src/main/java/com/databridge/ApiService.java:70`、`:90`。
- 建议：保存时交叉校验 SQL 参数名、参数定义和手工过滤字段；SQL 输出列需结合测试结果验证。

### B16 低：编辑 SQL 后点击测试，执行的是已保存的旧 SQL

- 页面将 SQL 改成 `SELECT 99 AS changed` 后直接测试，仍执行原来的 `SELECT :id AS result`。
- 文档要求先保存，但编辑页没有提示当前测试忽略未保存内容，容易把旧查询结果当成新查询的验证结果。
- 位置：`frontend/src/views/ApiEdit.vue:38`；`backend/src/main/java/com/databridge/ApiService.java:174`。
- 建议：显示“测试已保存配置”或检测未保存修改；也可提供明确的草稿测试流程。

### B17 低：旧保存响应会关闭后来新开的编辑窗口

- 暂停第一条手工记录的 POST 请求，取消窗口，再新增并输入第二条记录。
- 释放第一条保存请求后，第二个窗口被关闭；仅第一条保存，第二条未保存内容丢失。
- 位置：`frontend/src/views/DataMaintain.vue:50`、`:53`、`:72`。
- 建议：提交期间限制窗口切换，或让响应只更新其对应的编辑会话。

### B18 低：快照页面无法正确显示 JSON 对象

- SQL JSONB 列包含 `{"nested":"expected-value"}`，浏览器单元格仅显示 `[object Object]`。
- 后端数据正确，此项为显示问题。
- 位置：`frontend/src/views/DataMaintain.vue:57`。
- 建议：对对象/数组使用 JSON 展示，并提供展开或复制能力。

### B19 低：某些合法字段名会在新增表单出现原生函数文本

- 定义 string 字段 `toString` 后，新增记录的输入框默认显示 `function toString() { [native code] }`。
- 空表单使用普通对象，动态属性读取拿到了 Object 原型成员。
- 位置：`frontend/src/views/DataMaintain.vue:45`、`:71`。
- 建议：按 schema 初始化自有字段，或使用没有原型的字典。

### B20 低：管理请求的错误 ID 与日志 ID 不一致

- 同一次 `/admin/not-found-request-id` 请求，响应 request_id 和应用记录的 request ID 是两个不同 UUID。
- 管理请求没有预先设置 ID，错误处理器每次调用 requestId() 都重新生成。
- 位置：`backend/src/main/java/com/databridge/ApiErrorHandler.java:29`、`:34`。
- 建议：在请求入口统一生成并缓存 ID，响应、应用日志和调用日志共用。

## 条件性风险及仍未补齐的能力

这些项目主要由代码和配置确认。需要结合实际代理、数据规模、网络故障及运维要求决定优先级；没有执行破坏性容量压测。

| 编号 | 风险及条件 | 位置/依据 |
| --- | --- | --- |
| R01 | 登录缺少失败次数限制；开放查询没有全局并发/速率配额，管理与开放请求共用 Web 线程资源。此前平台连接池占用修复不等于已隔离所有资源；大流量仍可能影响管理端。匿名获取 CSRF 令牌也会创建会话。 | SecurityConfig.java:37；OpenController.java:16；CsrfController.java:9 |
| R02 | 结果主要限制行数，缺少总字节、单个字段/数组和完整请求体的应用级预算。大 JSON、CLOB、BLOB 被完整读入内存；少量大行也可能耗尽内存。 | SqlService.java:141、:208、:216 |
| R03 | 调用日志没有保留/清理策略，匿名未知路径和鉴权失败也写库；后台固定最多 500 条，缺少完整分页。长期可能占满磁盘，较早日志难以检索。 | OpenController.java:46；PlatformRepository.java:97、:102 |
| R04 | 仅修改手工 API 名称也扫描并转换全部记录，且持有 API 行锁；部分数值 Java 类型差异还会产生不必要 UPDATE。手工新增计算 max(source_order)，数据量大时也需要扫描。 | ApiService.java:108、:135、:269 |
| R05 | 模式切换删除本地数据和排序、删除手工字段清除其旧值；编辑页没有破坏性影响确认、预览或恢复入口。 | ApiService.java:104；frontend/src/views/ApiEdit.vue:25 |
| R06 | 外部查询有语句超时，但没有统一连接网络读超时和端到端预算；调度仅两个线程，Cron 使用服务器默认时区。数据库无响应或较多慢同步时，其他任务可能延迟。API/数据源的锁映射在删除资源后也未回收。 | DatasourceService.java:72、:77；SqlService.java:135；DataBridgeApplication.java:24；ApiService.java:180 |
| R07 | HTTPS 代理部署需补充可信转发头和 Cookie 设置。独立容器收到 X-Forwarded-Proto:https 后仍签发无 Secure 的会话 Cookie，也没有 HSTS；是否对公网形成风险取决于真实代理的配置。 | application.yml:13；实测响应头 |
| R08 | 所有受保护接口共用一个 API Key，缺少按客户端撤销/过期及密钥轮换流程。已有数据卷的加密密钥文件丢失时脚本会生成新值继续启动，已有数据源密码随后无法解密。 | SecurityConfig.java:25；docker/standalone-entrypoint.sh:34 |
| R09 | 平台应用复用 PostgreSQL 初始化超级用户。独立镜像实测 rolsuper=true；Compose 同样复用 POSTGRES_USER。若应用或数据库操作路径被攻破，会扩大影响范围。 | docker/standalone-entrypoint.sh:50；docker-compose.yml:8、:29 |
| R10 | 镜像构建跳过后端测试、基础镜像使用浮动标签；未见仓库 CI 检查门禁、完整 Java/镜像漏洞扫描和 MySQL/Oracle 实库测试。本次没有据此宣称存在某个具体 CVE。 | Dockerfile:1、:8、:13；Dockerfile.standalone；backend/src/test |
| R11 | 仓库未提供经过验证的完整备份恢复流程；必须同时保存数据库与原加密密钥。应用容器没有健康检查，单镜像进程存活不等于 HTTP、数据库及调度均正常。 | README.md；Dockerfile；Dockerfile.standalone；docker-compose.yml |
| R12 | 当前调用日志不覆盖管理配置、手工编辑、登录失败等安全审计事件；定时回调部分异常被忽略。PostgreSQL 设置 log_min_messages=fatal，普通数据库 ERROR/WARNING 也不可见，降低排障能力。 | AdminController.java；ApiService.java:167；docker-compose.yml:4；docker/standalone-entrypoint.sh:71 |
| R13 | 版本保护只覆盖部分写入：记录删除、排序、API 启停未要求客户端版本。实测版本 0 的页面所持有的删除目标，在记录被更新到版本 1 后仍可被直接删除。若业务要求阻止所有陈旧操作，需要补齐；否则应明确这些操作允许覆盖当前状态。 | ApiService.java:150、:239、:285；AdminController.java |
| R14 | 本地 JSONB 过滤缺少相应索引和独立查询超时；管理快照仍一次拉取全部行。分页 count 和数据查询也不在同一一致性快照内。大量记录或并发写入时可能导致查询慢、前端卡顿或 total/items 暂时不一致。 | PlatformRepository.java:80、:91；ApiService.java:211；OpenQueryService.java:22；frontend/src/views/DataMaintain.vue:32 |

单实例调度限制在 README 中已有明确说明，多副本重复调度属于现有部署边界，未计为本轮新缺陷。

## 验证边界与交付状态

- 并发复现通过临时数据库行锁、单次暂停点控制时序；浏览器验证使用实际构建后的页面。
- “只修改其他字段会损坏 datetime 小数秒”的猜测在本轮浏览器测试中未复现，未列为问题。
- MySQL/Oracle 仅验证了应用拒绝官方合法字符串语法；时间、LOB、网络故障、事务只读语义仍需实库测试。
- 未执行 OOM、磁盘耗尽等破坏性压测，未把资源风险描述成已发生的故障。
- 本轮只增加审查报告。临时容器及其临时卷在验证结束后删除。
- 当前业务提交仍为 df48814；上一轮 HTTPS 推送因凭据缺失未完成。现有 databridge_app_1 使用旧镜像；本轮没有替换运行部署。

建议先处理 B01，以及 B02/B03/B04/B09 这些仍存在于并发边界和日志路径的缺口；随后统一时间、唯一键和无损数值的表示规则。
