# 数桥 DataBridge

一个单体部署的轻量数据 API 平台。管理员配置外部只读数据源和 `SELECT` SQL，或者直接维护本地数据，然后通过 `/open/**` 发布 GET 或 POST 接口。

## Portainer 单镜像离线部署

导入 `release/databridge-standalone-amd64.tar.gz`。Portainer 中打开 **Images → Import** 上传文件，然后在 **Containers → Add container** 中填写：

| 项目 | 值 |
| --- | --- |
| Image | `databridge:standalone-amd64` |
| Published port | 宿主机 `8080` → 容器 `8080`（宿主机端口可改） |
| Volume | 建议创建命名卷 `databridge_data`，挂载到 `/var/lib/postgresql/data` |
| Restart policy | `Unless stopped` |

启动时会在**同一个容器**内运行应用和 PostgreSQL。PostgreSQL 只监听容器内的 `127.0.0.1:5432`，不要发布 5432 端口。数据库密码、AES 密钥和 API Key 首次启动时自动生成并保存在数据卷中；重建容器时必须复用同一个卷，否则数据会丢失。

首次登录账号为 `admin`。在 Portainer 的容器 **Console** 中执行 `cat /dev/shm/databridge-initial-password` 获取随机初始密码，登录后在页面右上角修改。初始密码明文仅保存在容器临时内存目录；如果尚未修改密码就重启容器，系统会重新生成初始密码，请再次从 Console 读取。平台数据库只保存 BCrypt 哈希。需要调用采用 API Key 鉴权的接口时，在容器 Console 中执行 `cat /var/lib/postgresql/data/.app_api_key` 获取自动生成的 Key。也可在创建容器时提供 `ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`APP_API_KEY` 和 `APP_SECRET_KEY` 环境变量；首次启动后密钥以数据卷中的值为准。

源码构建单镜像：

```bash
docker build --platform linux/amd64 -f Dockerfile.standalone -t databridge:standalone-amd64 .
docker save databridge:standalone-amd64 | gzip > databridge-standalone-amd64.tar.gz
```

## Docker Compose 双容器部署

需要 Docker Compose。复制环境变量模板，并生成强随机密钥：

```bash
cp .env.example .env
openssl rand -base64 32  # 填入 APP_SECRET_KEY，解码后必须是 32 字节
openssl rand -hex 32     # 可用于 APP_API_KEY、DB_PASSWORD
```

首次启动前还需生成管理员密码的 BCrypt 哈希。Docker 环境可运行 `docker run --rm -it httpd:2.4-alpine htpasswd -nBC 12 admin`，按提示输入密码，然后把输出中冒号后面的哈希填入 `.env` 的 `ADMIN_PASSWORD_HASH`，并保留单引号。编辑好 `.env` 后运行：

```bash
docker compose up -d --build
```

本项目的 Compose 同时启动应用与 PostgreSQL，两者均使用 `linux/amd64` 镜像；应用镜像名为 `databridge:0.1.0-amd64`，PostgreSQL 数据保存在独立卷中。若机器安装的是旧版独立命令，请把 `docker compose` 换成 `docker-compose`。宿主机 8080 已被占用时，可用 `APP_PORT=18080 docker compose up -d --build`，再访问 `http://localhost:18080`。

离线部署时，可在已构建镜像的机器上执行 `docker save databridge:0.1.0-amd64 postgres:16 | gzip > databridge-amd64-images.tar.gz`，将归档文件、`docker-compose.yml` 和填写好的 `.env` 拷贝到目标机器。目标机器运行 `docker load -i databridge-amd64-images.tar.gz`，再运行 `docker compose up -d --no-build`。不要把包含密钥的 `.env` 提交到 Git。

管理页面和开放 API 共用 `http://localhost:8080`。用 `ADMIN_USERNAME` 和生成哈希时输入的密码登录；登录后可在页面右上角修改密码。平台数据库仅保存 BCrypt 哈希，浏览器使用服务端会话，不保存管理员密码。生产环境应通过 HTTPS 反向代理访问，并限制管理端网络入口。PostgreSQL 数据保存在 Compose 卷中。

## 创建第一个 API

1. 在 **数据源** 中新增 PostgreSQL 数据源，填入 `jdbc:postgresql://主机:5432/数据库`、专用只读用户名和密码，保存后点击 **测试连接**。容器访问宿主机数据库时，请使用容器可达的主机地址。
2. 在 **API 管理** 中点击 **新增 API**，填写名称 `客户查询`、编码 `customer_query`、路径 `/open/customer`，选择 **实时查询** 和刚建立的数据源。接口编码是平台内唯一标识，不参与访问地址；留空可按路径自动填写。访问方式可选“公开访问”或“API Key 鉴权”，默认使用 Key。可选填“允许的 User-Agent”，每行一条；精确匹配，末尾 `*` 表示前缀匹配，例如 `MyClient/*`，留空表示不限制。
3. 填写 SQL `SELECT cust_id, cust_name FROM customer WHERE cust_id = :cust_id`。在请求参数中添加 `cust_id`，类型 `string`，设为必填。设置超时和最大行数，保存配置，点击 **测试 SQL** 并输入 `{"cust_id":"10001"}`。
4. 启用 API，然后调用：

