# WildToken

**🌐 Language:** English | [简体中文](README.zh-CN.md)

> **Self-hosted LLM API aggregation gateway in Go.**
>
> WildToken exposes OpenAI-compatible `/v1/*` endpoints and an
> Anthropic-compatible `/v1/messages` endpoint, then routes each downstream
> request to the right upstream channel by explicit channel hints, model rules,
> priority, weight, and runtime health.

Use it when you want one stable API entrypoint for multiple LLM providers,
private provider keys, per-client downstream tokens, request observability, and
an admin console for day-to-day operations.

## ⚡ At a Glance

| Need | WildToken provides |
| --- | --- |
| One client endpoint | OpenAI-compatible `/v1/*` plus Anthropic-compatible `/v1/messages` |
| Provider isolation | Server-side upstream keys and client-facing downstream tokens |
| Smart routing | Explicit channels, model mappings, priorities, weights, and health-aware failover |
| Daily operations | Admin console for channels, tokens, logs, usage, balances, and runtime metrics |
| Visual customization | Built-in light/dark themes plus CSS-only theme packs under `themes/` |

## ✨ Highlights

- 🔌 **OpenAI-compatible gateway:** forward Chat Completions, Responses, model-list,
  streaming, and other `/v1/*` requests through one local endpoint.
- 🧩 **Anthropic Messages compatibility:** `POST /v1/messages` accepts standard
  `x-api-key` and `anthropic-version` headers and forwards them to
  Anthropic-compatible upstreams.
- 🛣️ **Multi-upstream aggregation:** configure channels with base URLs, provider API
  keys, model names, model mappings, model prefixes, reasoning-effort mappings,
  and per-channel headers.
- 🧭 **Routing controls:** select by `X-WildToken-Upstream`, `?upstream=`, exact model
  mappings, model names, prefixes, priority layers, weighted random choice, and
  automatic health-based effective weight.
- 🔁 **Retry and failover policy:** failed automatic routes can reselect another
  channel, while same-channel retries respect the configured delay.
- 🔐 **Downstream token management:** create client-facing API tokens in the admin
  console, shaped as an `sk-` prefix followed by 32 random alphanumerics. The full
  value is kept in the database so it can be copied from the token list at any
  time, or rewritten while editing — which retires the old value at once. Tokens
  can carry an optional expiry — entered as a duration such as `1d3h` or as a
  date — after which they stop authenticating while the record stays around to be
  renewed.
- 🚦 **Token and channel rate limits:** both tokens and channels accept an optional
  rate expression such as `100/m`, `1000/h` or `50/10s` (requests per window,
  units s/m/h/d with an optional multiplier). A rate-limited token is refused
  with 429; a rate-limited channel is skipped during routing so traffic fails
  over to the next candidate, and 429 is returned only when every candidate is
  exhausted. Counting uses in-memory sliding windows, so limits reset on restart.
- 📊 **Admin dashboard:** inspect channel status, request logs, token usage, top
  models/channels, latency, runtime metrics, and request/response snapshots. One
  time-range control covers today, 24h, 3d, 7d, 30d, all time, and custom dates.
- 🧰 **Channel tools:** fetch model lists, test connectivity, test a selected model,
  and query new-api/sub2api-style balances from the console.
- 📦 **Channel import/export:** move channel configuration between instances as JSON.
  Exports optionally include API keys, and same-name channels can be skipped or
  overwritten on import.
- 🧹 **Body retention controls:** keep metadata while pruning old request/response
  bodies to limit SQLite growth.
- 🎨 **Theme packs:** optional CSS-only admin themes under `themes/`, loaded without
  executing theme JavaScript.
- 🖥️ **Desktop mode:** Windows uses the system tray and the macOS desktop package
  uses the menu bar. CLI, Docker and default source builds stay in the foreground.

## 🖼️ Screenshots

Dashboard with the built-in light and dark themes:

