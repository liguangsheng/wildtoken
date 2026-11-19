# 命令参考

`wildtokenctl commands --json` 是完整命令目录，列出 HTTP 方法、路径、认证类别和确认要求。CLI 只调用 HTTP API，不启动服务。

## 通用选项

| 选项 | 用途 |
| --- | --- |
| `--server URL` | 服务根地址，默认 `http://127.0.0.1:3100` |
| `--admin-token-file FILE` | 从文件读管理凭据 |
| `--token-file FILE` / `--token-id ID` | 下游令牌文件，或用管理 API 选择令牌 |
| `--admin-token-env NAME` / `--token-env NAME` | 指定凭据环境变量名称，不是凭据本身 |
| `--file FILE` / `--file -` | JSON 输入文件，或 stdin |
| `--data JSON` | 无秘密的短 JSON 输入 |
| `--query key=value` | 可重复的查询参数，如 `limit=20` |
| `--dry-run` | 预览请求；更新命令可能先读取当前记录 |
| `--yes` | 执行已获准的变更或探测 |
| `--out FILE` | 输出到新建的私有文件，不覆盖现有文件 |
| `--secret-out FILE` | 将单个返回的 token/api_key 写入新建的私有文件 |
| `--json` | 紧凑 JSON；流式命令始终输出 NDJSON |
| `--timeout 5m` | 请求期限；流仅限制等待响应头的时间 |

所有写操作和上游探测都要求 `--yes`，或用 `--dry-run` 预览。普通输出隐藏凭据；只有用户明确要求时才用 `--show-secrets`。

## 管理服务

```sh
wildtokenctl status --json
wildtokenctl upstreams list --json
wildtokenctl tokens list --json
wildtokenctl groups list --json
wildtokenctl models list --token-file /private/path/downstream.key --json
wildtokenctl logs list --query limit=20 --query status=5xx --json
wildtokenctl logs stream
```

渠道命令：`list/get/create/update/delete/enable/disable/archive/restore/priority/credential/test/test-model/debug/models/balance/balance-sub2api/fetch-models/export/import/stats/health`。

令牌命令：`list/get/create/update/delete/enable/disable/reset-usage`。分组命令：`list/get/create/update/delete`。

设置：`settings get/update/rotate-admin-token`。模型测试模板：`prompts list/create/update/delete`。

日志：`list/get/stream/attempts/snapshot/token-usage/top/overview/daily/clients`。

带 `{id}` 的命令在操作名后加 ID。快照还需字段名，如：

```sh
wildtokenctl logs snapshot 123 upstream_response --out /private/path/response.json
```

`upstreams/tokens/groups/settings update` 接受局部 JSON：先读取当前记录，仅投影可写字段，再合并补丁。`settings update` 保留 revision 检查；其他记录没有服务端版本锁，避免并发编辑同一记录。

`upstreams create` 遇到同名渠道会直接覆盖，保留渠道 ID 和历史日志关联；配置、Key 和分组以本次输入及创建默认值为准，默认解除归档。

```sh
wildtokenctl upstreams update 7 --data '{"priority":200}' --dry-run
wildtokenctl upstreams update 7 --data '{"priority":200}' --yes
wildtokenctl tokens create --file token.json --yes --secret-out /private/path/new-token.key
wildtokenctl upstreams import --file channels.json --dry-run
wildtokenctl upstreams import --file channels.json --yes
wildtokenctl upstreams export --out channels.json
```

导入文档的 `mode` 默认为 `skip`；覆盖同名渠道要明确提供 `"mode":"overwrite"`。默认导出不含 Key。
创建、调试、测试及模板命令的 JSON 字段使用对应管理 API 的请求形状；不要把列表或详情响应原样发回创建接口。

## 接入客户端

```sh
wildtokenctl clients pi --protocol responses --model model-id --token-file /private/path/downstream.key
wildtokenctl clients pi --protocol responses --model model-id --apply --yes
wildtokenctl clients opencode --protocol chat --model model-id --apply --yes
wildtokenctl clients opencode export --protocol messages --model model-id --out provider.json
```

`--config FILE` 显式选择配置文件；OpenCode 支持 `--scope project`，Pi 模型配置只支持用户级。
默认 provider ID 为 `wildtoken-<协议>`，可用 `--provider` 指定。配置默认引用 `WILDTOKEN_TOKEN`，不会替用户设置 shell 环境。

不传 `--model` 时，CLI 使用下游令牌查询网关模型列表。仅当能力已核实时，才加 `--context-window`、`--max-tokens`、`--reasoning` 或 `--vision`。

确需将下游令牌存入配置时，用户须明确选择 `--embed-token`。导出带明文令牌的配置必须写到私有 `--out` 文件，或明确允许 `--show-secrets`。预览默认仍脱敏。

## 安装 skill

```sh
wildtokenctl skill show
wildtokenctl skill install
wildtokenctl skill install --apply --yes
wildtokenctl skill install --scope project --apply --yes
```

默认安装到 `~/.agents/skills/wildtoken/`，Pi 和 OpenCode 都支持此目录；项目级安装到 `.agents/skills/wildtoken/`。
已存在不同内容时，只有 `--replace` 才允许替换。

## 错误与恢复

成功退出 0；本地校验或输出失败为 1；认证拒绝为 3；其他 HTTP 错误为 4；用户取消为 130。
错误写 stderr，不混入 stdout 的 JSON/NDJSON。出现“request succeeded”时不要重发写操作，先修复输出路径或读取服务端确认结果。
