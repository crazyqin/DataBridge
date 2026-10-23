# 数桥 DataBridge

轻量的数据 API 平台。配置 PostgreSQL 数据源和一条 `SELECT`，或者直接在页面上维护数据，就能以 `/open/**` 发布 GET / POST 接口。

- **一个进程、一个数据卷**：Node.js 运行服务，平台数据存在内嵌的 SQLite，不需要额外数据库。
- **四种接口模式**：实时查询、定时同步快照、手工维护、星辰智能体转发。
- **共享连接**：身份验证配置和星辰基础地址集中维护，多个接口直接选用。
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
docker build --platform linux/amd64 -t databridge:1.2.7 .
mkdir -p release
docker save databridge:1.2.7 | gzip > release/databridge-1.2.7-amd64.tar.gz
```

在 Portainer 的 **Images → Import** 中上传压缩包；也可以在目标机器执行 `gzip -dc release/databridge-1.2.7-amd64.tar.gz | docker load`。镜像归档保存在本地 `release/`，不会提交到 Git。导入后在 **Containers → Add container** 中填写：

| 项目 | 值 |
| --- | --- |
| Image | `databridge:1.2.7` |
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
| `APP_SECRET_KEY` | 自动生成到 `DATA_DIR/secret.key` | 加密数据源密码、身份验证及星辰配置的 AES-256 密钥，Base64 编码的 32 字节 |
| `TRUST_PROXY` | `false` | 位于反向代理之后时设为 `true`：用 `X-Forwarded-For` 做登录限流，按 `X-Forwarded-Proto` 设置 Secure Cookie 和 HSTS |
| `COOKIE_SECURE` | `auto` | 设为 `true` 或 `false` 时，强制开启或关闭 Secure Cookie |
| `LOG_RETENTION_DAYS` | `30` | 调用日志和同步详情保留天数 |
| `MAX_CONCURRENT_QUERIES` | `20` | 实时查询、外部验证、星辰转发各自的并发上限，超出返回 503 |

## 连接管理与工作台

登录后进入「工作台」，查看接口启用数量、共享连接及最近调用。失败统计按服务器当前时间统计近 24 小时全部已记录的调用，不受最近 8 条列表或分页限制，并显示总调用数和失败率；没有调用时显示「暂无调用」。可手动刷新，点击卡片会按同一时间范围筛选失败日志。统计包含鉴权失败、未匹配接口及 SSE 流内失败，以调用结果为准。左侧「工作空间」管理接口、数据和日志，「配置中心」维护连接、数据源和调用密钥；列表支持搜索和筛选，手机上可通过顶部菜单切换页面。

在「连接管理」中创建一次配置：

- **身份服务**：集中保存凭证传递方式、验证地址、签名、成功条件和身份字段映射。
- **星辰平台**：集中保存包含 `/v1` 的基础地址；应用 ID、API Key 和 SM2 公钥仍由各接口单独维护。

创建接口时只需选择连接。只有一个可选连接时自动选中；也可在接口表单中打开抽屉新建或编辑连接，已填写的业务配置会保留。接口编辑按「基本设置 → 业务配置 → 测试发布」组织，高级选项折叠，保存时可选择草稿或启用。

接口列表的「更多 → 复制接口」会立即创建停用的副本并打开编辑页，保留业务配置、应用凭据和共享连接，自动生成不冲突的名称、路径及编码。副本不复制手工数据、快照数据或运行历史；确认配置后可启用。基本设置中的「接口编码（英文）」可以直接修改，包括复制生成的 `_copy` 后缀；新建时留空按路径自动生成，修改编码不会改变调用地址。

修改共享连接后，所有关联 API 的**后续请求立即生效**，无需逐个保存或重启。连接编辑器显示受影响的接口；被引用的连接不能删除，正在使用的身份字段不能删除或改变类型。连接有独立版本号，过期页面保存返回 409。

升级时自动把旧 API 内的身份验证配置和星辰地址转为共享连接：相同平台地址合并；验证设置相同且身份字段兼容时合并，字段冲突则分别保留。接口路径、启用状态及应用凭据不变。迁移在事务中执行，失败会回滚并停止启动，修复后可重试。配置整体加密保存，包括内部地址；列表只返回名称、引用关系和必要的身份字段元数据。

管理接口提供 `/admin/connections` 的列表/创建及 `/admin/connections/:id` 的读取/更新/删除。保存 API 时用 `authConnectionId` 和 `xingchenConnectionId` 引用连接；传入引用后以共享配置为准。旧管理客户端仍可提交内嵌配置，系统自动归入连接。`GET /admin/apis` 不再返回身份验证和星辰的完整敏感配置；编辑时使用 `GET /admin/apis/:id` 读取详情。

## 创建第一个接口

1. **数据源**：新增 PostgreSQL 数据源，填写主机、端口、数据库和一个**只授予 SELECT 权限**的账号，然后点击「测试连接」。
2. **调用密钥**：为调用方创建一个 Key。Key 只显示一次，请立即保存。每个调用方可以单独创建，也可以单独吊销。
3. **接口管理 → 创建接口**：
   - 在「基本设置」选择「实时查询」，填写名称和路径 `/open/customer`，调用方式选 GET，访问方式选「API Key」。
   - 在「业务配置」选择数据源，SQL 填 `SELECT cust_id, cust_name FROM customer WHERE cust_id = :cust_id`。
   - 添加请求参数 `cust_id`，类型 `string`，设为必填。
   - 在「测试发布」中输入 `{"cust_id": "10001"}` 并点击「执行 SQL 测试」。测试直接使用表单中的内容，不需要先保存。页面会显示本次构造的测试请求、请求 Header 和正文，以及服务器返回的 HTTP 状态、Header（含 Request ID）和正文；失败响应、HTML/非 JSON 返回和连接错误也会保留。敏感凭证已脱敏。
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

## 星辰智能体转发

选择「接口模式 → 星辰智能体转发」，系统使用外部身份验证获取当前调用者的工号，无需数据源或 SQL。平台基础地址从共享连接读取，`app_id`、`api_key`、`public_key` 由管理员在接口业务配置中填写；仓库和镜像不包含真实地址、密钥或样例个人信息。

1. 在「连接管理」创建身份服务，填写验证地址和成功条件。在身份映射中将验证响应的工号路径（例如 `data.staffCode`）映射到 `_auth_staff_code`，类型选 `string`，保留工号前导零。
2. 在「连接管理」创建星辰平台，填写基础地址（包含 `/v1`，例如 `https://agent.example.com/v1`）。接口的「基本设置」选择上述两个连接，再到「业务配置」填写应用 ID、API Key 和 `04` 开头的 130 位十六进制 SM2 公钥。系统发送到 `{基础地址}/chat-messages/{app_id}`。
3. 选择工号身份参数。每次请求使用 SM2 C1C3C2 加密紧凑 UTF-8 JSON：`{"staff_code":"<已验证工号>","iat":<Unix秒>,"nonce":"<16字节随机数的base64url>"}`。按文档已实测的 Python 格式输出原始 `x||y||C3||C2`（不带 `04` 点前缀、非 ASN.1），无填充 base64url 编码后加 `v2.`，放入 `Znt-Staff-Code`；`api_key` 放入 `Authorization: Bearer …`。
4. OA 通讯录查询使用默认映射：调用者参数 `q` → 智能体变量 `q`（实际为 `input_data.q`），提问参数也选 `q`，同时填写顶层 `query`。其他应用可配置多个变量，值按声明类型转换；未传的可选变量不写入 `input_data`。
5. 首次调用可省略 `conversation_id`，后续将平台返回的会话 ID 原样传回。默认 JSON 阻塞模式，也可选 SSE 流式。到「测试发布」填写本次身份凭证，点击「测试星辰转发」，系统会先验证身份再执行转发；编辑页测试统一用 blocking 模式便于查看完整结果，无需先保存。
6. 启用并保存，调用者仅提交身份凭证和已声明的业务参数：