| Light | Dark |
| --- | --- |
| ![Dashboard in the built-in light theme](screenshots/screenshot-light.png) | ![Dashboard in the built-in dark theme](screenshots/screenshot-dark.png) |

Request log page rendered by a CSS-only theme pack from [`themes/`](themes/):

| Ark |
| --- |
| ![Request logs with the Ark theme](screenshots/screenshot-ark.png) |

## 🚀 Quick Start

### 🐳 Docker Compose

Docker Compose is the easiest way to run WildToken as a local service.

```bash
cp .env.example .env
# Edit .env and set ADMIN_TOKEN to a unique 24-256 byte printable ASCII value.
docker compose up -d --build
curl -fsS http://127.0.0.1:3100/health
```

Open the admin console:

```text
http://127.0.0.1:3100/console
```

The Compose file stores SQLite data in the `wildtoken-data` volume and publishes
port `3100`. It also mounts `./themes` read-only into the container so theme
changes do not require an image rebuild.

To update a running instance, use `scripts/deploy.sh` rather than
`docker compose up -d --build`. The script builds first, waits up to 60 seconds
for in-flight requests to finish (set with `WAIT=`), then replaces the container
anyway, cutting the streams still running (`FORCE=0` gives up instead). It
checks the new container and rolls back to the previous image if anything fails.

For a brand-new database listening beyond localhost, WildToken refuses to start
unless `ADMIN_TOKEN` is explicitly set. The token must be 24-256 bytes, printable
ASCII, contain no spaces, and not be `change-me`.

### 🛠️ From Source

Requirements:

- Go 1.25 or newer
- CLI builds need no C toolchain: SQLite is pure Go, so `CGO_ENABLED=0` works
  on every CLI target. The macOS desktop build additionally needs the macOS SDK.

Run locally:

```bash
cp .env.example .env
# Optional for localhost-only first boot, required before exposing the service.
ADMIN_TOKEN=replace-with-a-long-random-token go run ./cmd/wildtoken
```

By default, source runs bind to `127.0.0.1:3100` and use
`sqlite:wildtoken.db?mode=rwc`.

### 🪟 Windows Desktop

Release archives include `wildtoken.exe`. Double-clicking it starts WildToken in
system-tray mode:

- left-click or double-click the tray icon to open the admin console
- use the tray menu to open the console or quit
- logs are written to `wildtoken.log` in the working directory
- set `WILDTOKEN_NO_TRAY=1`, or pass `--no-tray` / `--console`, for service or CI
  usage without the tray UI

Linux, macOS CLI and Docker builds keep the foreground service behavior.

### macOS Menu Bar Application

For macOS 12 or later, download `wildtoken-v<version>-macos-aarch64-app.zip`
(Apple Silicon) or `wildtoken-v<version>-macos-x86_64-app.zip` (Intel).
Extract `WildToken.app`, move it to Applications, and double-click it.
The app lives in the menu bar, without a terminal or Dock icon. Its menu opens
the console, copies the API address, opens logs or the data directory, and quits.
Quitting drains requests and logs; a second instance cannot open the same data
directory concurrently.

The default console address is `http://127.0.0.1:3100/console`. A new local-only
database without a configured admin token starts with `change-me`; rotate it in
Settings. Startup failures, including a busy port or unreadable database, display
an error dialog.

| Content | Location |
| --- | --- |
| Configuration | `~/Library/Application Support/WildToken/config/default.toml` |
| Environment file | `~/Library/Application Support/WildToken/.env` (create when needed) |
| Database, key, images and backups | `~/Library/Application Support/WildToken/` |
| Logs | `~/Library/Logs/WildToken/wildtoken.log` |
| Console assets and bundled themes | `WildToken.app/Contents/Resources/` (read-only) |

