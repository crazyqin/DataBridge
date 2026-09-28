# 数桥 DataBridge

轻量的数据 API 平台。配置 PostgreSQL 数据源和一条 `SELECT`，或者直接在页面上维护数据，就能以 `/open/**` 发布 GET / POST 接口。

- **一个进程、一个数据卷**：Node.js 运行服务，平台数据存在内嵌的 SQLite，不需要额外数据库。
- **三种数据模式**：实时查询、定时同步快照、手工维护。
- **数据不失真**：大整数、`numeric` 精度、时间的小数秒和时区都原样输出。

## 部署

### Docker Compose

```bash
docker compose up -d --build
```

访问 `http://localhost:8080`。端口被占用时可用 `APP_PORT=18080 docker compose up -d --build`。

### Portainer / 离线部署

在能联网的机器上构建并导出镜像：

```bash
docker build --platform linux/amd64 -t databridge:1.0.0 .
mkdir -p release
docker save databridge:1.0.0 | gzip > release/databridge-1.0.0-amd64.tar.gz
```

在 Portainer 的 **Images → Import** 中上传压缩包；也可以在目标机器执行 `gzip -dc release/databridge-1.0.0-amd64.tar.gz | docker load`。镜像归档保存在本地 `release/`，不会提交到 Git。导入后在 **Containers → Add container** 中填写：

| 项目 | 值 |
| --- | --- |
| Image | `databridge:1.0.0` |
| Port | 宿主机 `8080` → 容器 `8080` |
| Volume | 命名卷（如 `databridge_data`）挂载到 `/data` |
| Env | `TZ=Asia/Shanghai` |
| Restart policy | `Unless stopped` |

更新已有容器时继续挂载原来的 `/data` 卷。服务启动时会自动升级 SQLite 表结构；更新前可按下文的「备份与恢复」步骤备份数据卷。

### 首次登录

账号是 `admin`。首次启动时会生成随机密码，在容器控制台执行：

```bash
cat /data/initial-admin-password
```

登录后在右上角修改密码，修改后这个文件会自动删除。也可以在首次启动前设置 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 环境变量来指定初始账号。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TZ` | 系统时区 | 新建 API 未指定同步时区时的默认值，也是数据源会话的时区 |
| `PORT` | `8080` | 监听端口 |
| `DATA_DIR` | `./data`（镜像内为 `/data`） | SQLite 数据库、密钥和初始密码所在目录 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / 随机 | 只在首次启动时使用 |
| `APP_SECRET_KEY` | 自动生成到 `DATA_DIR/secret.key` | 加密数据源密码的 AES-256 密钥，Base64 编码的 32 字节 |
| `TRUST_PROXY` | `false` | 位于反向代理之后时设为 `true`：用 `X-Forwarded-For` 做登录限流，按 `X-Forwarded-Proto` 设置 Secure Cookie 和 HSTS |
| `COOKIE_SECURE` | `auto` | 设为 `true` 或 `false` 时，强制开启或关闭 Secure Cookie |
| `LOG_RETENTION_DAYS` | `30` | 调用日志和同步详情保留天数 |
| `MAX_CONCURRENT_QUERIES` | `20` | 同时执行的实时查询上限，超出返回 503 |

## 创建第一个接口

1. **数据源**：新增 PostgreSQL 数据源，填写主机、端口、数据库和一个**只授予 SELECT 权限**的账号，然后点击「测试连接」。
2. **API Key**：为调用方创建一个 Key。Key 只显示一次，请立即保存。每个调用方可以单独创建，也可以单独吊销。
3. **API 管理 → 新增 API**：
   - 路径填 `/open/customer`，请求方式选 GET，数据模式选「实时查询」。
   - SQL 填 `SELECT cust_id, cust_name FROM customer WHERE cust_id = :cust_id`。
   - 添加请求参数 `cust_id`，类型 `string`，设为必填。
   - 在「测试当前 SQL」中输入 `{"cust_id": "10001"}` 并执行。测试直接使用表单中的内容，不需要先保存。
   - 打开「启用接口」，然后保存。
4. 调用：

```bash
curl -H 'X-API-Key: dbk_…' 'http://localhost:8080/open/customer?cust_id=10001'
```

```json
{"code":0,"message":"success","data":[{"cust_id":"10001","cust_name":"张三"}],
 "meta":{"count":1,"source":"REALTIME","request_id":"…"}}