```bash
curl -X POST 'http://localhost:8080/open/contacts' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"q":"示例查询","conversation_id":""}'
```

如果接口选 GET，则参数放在查询字符串；转发到星辰始终为 POST。默认生成如下平台请求体：

```json
{"input_data":{"q":"示例查询"},"query":"示例查询","mode":"blocking","conversation_id":""}
```

星辰转发成功时**直接返回平台 JSON 或 SSE**，不使用数据查询接口的 `data/meta` 包装，不支持 DataBridge 分页。JSON 中的 `answer` 保持字符串格式：通讯录应用通常需要调用方再次解析为数组，`"[]"` 表示无结果。SSE 按原始字节转发，客户端需处理 `message`、`message_end` 及 `error` 事件；HTTP 200 仍可能包含业务错误。流内错误不自动重试，以免重复提交对话；需要重试时由调用方决定。

平台请求默认超时 60 秒，可设为 1～120 秒，覆盖整个响应读取过程；单次响应最多 8 MiB。平台 HTTP 错误、重定向或异常响应返回 502，连接／读取超时返回 504，转发并发耗尽返回 503。SSE 已开始后若传输失败，追加 `event: "error"`、`code: "databridge_forward_error"` 的 data 事件。断开连接会取消上游请求；不跟随重定向，不关闭 HTTPS 证书校验，不转发调用者的其他请求头。