First launch copies the default configuration only if it does not exist.
Updating or moving the app does not replace user data or migrate a CLI database.
Relative writable paths start in the user data directory. The default `themes`
path names bundled themes; use an absolute `WILDTOKEN_THEME_DIR` in `.env` for
custom themes. Do not run CLI and desktop instances against the same database.

The bundled executable also supports foreground diagnosis and manual backups,
using the same desktop data directory:

```bash
/Applications/WildToken.app/Contents/MacOS/wildtoken --console
/Applications/WildToken.app/Contents/MacOS/wildtoken backup
```

Developer ID signing and Apple notarization are not configured yet. Gatekeeper
may block the first launch; verify the archive against the release's
`SHA256SUMS`. Launch at login is not enabled.

To build locally, install Go 1.25+, Node.js 22+ and Xcode Command Line Tools,
then run on a Mac of the target architecture:

```bash
npm --prefix web ci
npm --prefix web run build
scripts/package-macos.sh 0.2.6 arm64 /tmp/wildtoken-release  # amd64 for Intel
scripts/smoke-macos.sh /tmp/wildtoken-release/*-app.zip
```

### CLI and Agent Skills

`wildtoken` starts the service; the separate `wildtokenctl` manages it over HTTP.
Platform archives include both programs, and the macOS app also includes
`Contents/MacOS/wildtokenctl`. The client covers channels, groups, tokens,
settings, prompt templates, logs and models, with JSON/NDJSON output.

With Go 1.25+, install the client and shared skill without cloning the repository:

```sh
go install github.com/liguangsheng/wildtoken/cmd/wildtokenctl@v0.2.6
wildtokenctl skill install --apply --yes
```

Ensure `GOBIN`, or `GOPATH/bin` when `GOBIN` is unset, is on `PATH`.
Without Go, extract `wildtokenctl` (`wildtokenctl.exe` on Windows) from a verified
platform archive and put it on `PATH`, then run the skill command above. The
client does not need the server executable or web assets. Skill installation
requires no API credentials; reload Pi or restart OpenCode afterwards.

Common operations:

```sh
wildtokenctl --admin-token-file /private/admin-token status --json
wildtokenctl commands --json
wildtokenctl clients pi --protocol responses --model model-id
wildtokenctl clients opencode --protocol chat --model model-id --apply --yes
wildtokenctl skill install --apply --yes
```

Client setup previews changes before applying them. It uses downstream-token
environment references, never upstream keys, and preserves JSONC comments,
other providers and symlinks. The bundled skill installs into the Agent Skills
directory shared by Pi and OpenCode. See the [CLI guide](docs/cli.md).

## ✅ First Configuration

1. Open `/console` and log in with the Admin Token.
2. Create an upstream channel with its base URL, provider API key, models, model
   mappings, priority, weight, and optional header overrides.
3. Use the channel test or model test action to verify provider connectivity.
4. Create a downstream token on the Tokens page.
5. Call WildToken through `http://127.0.0.1:3100/v1/...` using the downstream
   token instead of the provider key.

Provider API keys stay on the server-side channel records. Clients only need
their downstream WildToken token.

## 🔌 API Examples

OpenAI-compatible Chat Completions:

```bash
curl http://127.0.0.1:3100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <DOWNSTREAM_TOKEN>' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

Anthropic-compatible Messages:

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

Aggregated local model list:

```bash
curl http://127.0.0.1:3100/v1/models \
  -H 'Authorization: Bearer <DOWNSTREAM_TOKEN>'
```

Force a specific channel by name or ID:

```bash
curl http://127.0.0.1:3100/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <DOWNSTREAM_TOKEN>' \
  -H 'X-WildToken-Upstream: openai' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
