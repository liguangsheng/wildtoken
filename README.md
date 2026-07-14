# WildToken

WildToken 是一个 Rust 版 OpenAI 与 Anthropic Messages API 兼容的 LLM API 中转服务，监听 `3100` 端口。它向下游暴露 `/v1/*` API，并按渠道配置把请求转发到不同上游服务。

## 启动

本地开发：

```bash
cargo run
```

Docker：

```bash
docker compose up -d --build
```

管理界面：

```text
http://127.0.0.1:3100/admin
```

管理界面和管理接口（`/api/admin/*`）需要 Admin Token。首次启动时可以从 `.env.example` 复制一份 `.env`，通过 `ADMIN_TOKEN` 设置初始凭证；之后可在管理界面的「设置 > 安全」中自行填写并更换。下游 API 令牌在管理界面的「令牌」页创建和管理。

## 配置

默认配置在 `config/default.toml`：

```toml
[server]
host = "0.0.0.0"
port = 3100

[database]
url = "sqlite:wildtoken.db?mode=rwc"
max_connections = 3
sqlite_cache_size_kib = 2048
sqlite_statement_cache_capacity = 32
sqlite_mmap_size_bytes = 0
idle_timeout_seconds = 60

[logging]
log_queue_capacity = 512
```

也可以用环境变量覆盖，例如：

```bash
TOKIO_WORKER_THREADS=4 APP__SERVER__PORT=3100 APP__DATABASE__MAX_CONNECTIONS=3 APP__LOGGING__LOG_QUEUE_CAPACITY=512 DATABASE_URL='sqlite:wildtoken.db?mode=rwc' cargo run
```

为兼容旧配置，`.env` 里的 `ADMIN_TOKEN`、`DATABASE_URL` 也会被读取。`ADMIN_TOKEN` 只用于首次初始化数据库中的管理员凭证，已初始化后的凭证以数据库记录为准。

## 路由规则

请求会按以下顺序选择渠道：

1. `X-WildToken-Upstream` 请求头或 `?upstream=` 查询参数指定渠道名称/ID。
2. JSON 请求体里的 `model` 优先匹配渠道的模型映射。
3. 其次匹配模型前缀、模型名前缀、模型名后缀。
4. 使用已启用渠道中 `priority` 最大的一组，同优先级随机选择。

如果渠道配置了 API Key，WildToken 会把转发请求的 `Authorization` 改为该渠道的 Key。请求体、路径、查询参数和方法会按原样转发；如果配置了模型映射，转发时会重写请求体中的 `model`。

每个渠道还可以在管理界面的「高级设置」中配置 Header 覆盖。例如：

```json
{
  "User-Agent": "{client_header:User-Agent}",
  "X-Provider-Route": "premium"
}
```

Header 名大小写不敏感，配置值会在下游请求头、协议默认头和渠道 API Key 之后写入，因此同名 Header 以渠道配置为准。值完全写成 `{client_header:<Header-Name>}` 时，会读取对应下游 Header；下游没有该值时跳过这条覆盖。出于凭证隔离要求，不能读取下游 `Authorization` 或 `x-api-key`。

`Host`、`Content-Length` 等传输头以及 `X-WildToken-Upstream` 内部路由头不可覆盖。静态覆盖同时用于正常转发、渠道测试、模型拉取、模型测试和余额查询；`client_header` 占位符仅在正常转发有下游请求上下文时生效。

调用 `/v1/*` 需要携带令牌管理页中启用的下游令牌。

## 日志存储

请求日志的元数据与正文快照分表存储。服务每分钟清理超出“正文保留数量”的旧快照正文，同时保留状态码、渠道、模型、Tokens、耗时与 Headers 等元数据；超过“日志保留天数”的完整日志按小时删除。SQLite 使用增量自动回收模式，避免正文清理后空闲页长期累积。

## 发布

推送与 `Cargo.toml` 版本一致的 `v*` 标签后，GitHub Actions 会创建 Release，并生成以下未签名产物及 `SHA256SUMS`：

- Windows x86_64
- Linux x86_64（GNU，基于 Ubuntu 22.04）
- macOS Universal（Intel 与 Apple Silicon）

也可以从 Actions 页面手动运行发布流程并填写一个已经存在的版本标签。压缩包包含运行所需的 `static/` 与 `config/`，解压后应在该目录中启动 WildToken。Windows SmartScreen 或 macOS Gatekeeper 可能会提示未签名程序。

`POST /v1/messages` 兼容 Anthropic Messages API：可用标准的 `x-api-key` 下游令牌和 `anthropic-version` 请求头。请求、响应和 SSE 事件均原样透传；为此类请求配置渠道 API Key 时，WildToken 会向上游使用 `x-api-key`，并在未指定时补充 `anthropic-version: 2023-06-01`。因此该渠道的 Base URL 应指向 Anthropic 兼容上游（例如 `https://api.anthropic.com`）。

## 下游调用示例

```bash
curl http://127.0.0.1:3100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <DOWNSTREAM_TOKEN>' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

Anthropic Messages API：

```bash
curl http://127.0.0.1:3100/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <DOWNSTREAM_TOKEN>' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

强制指定渠道：

```bash
curl http://127.0.0.1:3100/v1/models \
  -H 'Authorization: Bearer <DOWNSTREAM_TOKEN>' \
  -H 'X-WildToken-Upstream: openai'
```