星辰配置整体加密存储。平台错误正文、凭据和地址不写入转发错误日志；测试诊断中的平台连接配置脱敏。成功的 JSON 结果在调用详情中保留脱敏后的限长预览；SSE 只记录接收字节数、已识别事件和结束状态。身份服务诊断沿用管理员可查看的现有机制。内网联调需在能访问平台的部署环境进行，本项目以本地模拟服务和独立 SM2 解密验证协议。

## 外部身份验证

API 的「访问方式」可以选择「外部身份验证」，复用已有的身份服务。验证请求、成功条件和响应字段映射在「连接管理」集中配置，API 只需选择身份服务；不要求特定客户端、凭证名称或返回结构，也无需为每个调用者创建平台 API Key。

身份服务连接编辑器按「调用者凭证 → 身份服务 → 成功条件 → 身份字段」四步配置。可一键填入 Bearer、查询参数或 JSON 传递方式，固定请求头通过表格填写，成功值选择文本、数字、布尔或空值，无需手写 JSON 引号。签名和附加请求体收在折叠区；常用签名生成器可根据 clientId、clientSecret 和三个请求头名称生成 `MD5(clientId + MD5(clientSecret) + timestamp)`。已有复杂动态 Header 配置仍可直接编辑。

支持以下配置：

| 配置 | 作用 | 示例 |
| --- | --- | --- |
| 验证地址、请求方式、超时 | 向固定地址发起 GET / POST，超时 1～30 秒 | `https://identity.example.com/verify` |
| 凭证来源 Header、来源前缀 | 从调用请求中提取凭证；前缀可留空 | `Authorization`、`Bearer `（末尾一个空格） |
| 凭证位置、目标名称、目标前缀 | 通过 Header、URL 查询参数、JSON 字段或表单字段传给验证服务 | Header `Authorization: Bearer …`、查询参数 `access_token=…`，或 JSON `{"token":"…"}` |
| 附加 Header、请求体 | 验证服务需要的固定配置；不会转发调用者的其他 Header | `{"X-Client-Id":"data-api"}`、`{"audience":"data-api"}` |
| 动态 Header | 每次验证请求生成时间戳和摘要，可组合固定文本及嵌套摘要 | `MD5(clientId + MD5(clientSecret) + timestamp)` |
| 成功 HTTP 状态 | 必须匹配的 2xx 状态 | `200` |
| 成功判定路径、值 | 进一步检查响应中的标量值；路径留空则跳过此项 | `active` 等于 `true`，或 `code` 等于 `0` |
| 附加成功条件 | 按路径检查其他响应字段；所有条件必须同时满足 | `data.status` 等于 `"active"`，且 `data.enabled` 等于 `true` |
| 身份参数映射 | 将响应字段按类型绑定到 SQL 参数 | `data.user.id` → `_auth_subject`，类型 `string` |

GET 验证请求支持通过 Header 或 URL 查询参数传递凭证；JSON 和表单使用 POST。查询参数也可与 POST 的固定 JSON 请求体配合使用。来源前缀会被移除，再加上目标前缀；两个前缀都允许留空。目标凭证会覆盖附加配置中的同名 Header / 字段 / 查询参数（包括重复参数），其他已有查询参数保留，参数值自动进行 URL 编码。表单附加字段只支持标量值。验证地址和附加请求内容由管理员配置，调用者不能修改。

「动态 Header」是 JSON 对象，键为目标 Header 名称，值为以下三种表达式之一：