```

## 🧭 Routing Model

WildToken chooses an upstream in this order:

1. `X-WildToken-Upstream` header or `?upstream=` query parameter selects a
   channel by name or ID.
2. Request JSON `model` exact-matches a channel model-mapping key or model name.
3. Failing that, the same `model` is matched against the channel's model
   prefixes. A listed model name that merely starts or ends with the request is
   no match: `gpt-4o` does not reach a channel listing only `gpt-4o-mini`. Point
   an alias at another name with a model mapping.
4. Among enabled candidates, the highest `priority` layer wins.
5. Within that priority layer, WildToken performs weighted random selection.
   When automatic weight is enabled, effective weight is
   `base weight * runtime health score`.

If every channel in a higher-priority layer has zero effective weight,
WildToken falls back to the next priority layer. When a channel recovers above
zero, the higher-priority layer can take traffic again.

Explicit channel selection bypasses pool selection. Automatic retries re-run
selection for each attempt; selecting another channel retries immediately, while
selecting the same channel waits for the configured same-channel retry interval.

A channel may hold several API keys, and requests take its enabled keys in
turn. A key the upstream answers with 401, 403 or 429 sits out for 10 seconds,
twice as long with each refusal in a row up to 5 minutes (or as long as a
`Retry-After` says, within that cap), and the request moves to the channel's
next key before another channel. A channel whose keys are all disabled leaves
routing; one with no keys signs in through its extra headers. The console shows
saved keys masked: the eye button fetches one, and every key handed out is
logged. A balance query reads each enabled key and lists it on its own, and
the log page shows which key an in-flight request is using.

Stored Responses IDs are bound in SQLite to the downstream token, channel and
key that created them. Retrieval, cancellation, deletion and continuations with
`previous_response_id` use that account and still enforce the token's current
group and model restrictions. A disabled channel or changed credential returns
an error. Explicit `store: false` skips this record; responses created before
this upgrade or outside the gateway have no ownership record and return 404.

## 🗺️ Model Mapping

Model mappings let clients use a stable downstream model name while WildToken
rewrites the request body before forwarding upstream.

Example:

```text
gpt-4o-mini => provider-specific-fast-model
```

The client still sends `"model": "gpt-4o-mini"`. The upstream receives
`"model": "provider-specific-fast-model"`, and logs show both request and
upstream model names.

`GET /v1/models` is aggregated locally from enabled upstream configuration. It
returns:

- exact `model_names`
- `model_mappings` keys, which are the downstream-facing names

`model_prefixes` are only routing rules and are not expanded into concrete model
IDs. Add exact model names or mapping keys if a model should appear in
`/v1/models`.

Filter models to one channel:

```bash
curl 'http://127.0.0.1:3100/v1/models?upstream=openai' \
  -H 'Authorization: Bearer <DOWNSTREAM_TOKEN>'
```

## 🧠 Reasoning Effort Mapping

Providers do not agree on which reasoning efforts exist, so a channel can
translate the effort a client asked for into one its upstream accepts. Configure
it per channel under **Advanced settings**, one rewrite per line:

```text
max => xhigh
```

A request asking for `max` reaches that upstream asking for `xhigh`. An effort
with no entry is forwarded unchanged, and the match ignores case.

All three shapes a request can state its effort in are rewritten: the top-level
`reasoning_effort`, the nested `reasoning.effort`, and the nested
`output_config.effort`. Everything beside the effort — `thinking`, `verbosity`,
`summary` — is left as the client sent it.

Logs record all three stages: the effort the client asked for, the effort
actually sent upstream, and the effort the response reported. Consecutive
duplicates collapse, so a request that was not rewritten still shows a single
value, while a rewritten one reads as `max ↳ xhigh`.

## 🧾 Header Overrides

Each channel can define static headers and selected client-header passthroughs:

```json
{
  "User-Agent": "{client_header:User-Agent}",
  "X-Provider-Route": "premium"
}
```

Configured headers are applied after downstream headers, protocol defaults, and
the channel API key, so channel configuration wins on duplicate names.

`{client_header:<Header-Name>}` copies a downstream header only when that value
exists. It cannot copy downstream `Authorization` or `x-api-key`, and transport
or internal headers such as `Host`, `Content-Length`, and
`X-WildToken-Upstream` cannot be overridden.

Static overrides apply to normal forwarding, channel tests, model fetching,
model tests, and balance queries. Client-header passthrough only applies during
normal forwarding, where a downstream request context exists.

## ⚙️ Configuration

Default settings live in [`config/default.toml`](config/default.toml):

```toml
[server]
host = "127.0.0.1"
port = 3100