```

出错时返回相应的 HTTP 状态码，响应体为 `{"code": 40001, "message": "…", "request_id": "…"}`。其中 `request_id` 与响应头 `X-Request-ID` 一致，也会记录在调用日志中。

## 接口规则

**参数**：GET 接口从查询字符串读取参数，POST 接口从 JSON 请求体读取参数。未声明的参数会被拒绝（400）。SQL 中用 `:name` 引用参数，每个参数都必须声明类型；保存配置时会检查 SQL 与参数声明是否一一对应。

**分页**：三种数据模式都支持可选的 `page` 和 `pageSize`。GET 放在查询字符串，POST 放在 JSON 请求体。只传其中一个也会开启分页；页码默认 1，每页默认最多 100 条。`pageSize` 上限为 1000，且不能超过该 API 配置的「最大行数」。分页响应的 `meta` 增加 `page`、`page_size`、`total`、`total_pages`、`has_more`；`count` 是本页条数。超过末页返回空数组。未传分页参数时，响应格式和原有最大行数限制保持不变。如果业务参数或过滤字段叫 `page` / `pageSize`，可改用 `_page` / `_pageSize` 指定分页。实时查询分页会额外执行一次总数查询；SQL 应写明 `ORDER BY`，以保证翻页顺序稳定。

```bash
curl -H 'X-API-Key: dbk_…' 'http://localhost:8080/open/customer?cust_id=10001&page=1&pageSize=50'
# POST 接口的 JSON 请求体示例：{"page":2,"pageSize":50,"cust_id":"10001"}
```

分页响应中，`data` 只包含当前页，`meta` 例如：`{"count":50,"source":"MANUAL","request_id":"…","page":2,"page_size":50,"total":123,"total_pages":3,"has_more":true}`。

**类型**：可用的字段类型有 `string`、`integer`（64 位）、`decimal`、`boolean`、`date`（`YYYY-MM-DD`）、`datetime`。
- `datetime` 带时区偏移时，会换算成 UTC 进行比较。
- `datetime` 不带时区偏移时，按 `TZ` 解释。

**输出**：
- `int8` 和 `numeric` 按数据库中的原始数字输出，例如 `9007199254740993`、`1.50`。
- 时间按 ISO 8601 格式输出，并保留小数秒和时区，例如 `2026-09-25T10:00:00.5+08:00`、`10:20:30.123456`。
- 数组中的元素遵守同样的规则。`json`/`jsonb` 输出为 JSON 结构，`bytea` 输出为 Base64 字符串。

**只读**：
- 只接受一条以 `SELECT` 或 `WITH` 开头的语句。
- 语句在 `READ ONLY` 事务中执行，包含写入的 CTE 等写操作会被数据库拒绝。
- 有语句超时和最大行数限制。未分页的实时查询超过最大行数时返回 422；分页请求的每页条数受最大行数限制。

## 三种数据模式

| 模式 | 数据来源 | 说明 |
| --- | --- | --- |
| 实时查询 | 每次请求都执行 SQL | 参数按声明的类型绑定 |
| 定时同步 | 按 Cron 或手动同步到平台 | 需要设置唯一键；数据可以拖动排序 |
| 手工维护 | 在「数据维护」页面增删改 | 按字段定义校验数据 |

**定时同步**：Cron 有 6 个字段，依次为秒、分、时、日、月、周，例如 `0 0 12 * * *` 表示在所选同步时区的每天 12:00 执行。管理页面新建 API 时，同步时区默认取浏览器时区；已有 API 沿用原服务端 `TZ`，可在编辑页改为 `Asia/Shanghai` 等 IANA 时区。下次同步时间按同步时区显示；编辑页和 API 列表的「同步详情」可查看每次定时或手动同步的开始时间、结果、行数和错误。记录按 `LOG_RETENTION_DAYS` 保留，升级前的同步历史无法追溯。一次同步要取回并校验全部结果后才会写入，写入是原子替换。以下情况都会保留上一次的快照：
- 查询失败，或结果超过最大行数；
- 唯一键重复（数值按大小比较，`1.0` 和 `1.00` 视为重复）；
- 结果为空，且没有开启「空结果覆盖」；
- 同步期间 API 或数据源的配置发生了变化。

拖动调整过的顺序会在后续同步中保留，新出现的行排在末尾。在「数据维护」页，可按所有记录的字段值查询；拖动记录到相邻页区域可跨页排序，点击位次可直接移动到任意位置。

**记录备注**：在「数据维护」页，每条定时同步或手工维护记录都可以添加最多 2000 字的备注；查询也会匹配备注内容。定时同步会按唯一键保留已有记录的备注。备注非空时，开放 API 在对应数据对象中增加 `__databridge_remark` 字段；清空备注后，该字段不再返回。该字段名留给平台备注使用，原数据若有同名字段，保存备注时会提示冲突。实时查询没有本地记录，因此不提供逐条备注。

**过滤**：定时同步和手工维护的接口，可以按「允许过滤」中列出的字段做等值过滤，这些字段需要先在字段定义中声明类型。
- 比较按字段类型进行，所以 `price=1.5` 能匹配存储的 `1.50`。
- POST 请求中传 JSON `null`，可以匹配空值。

**并发保护**：
- API 配置、数据源和手工记录都带有版本号，用过期的页面保存会返回 409，需要刷新后重试。
- 修改手工维护模式的字段定义时，已有记录会按新的类型转换，并递增版本号；如果有记录无法转换，保存会被拒绝。
- 切换数据模式会删除该 API 已有的本地数据，页面会先要求确认。

## 安全

- 数据源密码用 AES-256-GCM 加密后存储。**`secret.key` 丢失后，已保存的数据源密码无法解密**；如果数据库还在而密钥缺失，服务会拒绝启动。
- 管理员密码用 scrypt 哈希存储。修改密码后，该账号的所有会话都会失效。登录失败次数有限制。
- 管理端使用 `SameSite=Strict` 的会话 Cookie，写操作还要求带 `X-Requested-With` 请求头，用来防御 CSRF。
- API Key 只保存 SHA-256 哈希，页面上只显示前缀。
- User-Agent 限制只能用于客户端兼容性控制，不能代替 API Key。
- 调用日志只记录结果、耗时和错误摘要。数据库返回的错误详情不会出现在开放接口的响应或日志中，只在管理端的测试和同步状态里显示。
- 生产环境请通过 HTTPS 反向代理访问，并设置 `TRUST_PROXY=true`。

## 备份与恢复

所有状态都在数据卷中：`databridge.db`（以及运行时产生的 `-wal`、`-shm` 文件）和 `secret.key`。备份时先停止容器，再打包整个卷，**必须包含 `secret.key`**：

```bash
docker compose stop
docker run --rm -v databridge_data:/data -v "$PWD":/backup alpine tar czf /backup/databridge-backup.tgz -C /data .
docker compose start
```

恢复时把归档解压回同名的卷即可。

## 本地开发

需要 Node.js 22.18 或更高版本。服务端是 TypeScript，由 Node 直接运行，不需要编译。

```bash
npm ci
npm run build            # 构建管理页面到 web/dist
npm run dev              # 启动服务（8080），代码修改后自动重启
npm run dev:web          # 可选：Vite 热更新页面（5173），请求代理到 8080
npm run check            # 类型检查
npm test                 # 单元测试
TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/db npm test   # 加上集成测试
```

集成测试会在目标库中创建并删除 `databridge_test` schema，请使用一次性的测试库。

目录结构：

```
server/   服务端：app.ts 路由，apis.ts 接口与同步，sources.ts 数据源，query.ts 执行 SQL，sql.ts 参数解析，values.ts 类型转换
web/      管理页面（Vue 3 + Element Plus）
test/     node:test 测试
```

## 限制

- 外部数据源只支持 PostgreSQL。
- 只支持单实例部署：定时同步在进程内调度，会话也保存在内存中，重启服务后需要重新登录。

## License

本项目基于 [MIT License](LICENSE) 开源。