| 表达式 | 配置 | 结果 |
| --- | --- | --- |
| 固定文本 | `{"type":"literal","value":"client-id"}` | 原样使用文本；摘要前保留空格并使用 UTF-8 编码 |
| 时间戳 | `{"type":"timestamp","unit":"milliseconds"}` | 当前毫秒时间戳；`seconds` 为秒时间戳，默认毫秒 |
| 摘要 | `{"type":"digest","algorithm":"md5","encoding":"hex","parts":[…]}` | 按 `parts` 顺序无分隔符拼接，再计算摘要；子项可以是以上任意表达式 |

摘要支持 `md5`、`sha256`、`sha512`，编码支持 `hex`（默认，小写）和 `base64`。同一次请求中所有时间戳表达式使用同一个时间点；每次请求重新计算。动态值覆盖同名固定 Header，不能与 Header 方式的目标凭证同名。配置最多 20 个动态 Header、16 KiB、100 个表达式节点，嵌套最多 6 层；不执行自定义脚本。

例如，验证服务需要固定 `X-Client-Id` 和 `X-Region`，并要求 `X-Call-Time` 为毫秒时间戳、`X-Digest` 为 `MD5(clientId + MD5(clientSecret) + timestamp)`。可使用签名生成器，或在「附加请求头」表格中填写对应名称和值（下面是等价 JSON 配置）：

```json
{"X-Client-Id":"client-id","X-Region":"region-a"}
```

再在「动态 Header」填写（替换 Header 名称、客户端标识和密钥）：

```json
{
  "X-Call-Time": {"type":"timestamp","unit":"milliseconds"},
  "X-Digest": {
    "type":"digest","algorithm":"md5","encoding":"hex",
    "parts":[
      {"type":"literal","value":"client-id"},
      {"type":"digest","algorithm":"md5","encoding":"hex","parts":[
        {"type":"literal","value":"client-secret"}
      ]},
      {"type":"timestamp","unit":"milliseconds"}
    ]
  }
}
```

如果服务通过 GET 的 `access_token` 接收用户凭证，选择「查询参数」，目标字段填 `access_token`，目标前缀留空即可。管理员配置的密钥随验证配置加密保存，实际调用凭证仍从请求的来源 Header 提取。

管理 API 的成功判定值使用 JSON 格式；页面通过类型选择器填写。例如 `true`、`0`、`"ok"`；字符串 `"0"` 与数字 `0` 不相等。点分路径支持嵌套对象和数组下标，例如 `data.user.id`、`data.groups.0.id`；字段名包含点时需在身份服务端提供其他字段名。路径不存在、身份字段缺失或类型不匹配时拒绝查询，不使用默认身份。

「附加成功条件」最多 20 条，每条配置响应字段路径和预期 JSON 标量值。HTTP 状态、主成功判定和所有附加条件必须同时满足，之后才提取身份参数并查询数据。例如成功判定设置为 `code` 等于 `200`，再增加 `data.status` 等于 `"active"`，可以同时验证业务结果和身份状态。字符串区分大小写；管理 API 的 JSON 字符串要带双引号，页面选「文本」后直接输入；条件路径不能重复，也不能与主成功判定路径重复。字段缺失返回 502，值不匹配返回 401，不执行数据查询。主成功判定路径留空且没有附加条件时，仅检查 HTTP 状态。

对应的配置字段示例：

```json
{
  "successPath":"code",
  "successValue":200,
  "successConditions":[
    {"path":"data.status","value":"active"},
    {"path":"data.enabled","value":true}
  ]
}
```

例如，某身份服务接受 `Authorization: Bearer <credential>`，返回：

```json
{"code":0,"data":{"user":{"id":"00123"},"tenant":{"id":"tenant-a"}}}
```

可以将成功条件设置为 `code` 等于 `0`，再添加以下映射：

| SQL 参数名 | 响应字段路径 | 类型 |
| --- | --- | --- |
| `_auth_subject` | `data.user.id` | `string` |
| `_auth_tenant` | `data.tenant.id` | `string` |

SQL 中根据身份字段限定数据范围：

```sql
SELECT o.order_id, o.amount
FROM orders o
JOIN subject_customer_permission p ON p.customer_id = o.customer_id
WHERE p.subject_id = :_auth_subject
  AND o.tenant_id = :_auth_tenant
ORDER BY o.order_id
```

