# wildtokenctl

`wildtoken` 仍负责启动服务；`wildtokenctl` 是独立 HTTP 客户端，不打开数据库，也不启动后台服务。
它覆盖现有管理 API，输出 JSON；日志和调试流输出 NDJSON。`commands --json` 列出全部命令、HTTP 路径、认证类别和确认要求。

## 安装与连接

平台包同时包含服务端和客户端，Windows 客户端名为 `wildtokenctl.exe`。
macOS 应用内的客户端位于 `WildToken.app/Contents/MacOS/wildtokenctl`。
有 Go 1.25+ 时可直接安装固定版本，再安装 Pi/OpenCode 共用的 skill：

```sh
go install github.com/liguangsheng/wildtoken/cmd/wildtokenctl@v0.2.5
wildtokenctl skill install --apply --yes
```

`GOBIN`（未设置时为 `GOPATH/bin`）需加入 `PATH`。没有 Go 时，从对应平台包取出客户端放入 `PATH` 即可，不必安装服务端。
安装 skill 无需令牌，安装后 Pi 执行 `/reload`，OpenCode 重开会话。

从已有源码目录安装开发版：

```sh
go install ./cmd/wildtokenctl
wildtokenctl help
```

客户端默认连接 `http://127.0.0.1:3100`。`--server` 或 `WILDTOKEN_URL` 可指定其他实例；地址是服务根路径，不是 `/v1`。
远端默认要求 HTTPS。明确接受明文传输风险时，才使用 `--allow-http`。

| 凭据 | 来源 |
| --- | --- |
| 管理令牌 | `WILDTOKEN_ADMIN_TOKEN` 或 `--admin-token-file FILE` |
| 下游令牌 | `WILDTOKEN_TOKEN` 或 `--token-file FILE` |
| 已有下游令牌 ID | `--token-id ID`，通过管理 API 读取；需要管理凭据 |

`--admin-token-env NAME`、`--token-env NAME` 可改变变量名。凭据文件优先于对应环境变量。
不要把真实令牌写进命令行参数或聊天记录。服务端的 `ADMIN_TOKEN` 是初始化凭据；CLI 使用独立的 `WILDTOKEN_ADMIN_TOKEN` 名称。

```sh
wildtokenctl --admin-token-file /private/admin-token status --json
wildtokenctl --token-file /private/downstream-token models list --json
```

## 查询与变更

常用入口：

```sh
wildtokenctl commands --json
wildtokenctl upstreams list --json
wildtokenctl groups list --json
wildtokenctl tokens list --json
wildtokenctl settings get --json
wildtokenctl logs list --query limit=20 --query status=5xx --json
wildtokenctl logs stream
```

查询参数使用可重复的 `--query key=value`。`--timeout` 默认 30 秒；长探测可设为 `5m`。流式请求只对等待响应头计时，持续读到 EOF 或 Ctrl+C。

所有写操作及上游探测要求 `--yes`；`--dry-run` 只显示请求计划。修改、删除、重置用量、管理员令牌轮换和真实模型测试都不应由模型擅自执行。

```sh
wildtokenctl upstreams disable 7 --dry-run
wildtokenctl upstreams disable 7 --yes
wildtokenctl upstreams update 7 --data '{"priority":200}' --dry-run
wildtokenctl upstreams update 7 --data '{"priority":200}' --yes
wildtokenctl tokens create --file token.json --yes --secret-out /private/new-token.key
wildtokenctl upstreams test-model 7 --file probe.json --yes --timeout 5m
```

输入用 `--file FILE`，`--file -` 读取 stdin；`--data JSON` 只适合不含秘密的短输入。
`upstreams/tokens/groups/settings update` 接受局部 JSON：CLI 先读取当前记录，仅选择可写字段，再合并补丁。
因此修改名称或优先级不会顺带清空 Key、分组、有效期和限额。`settings update` 沿用服务端 revision 检查。
其他记录没有版本锁，不要并发编辑同一记录。

`upstreams create` 遇到同名渠道会直接覆盖，保留渠道 ID 和历史日志关联；配置、Key 和分组以本次输入及创建默认值为准，默认解除归档。

`keys` 仍是全量替换字段：显式提交空数组会清空全部 Key。服务端的校验与权限不因 CLI 改变。
其他创建、模板、调试和探测命令使用管理 API 的请求形状，可从 `help` 和 [skill 命令参考](../skills/wildtoken/references/commands.md) 查看入口。

## 导入导出渠道

```sh
wildtokenctl upstreams export --out channels.json
wildtokenctl upstreams import --file channels.json --dry-run
wildtokenctl upstreams import --file channels.json --yes
```

导出默认不含 API Key。明确需要带 Key 的私有备份时，使用 `--show-secrets --out FILE`。
导入文档的 `mode` 默认 `skip`；要覆盖同名渠道，显式提供 `"mode":"overwrite"`。
导入响应可能部分成功，CLI 会输出每项结果并以非零状态退出。不要因为 HTTP 200 就判断全部成功。