[database]
url = "sqlite:wildtoken.db?mode=rwc"
max_connections = 3

[upstream]
default_timeout_seconds = 300.0

[admin]
token = "change-me"

[themes]
dir = "themes"
```

Configuration sources are loaded in this order:

1. `config/default.toml`
2. optional `config/<RUN_ENV>.toml`
3. environment variables with the `APP__` prefix, for example
   `APP__SERVER__PORT=3100`
4. compatibility variables from `.env`: `ADMIN_TOKEN`, `DATABASE_URL`,
   `ENCRYPTION_KEY`, and `WILDTOKEN_THEME_DIR`

Common environment variables:

```bash
APP__SERVER__HOST=127.0.0.1
APP__SERVER__PORT=3100
DATABASE_URL='sqlite:wildtoken.db?mode=rwc'
APP__DATABASE__MAX_CONNECTIONS=3
APP__LOGGING__LOG_QUEUE_CAPACITY=512
APP__UPSTREAM__DEFAULT_TIMEOUT_SECONDS=300
WILDTOKEN_THEME_DIR=themes
WILDTOKEN_LOG=info
```

`ADMIN_TOKEN` is used only to initialize a new database credential. After the
admin credential exists in SQLite, change it from the admin console under
Settings -> Security; editing `.env` will not rotate or reset it.

## 📈 Observability and Retention

The admin console includes:

- dashboard KPIs for requests, tokens, channel status, and runtime state
- top models and channels by request count or token usage
- request log search and filtering
- downstream request, upstream request, and upstream response snapshots
- first-token latency, total duration, token counts, cache-hit tokens, and
  reasoning-token fields when providers report them
- server-side log body retention, full-log retention, and snapshot byte limits

Log metadata and body snapshots are stored separately. Bodies are cut into
content-defined chunks and each chunk is stored once: a coding agent resends its
whole conversation every turn, so consecutive requests are nearly identical and
each log only pays for its new turn. Snapshot metadata such as headers is
stored once per distinct value too. Logs past the keep count lose their bodies
but keep status code, channel, model, token usage, latency, and headers; chunks
no body lists any more are then collected. Up to 100,000 logs can keep their
bodies, at up to 128 MiB per body. SQLite incremental vacuum returns the freed
pages to the filesystem.

Go runtime profiles are available under `/api/admin/debug/pprof/` and require
the admin token in `x-admin-token`. The index lists heap, goroutine, mutex and
other profiles; CPU and execution trace captures use `/profile` and `/trace`.

## 💾 Backup and Restore

WildToken backs the database up every day at 05:00 local time and keeps the
newest 10 (`backup.at`, `backup.keep`, or `APP__BACKUP__AT`,
`APP__BACKUP__KEEP`). A backup is one SQLite file holding everything but log
bodies, which are a rolling diagnostic window; restored logs show their bodies
as cleared. A start with no backup from the last day takes one a minute in.

- Docker Compose writes them to `./.backup` on the host (`BACKUP_DIR` moves
  it), so they outlive the data volume. Create the directory as your user
  before the first start — `scripts/deploy.sh` does — or Docker creates it as
  root and the backups are root's.
- Run from source or as the Windows app, they go to `backups/` under the
  working directory (`WILDTOKEN_BACKUP_DIR` moves it).
- `wildtoken backup` takes one now, beside a running server:
  `docker compose exec wildtoken wildtoken backup`.

Credentials in a backup are sealed with the key in use when it was taken. Keep
that key (`ENCRYPTION_KEY`, or `wildtoken.key` in the data volume) somewhere
the backups are not.

To restore under Docker Compose:

```bash
scripts/restore.sh .backup/wildtoken-20261104-050000.db
```

It stops the container, keeps the database it replaces in the data volume as
`wildtoken.db.before-restore-<time>`, starts the container and reports whether
the stored credentials opened. Elsewhere, stop the service and copy the backup
over `wildtoken.db`.

## 🎨 Themes

Built-in light and dark themes live under `static/css/`. Optional theme packs
live under [`themes/`](themes/) and are documented in
[`themes/README.md`](themes/README.md).

A theme pack contains a `theme.json` manifest and CSS files. Theme CSS should be
scoped under `html[data-theme="<id>"]` and override CSS variables. WildToken
loads theme CSS as same-origin static files and does not execute JavaScript from
theme packs.

## 🔐 Security Notes

- Put WildToken behind TLS and normal network controls before exposing it
  outside a trusted machine or network.
- Use a strong `ADMIN_TOKEN` for any non-localhost bind and rotate the legacy
  `change-me` credential before exposure.
- Keep `.env`, SQLite data, logs, and release archives with live configuration
  out of public repositories.
- Provider API keys, sensitive static headers and the token copies the console
  shows are sealed in SQLite with AES-256-GCM; authentication resolves a SHA-256 digest. The key is
  `ENCRYPTION_KEY` (generate one with `openssl rand -hex 32`); without it,
  WildToken creates `wildtoken.key` (mode 0600) beside the database on first
  start. Keep the key out of database backups — under Docker, set
  `ENCRYPTION_KEY` in `.env`, or the key sits in the data volume. Setting it
  later moves existing values over on the next start. Losing the key means
  re-entering every channel key, so back it up separately. The console still
  shows keys and tokens in the clear to whoever holds the admin token.
- The first start after upgrading seals existing plaintext and runs one
  `VACUUM` to clear old copies from free space; it needs free disk space about
  the size of the database.
- Provider API keys are injected into upstream requests server-side and should
  never be distributed to downstream clients.
- Admin APIs are same-origin and require `x-admin-token`; compatibility `/v1/*`
  APIs are intentionally CORS-enabled for downstream clients.
- Admin authentication is rate limited: a single source backs off exponentially
  after 5 consecutive failures (1s, doubling to 60s), and more than 100 failures
  per minute puts every remote caller into a 30s cooldown. Already-verified
  tokens are answered from cache and are never throttled. Loopback callers are
  always exempt, so an operator cannot be locked out of their own console.
- Behind a reverse proxy, set `admin.client_ip_header` to the header your proxy
  overwrites (e.g. `x-forwarded-for`); otherwise every request looks like one
  source. **Only set it when a proxy really does overwrite that header** — it is
  caller-controlled, so trusting an unwritten one lets every caller pick its own
  identity and shed its failure history.

## 🧪 Development Checks

Useful local checks before shipping a change:

```bash
gofmt -l cmd internal
go vet ./...
go test -race ./...
docker compose up -d --build
curl -fsS http://127.0.0.1:3100/health
docker compose ps
```

For JavaScript-only changes in the admin console, also run the repository's
Node-based checks that match the touched files, for example `node --check` or
the theme contract tests under `tests/*.mjs`.

## 📦 Releases

Pushing a `v*` tag matching the service version in `internal/handlers/admin.go`
creates a GitHub Release through Actions. The original five platform archives
remain, joined by Intel and Apple Silicon macOS `.app.zip` packages.
`SHA256SUMS` covers all seven archives. CLI packages include `wildtoken`,
`wildtokenctl`, and `static/`, `config/`, `themes/`, and `web/dist/`; desktop packages keep those
resources inside the app. Each desktop target is tested and built on its native
macOS runner, including a smoke test of the unpacked application's startup and
shutdown.