身份参数名以 `_auth_` 开头，字段名和业务含义由配置决定。共享连接可包含多个身份字段，每个实时查询只需引用实际需要的字段；运行时仅提取该 API 使用的字段；不要在普通「请求参数」中再次声明。类型沿用平台字段类型，字符串保留前导零，大整数按原精度处理；映射结果通过 PostgreSQL 参数绑定，不拼接到 SQL 中。平台检查参数声明和类型，具体数据范围仍由 SQL 中的 `WHERE` / `JOIN` 条件决定。

调用示例：

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" 'http://localhost:8080/open/orders?page=1&pageSize=50'
```

GET 查询字符串和 POST 请求体均不能覆盖身份参数。分页数据和总数使用同一份已验证身份，每次请求只验证一次。所有数据模式都可使用同一身份连接作为访问门槛；**实时查询和星辰转发按需使用身份字段**。手工维护与定时快照仅验证身份，不提取字段或自动过滤记录；后台同步 SQL 不允许使用调用者身份参数。

验证配置由管理员在连接编辑器保存，数据库中加密存储，使用连接自身的版本号处理并发修改。实际凭证只随调用请求传入，不保存到 API 配置中。编辑器的 SQL / 星辰测试使用相同验证流程；输入不含前缀的测试凭证后，成功或失败均在当前接口编辑页保留，便于连续重试。凭证不保存到接口配置或浏览器持久存储，离开编辑页或刷新页面后清空。

外部验证不缓存结果、不跟随重定向、不自动转发客户端 Cookie；只有显式配置的 Header 会被发送。HTTP 401/403 或成功判定不匹配返回 401；服务异常或响应格式无效返回 502，超时返回 504，超出验证并发上限返回 503。验证并发上限为 `MAX_CONCURRENT_QUERIES`，需要解析的响应体最多 64 KiB。验证失败不会降级为公开访问；数据响应带 `Cache-Control: private, no-store`。

排查外部验证问题时，在连接编辑器填写「测试凭证」，点击「测试身份验证」即可测试尚未保存的配置。身份服务的单独测试统一在连接配置中进行，无需配置数据源或 SQL。API 的「测试发布」页保留完整 SQL / 星辰测试，填写身份凭证后一次完成身份验证与业务测试，并显示身份服务诊断。身份服务单独测试会检查连接中全部身份字段；执行 SQL / 星辰测试只提取该 API 使用的字段。身份测试和 SQL 测试都会显示脱敏后的验证请求地址、Header、请求体、响应 HTTP 状态、Header 和正文，以及各成功条件的预期值、实际值和检查结果。连接失败会显示底层错误信息（如 `ENOTFOUND`、`ECONNREFUSED`），重定向会显示状态和 `Location`；验证请求不会跟随重定向。

进入接口的「测试发布」页时，测试参数会根据业务配置中的请求参数自动生成 JSON 模板：文本为空字符串，数字为 `0`，布尔为 `false`，日期和时间带格式占位。直接替换模板值即可测试；身份服务提供的身份字段不会自动加入调用者参数。返回业务配置新增参数后会补齐缺少的字段，也可点击「补齐参数模板」；已填写的值、额外字段、大整数和小数原文保留。尚未完成的 JSON 不会被覆盖；删改已填写的参数后，可自行调整对应字段。

API 编辑页将诊断收在「身份服务诊断」和「测试请求详情」折叠区，失败时自动展开，分别显示 DataBridge 与身份服务之间、浏览器与 DataBridge 之间的请求和响应。浏览器通过 POST 调用管理端测试接口；外部验证请求仍按配置使用 GET 或 POST。配置中的 `tokenLocation`、`tokenName` 和前缀保持可读，实际凭证和签名密钥会脱敏。即使配置校验提前失败、外部服务详情尚未生成，或服务器返回 HTML/非 JSON 内容，也能查看本次测试的请求和返回。

正式调用的验证详情可在「调用日志 → 查看详情 → 身份验证」中查看，只有已登录的管理员能够访问。调用日志列表仅返回摘要，详情按需读取；旧日志缺少的详情不会追溯生成。token、密码、Cookie、服务密钥和动态签名摘要会脱敏，正文预览最多保留 8 KiB。详情与调用日志使用相同的保留期限，开放接口的响应不包含验证详情。管理端测试详情仅在测试响应中返回，不写入正式调用日志。

验证服务应使用 HTTPS 或可信的内部通道。自定义凭证 Header 时，需确认反向代理会保留该 Header。已有公开接口和 API Key 接口保持原规则；无法识别的访问方式会拒绝调用，需要管理员重新配置。

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
- API 配置、共享连接、数据源和手工记录都带有版本号，用过期的页面保存会返回 409，需要刷新后重试。
- 修改手工维护模式的字段定义时，已有记录会按新的类型转换，并递增版本号；如果有记录无法转换，保存会被拒绝。
- 切换数据模式会删除该 API 已有的本地数据，页面会先要求确认。

## 安全

- 数据源密码用 AES-256-GCM 加密后存储。**`secret.key` 丢失后，已保存的数据源密码无法解密**；如果数据库还在而密钥缺失，服务会拒绝启动。
- 管理员密码用 scrypt 哈希存储。修改密码后，该账号的所有会话都会失效。登录失败次数有限制。
- 管理端使用 `SameSite=Strict` 的会话 Cookie，写操作还要求带 `X-Requested-With` 请求头，用来防御 CSRF。
- API Key 只保存 SHA-256 哈希，页面上只显示前缀。
- User-Agent 限制只能用于客户端兼容性控制，不能代替 API Key。
- 调用日志记录请求方法、路径、HTTP 状态、耗时、行数和错误摘要；详情保存调用时的接口信息、完整请求地址、来源 IP、脱敏后的参数、请求与响应 Header、JSON 响应预览、处理阶段和外部身份验证记录，仅管理员可查看。数据库返回的错误详情不会出现在开放接口的响应或日志中，只在管理端的测试和同步状态里显示。
- 生产环境请通过 HTTPS 反向代理访问，并设置 `TRUST_PROXY=true`。

## 调用日志详情

`GET /admin/logs/stats` 返回近 24 小时的统计起止时间（`from` / `to`）、调用总数（`total`）及失败数（`failed`），仅管理员可访问。

调用日志列表的「请求」列只显示 GET、POST 等方法，不再单独设置错误列；悬停「失败」可预览错误原因，点击「失败」或「查看详情」可打开完整调用详情。「查看详情」保留服务端收到的完整 URL（协议、主机、端口、路径和查询字符串），并展示 Request ID、调用时间、来源 IP、调用时的接口名称、编码、版本、访问方式、数据模式和处理阶段耗时。「请求与结果」展示 URL 查询参数、JSON 请求体、业务参数与分页、请求与响应 Header、HTTP 状态、响应字节数、JSON 响应正文预览及返回行数；「身份验证」展示原有验证服务诊断。接口被修改或删除后，已记录的接口快照仍然保留。来源 IP 沿用 `TRUST_PROXY` 配置，未信任代理时不采用转发头中的地址。调用失败时也记录已经读取的入参，未匹配到启用接口的开放请求记录为 404。请求超过全局 2 MiB 限制时会在进入接口处理前被拒绝，不保存请求详情。

凭证、Authorization、Cookie、API Key、密码及签名字段在保存前脱敏，配置的自定义身份凭证及已知凭证值的副本也会隐藏。完整 URL、查询参数、请求体、请求与响应 Header、业务参数和响应正文的预览各最多 8 KiB，截断时在页面标注；大整数和小数原始精度保持不变。无效 JSON 只记录错误原因，不保留无法可靠脱敏的原文。成功和失败的 JSON 响应均保留脱敏预览，不改变发给调用者的实际响应；SSE 不缓存完整正文，仅记录接收字节数、已识别事件、最后事件与结束状态，流内失败时 HTTP 状态仍可能为 200，结果标记为失败。响应 Header 包括最终生成的 `X-Request-ID`。

管理端通过 `GET /admin/logs/:id/details` 按需读取请求与身份验证详情。详情跟随父日志按 `LOG_RETENTION_DAYS` 清理；删除接口后，在保留期内仍可查看对应调用。旧版本日志继续保留，可查看已有摘要、请求路径及身份验证详情；未记录的主机、响应正文、处理阶段等信息明确标注缺失，升级后的新调用开始记录。

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