## 接入 Pi 和 OpenCode

先选择明确的协议：`chat`、`responses`、`messages`。网关的 `/v1/models` 只提供名称，不足以判断协议、上下文长度或模型能力。

```sh
# 预览：显式选择模型，不写本地配置。
wildtokenctl clients pi --protocol responses --model model-id
wildtokenctl clients opencode --protocol chat --model model-id

# 应用：只合并本次 provider，不改默认模型或其他 provider。
wildtokenctl clients pi --protocol responses --model model-id --apply --yes
wildtokenctl clients opencode --protocol chat --model model-id --apply --yes

# 用实际下游令牌获取它能使用的全部模型。
wildtokenctl clients pi --protocol messages --token-file /private/client.key

# 仅导出 provider 配置片段。
wildtokenctl clients opencode export --protocol chat --model model-id --out provider.json
```

默认 provider ID 是 `wildtoken-<协议>`，可用 `--provider` 改名。多个 `--model` 选择多个模型。
只有确认过能力时，才填写 `--context-window`、`--max-tokens`、`--reasoning` 和 `--vision`；未填写的字段使用目标客户端默认值。

配置默认引用环境变量：Pi 使用 `$WILDTOKEN_TOKEN`，OpenCode 使用 `{env:WILDTOKEN_TOKEN}`。
不传 `--model` 时，所选协议会应用于令牌可见的全部模型；混合协议的模型池应显式筛选，不能只凭模型名判断。
传入 `--token-file` 或 `--token-id` 只供本次查询使用，不会替用户设置目标程序的环境。
若要免去环境变量设置，必须明确选择 `--embed-token`，将下游令牌存入权限为 0600 的配置文件。
带明文的导出必须写入私有 `--out` 文件，或额外允许 `--show-secrets`。不会写入上游 Key 或管理员令牌。

默认文件位置：

- Pi：`$PI_CODING_AGENT_DIR/models.json`，未设置时为 `~/.pi/agent/models.json`。
- OpenCode：支持 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`XDG_CONFIG_HOME`；默认 `~/.config/opencode/opencode.jsonc`，已有 `.json` 时沿用它。
- OpenCode 可用 `--scope project` 写项目根目录。Pi 模型配置只支持用户级。
- `--config FILE` 可显式选择目标文件；同时存在 `.json` 和 `.jsonc` 时必须指定。

合并保留其他字段、JSONC 注释和符号链接。Pi 的模型数组按 ID 合并，不删除既有模型。
冲突默认拒绝，确认后才使用 `--replace`。应用前检查文件是否在预览后改变，并在真实目标文件旁保留原始字节备份。
已有 Pi/OpenCode 认证存储、provider 白名单和默认模型不会自动改动；它们仍可能影响最终生效配置。

## Skill

CLI 内嵌了标准 `SKILL.md` 及命令参考，不需要另外下载脚本：

```sh
wildtokenctl skill show
wildtokenctl skill install
wildtokenctl skill install --apply --yes
wildtokenctl skill install --scope project --apply --yes
```

默认安装到 `~/.agents/skills/wildtoken/`，Pi 和 OpenCode 都能发现；项目级位置为 `.agents/skills/wildtoken/`。
已存在不同内容时要求 `--replace`，写入前保留备份。不要同时安装多份同名 skill。
仓库根目录也提供只包含 skill 的 Pi package 清单，不会加载 WildToken 的网页主题为 Pi 主题。

Skill 教模型先读取目标、预览变更、取得授权，再调用 CLI。它不是权限隔离：能读取管理令牌的进程仍拥有完整管理权限。
对不可信任务应使用隔离的操作系统账户或环境，不要暴露管理员凭据。

## 输出、错误与边界

普通输出默认隐藏凭据字段、敏感 Header 和 URL 中的用户信息；`--show-secrets` 才放开这些字段。
日志正文和模型响应仍可能包含任意敏感文本，不能保证自动脱敏。优先查询元信息，需要正文时输出到私有文件。

`--out` 和 `--secret-out` 只创建新文件，不覆盖已有文件。Unix 权限为 0600；Windows 的实际访问范围由目标目录 ACL 决定，应选择仅当前用户可读的目录。备份可能包含旧凭据，不要提交到 Git。
输出文件在请求前检查，但磁盘仍可能在操作完成后失败。
出现 `request succeeded` 时，服务端操作已完成，不要重发；先读取状态或修复输出路径。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 本地校验、输出、探测或部分导入失败 |
| 3 | HTTP 401 / 403 |
| 4 | 其他 HTTP 错误 |
| 130 | 用户取消 |

错误写 stderr；stdout 保持 JSON/NDJSON。客户端不自动重试写请求。