```bash
curl -H 'X-API-Key: 你的APP_API_KEY' 'http://localhost:8080/open/customer?cust_id=10001'
```

成功响应包含 `code`、`message`、`data` 和 `meta`（行数、来源、request_id）。
POST 接口使用 JSON 请求体传递参数；GET 接口使用查询字符串。接口路径和请求方式的组合必须唯一。

## 三种模式

| 模式 | 数据来源 | 管理方式 |
| --- | --- | --- |
| REALTIME | 每次请求执行外部 `SELECT` | 命名参数绑定、只读事务、超时和行数限制 |
| SNAPSHOT | Cron 定时或手动同步到平台 PostgreSQL | 必填唯一键，原子替换快照；人工排序单独保存 |
| MANUAL | 平台 PostgreSQL | 定义字段后在“数据维护”增删改 |

SNAPSHOT 在获取、校验全部结果后才开启平台事务。重复唯一键、查询失败或默认禁止的空结果都保留上一份成功快照。同步后仍存在的行保留人工排序；消失的行删除其排序规则；新行排在末尾。**数据维护** 页面可拖动快照行并保存排序。SNAPSHOT 和 MANUAL 的本地等值过滤仅允许 API 配置中的“允许等值过滤”字段。

选择“API Key 鉴权”的接口必须发送 `X-API-Key`；“公开访问”的接口无需该请求头。管理员密码修改接口为 `POST /admin/password`，请求体包含 `currentPassword` 和 `newPassword`，新密码至少 12 位且 UTF-8 编码后不超过 72 字节。外部数据库务必使用只授予 `SELECT` 的账号。数据源密码使用环境变量 `APP_SECRET_KEY` 提供的 AES-256-GCM 密钥加密保存；**请稳定保存该密钥，否则已有数据源密码无法解密**。日志不保存完整请求或响应数据。

应用日志仅记录外部 SQL 失败的错误类别与 SQLState。内置 PostgreSQL 的普通错误不输出到容器标准日志，以免数据库异常把参数值写入日志；外部数据库的日志策略仍需在数据源侧配置。

管理 API 配置更新 `PUT /admin/apis/{id}` 必须附带最近一次读取返回的 `configVersion`；旧版本会返回 409，需重新加载配置。手工数据更新 `PUT /admin/apis/{id}/rows/{rowKey}?version={rowVersion}` 同样需要使用管理列表返回的 `rowVersion`，冲突时返回 409。POST 等值过滤可以使用 JSON `null` 查询真实空值。调用日志的 `from`、`to` 参数建议使用带时区的 ISO 8601 时间（例如 `2026-09-25T15:30:00+08:00`）；不带时区时按 UTC 解释。

User-Agent 由调用方设置，可用于客户端兼容性限制，不能当作身份认证；需要认证时仍应选择 API Key。

## 本地开发

需要 Java 21、Maven 3.9、Node.js 22 和 PostgreSQL。设置与 Compose 相同的环境变量及 `DB_URL`（默认 `jdbc:postgresql://localhost:5432/databridge`）。先构建后端，再用以下命令生成初始哈希，填入 `ADMIN_PASSWORD_HASH`，不要将密码明文写进配置或命令历史：

```bash
cd backend && mvn package -DskipTests && cd ..
read -rsp '初始管理员密码: ' initial_password; echo
printf '%s\n' "$initial_password" | java -jar backend/target/databridge-0.1.0.jar --hash-password
unset initial_password
```

构建前端并设置 `APP_FRONTEND_DIR=file:/项目绝对路径/frontend/dist/` 后启动后端；管理页面和 API 都在 8080：

```bash
cd frontend && npm ci && npm run build
cd ../backend
APP_FRONTEND_DIR=file:/项目绝对路径/frontend/dist/ java -jar target/databridge-0.1.0.jar
```

需要热更新前端时，也可运行 `npm run dev`，这时 Vite 的 5173 仅供开发使用，代理 `/admin`、`/auth` 和 `/open` 到 8080。检查构建：

```bash
cd backend && mvn test
cd frontend && npm run build
```

单元测试直接运行。PostgreSQL 集成测试需要单独的测试库；设置 `TEST_DB_URL`、`TEST_DB_USERNAME`、`TEST_DB_PASSWORD` 后运行 `mvn test`，测试会清空该库中的 DataBridge 核心表及 `source_item` 测试表。不要指向生产数据库。

平台表结构由 Flyway 创建。第一版支持 GET、POST 业务接口和单实例调度；部署多个应用副本会使 Cron 任务重复运行。
