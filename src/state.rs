use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use sqlx::SqlitePool;
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, RwLock};

use crate::config::Settings;
use crate::error::AppError;
use crate::proxy::matcher::BackoffManager;
use crate::{
    db::settings as settings_db,
    models::settings::{AdminCredential, RuntimeSettings},
};

const RESPONSE_REASONING_EFFORT_BACKFILL: &str = "request_logs_response_reasoning_effort_v1";
const CLIENT_TYPE_BACKFILL: &str = "request_logs_client_type_v1";
const REQUEST_LOG_PAYLOADS_MIGRATION: &str = "request_log_payloads_v1";

type AdminTokenMac = Hmac<Sha256>;

const SSE_RECENT_DISCONNECT_WINDOW: Duration = Duration::from_secs(10 * 60);

fn unix_seconds_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

async fn backfill_response_reasoning_effort_once(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let already_applied: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?)")
            .bind(RESPONSE_REASONING_EFFORT_BACKFILL)
            .fetch_one(&mut *tx)
            .await?;
    if already_applied != 0 {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        r#"UPDATE request_logs
           SET response_reasoning_effort = CASE
               WHEN upstream_response LIKE '%"effort":"minimal"%' THEN 'minimal'
               WHEN upstream_response LIKE '%"effort":"low"%' THEN 'low'
               WHEN upstream_response LIKE '%"effort":"medium"%' THEN 'medium'
               WHEN upstream_response LIKE '%"effort":"high"%' THEN 'high'
               WHEN upstream_response LIKE '%"effort":"max"%' THEN 'max'
           END
           WHERE response_reasoning_effort IS NULL
             AND (upstream_response LIKE '%"effort":"minimal"%'
               OR upstream_response LIKE '%"effort":"low"%'
               OR upstream_response LIKE '%"effort":"medium"%'
               OR upstream_response LIKE '%"effort":"high"%'
               OR upstream_response LIKE '%"effort":"max"%')"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO app_migrations (name) VALUES (?)")
        .bind(RESPONSE_REASONING_EFFORT_BACKFILL)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn backfill_client_type_once(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let already_applied: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?)")
            .bind(CLIENT_TYPE_BACKFILL)
            .fetch_one(&mut *tx)
            .await?;
    if already_applied != 0 {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        r#"WITH classified AS (
               SELECT id,
                   CASE
                       WHEN json_valid(downstream_request)
                         AND LOWER(COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '')) LIKE '%opencode%' THEN 'opencode'
                       WHEN json_valid(downstream_request)
                         AND LOWER(COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '')) LIKE '%codex%' THEN 'codex'
                       WHEN path = 'messages'
                         OR (json_valid(downstream_request)
                           AND (LOWER(COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '')) LIKE '%claude%'
                             OR COALESCE(json_extract(downstream_request, '$.headers.anthropic-version'), '') <> '')) THEN 'claude'
                   END AS detected_client_type
               FROM request_logs
           )
           UPDATE request_logs
           SET client_type = (
               SELECT detected_client_type
               FROM classified
               WHERE classified.id = request_logs.id
           )
           WHERE EXISTS (
               SELECT 1
               FROM classified
               WHERE classified.id = request_logs.id
                 AND classified.detected_client_type IS NOT NULL
                 AND classified.detected_client_type IS NOT request_logs.client_type
           )"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO app_migrations (name) VALUES (?)")
        .bind(CLIENT_TYPE_BACKFILL)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn migrate_request_log_payloads_once(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS request_log_payloads (
            request_log_id INTEGER PRIMARY KEY
                REFERENCES request_logs(id) ON DELETE CASCADE,
            request_snapshot TEXT,
            upstream_request_override TEXT,
            upstream_request_is_override INTEGER NOT NULL DEFAULT 0
                CHECK (upstream_request_is_override IN (0, 1)),
            response_snapshot TEXT,
            downstream_response_override TEXT,
            downstream_response_is_override INTEGER NOT NULL DEFAULT 0
                CHECK (downstream_response_is_override IN (0, 1)),
            bodies_cleared INTEGER NOT NULL DEFAULT 0
                CHECK (bodies_cleared IN (0, 1))
        );"#,
    )
    .execute(&mut *tx)
    .await?;
    let bodies_cleared_exists: Option<String> = sqlx::query_scalar(
        "SELECT name FROM pragma_table_info('request_log_payloads') WHERE name = 'bodies_cleared'",
    )
    .fetch_optional(&mut *tx)
    .await?;
    if bodies_cleared_exists.is_none() {
        sqlx::query(
            "ALTER TABLE request_log_payloads ADD COLUMN bodies_cleared INTEGER NOT NULL DEFAULT 0 CHECK (bodies_cleared IN (0, 1))",
        )
        .execute(&mut *tx)
        .await?;
    }

    let already_applied: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?)")
            .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
            .fetch_one(&mut *tx)
            .await?;
    if already_applied != 0 {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        r#"INSERT OR IGNORE INTO request_log_payloads (
               request_log_id,
               request_snapshot,
               upstream_request_override,
               upstream_request_is_override,
               response_snapshot,
               downstream_response_override,
               downstream_response_is_override
           )
           SELECT id,
               downstream_request,
               CASE WHEN upstream_request IS NOT downstream_request THEN upstream_request END,
               upstream_request IS NOT downstream_request,
               upstream_response,
               CASE WHEN downstream_response IS NOT upstream_response THEN downstream_response END,
               downstream_response IS NOT upstream_response
           FROM request_logs"#,
    )
    .execute(&mut *tx)
    .await?;

    let parent_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_logs")
        .fetch_one(&mut *tx)
        .await?;
    let payload_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_log_payloads")
        .fetch_one(&mut *tx)
        .await?;
    if parent_count != payload_count {
        let error = sqlx::Error::Protocol(format!(
            "request log payload migration row-count mismatch: {parent_count} request_logs, {payload_count} request_log_payloads"
        ));
        tx.rollback().await?;
        return Err(error);
    }

    sqlx::query(
        r#"UPDATE request_logs
           SET downstream_request = NULL,
               upstream_request = NULL,
               upstream_response = NULL,
               downstream_response = NULL
           WHERE downstream_request IS NOT NULL
              OR upstream_request IS NOT NULL
              OR upstream_response IS NOT NULL
              OR downstream_response IS NOT NULL"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO app_migrations (name) VALUES (?)")
        .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

struct CachedAdminToken {
    credential_version: i64,
    fingerprint: [u8; 32],
}

pub(crate) struct AdminAuthCache {
    key: [u8; 32],
    verified: Mutex<Option<CachedAdminToken>>,
    #[cfg(test)]
    argon2_verifications: std::sync::atomic::AtomicU64,
}

#[derive(Debug, Clone)]
pub struct RuntimeMetricsSnapshot {
    pub active_sse_streams: u64,
    pub sse_completed_total: u64,
    pub sse_client_disconnects_total: u64,
    pub sse_recent_disconnects_10m: u64,
    pub sse_upstream_errors_total: u64,
    pub log_queue_depth: u64,
    pub log_written_total: u64,
    pub log_write_batches_total: u64,
    pub log_dropped_total: u64,
    pub log_write_failures_total: u64,
    pub slow_db_operations_total: u64,
    pub cleanup_active: bool,
    pub cleanup_runs_total: u64,
    pub cleanup_errors_total: u64,
    pub cleanup_rows_cleared_total: u64,
    pub cleanup_batches_total: u64,
    pub cleanup_current_rows_cleared: u64,
    pub cleanup_current_batches: u64,
    pub cleanup_last_started_unix_seconds: Option<i64>,
    pub cleanup_last_finished_unix_seconds: Option<i64>,
    pub cleanup_last_duration_ms: Option<u64>,
    pub cleanup_last_rows_cleared: u64,
}

pub struct RuntimeMetrics {
    active_sse_streams: AtomicU64,
    sse_completed_total: AtomicU64,
    sse_client_disconnects_total: AtomicU64,
    sse_upstream_errors_total: AtomicU64,
    log_queue_depth: AtomicU64,
    log_written_total: AtomicU64,
    log_write_batches_total: AtomicU64,
    log_dropped_total: AtomicU64,
    log_write_failures_total: AtomicU64,
    slow_db_operations_total: AtomicU64,
    cleanup_active: AtomicBool,
    cleanup_runs_total: AtomicU64,
    cleanup_errors_total: AtomicU64,
    cleanup_rows_cleared_total: AtomicU64,
    cleanup_batches_total: AtomicU64,
    cleanup_current_rows_cleared: AtomicU64,
    cleanup_current_batches: AtomicU64,
    cleanup_last_started_unix_seconds: AtomicI64,
    cleanup_last_finished_unix_seconds: AtomicI64,
    cleanup_last_duration_ms: AtomicU64,
    cleanup_last_rows_cleared: AtomicU64,
    recent_sse_disconnects: std::sync::Mutex<VecDeque<Instant>>,
}

impl RuntimeMetrics {
    pub fn new() -> Self {
        Self {
            active_sse_streams: AtomicU64::new(0),
            sse_completed_total: AtomicU64::new(0),
            sse_client_disconnects_total: AtomicU64::new(0),
            sse_upstream_errors_total: AtomicU64::new(0),
            log_queue_depth: AtomicU64::new(0),
            log_written_total: AtomicU64::new(0),
            log_write_batches_total: AtomicU64::new(0),
            log_dropped_total: AtomicU64::new(0),
            log_write_failures_total: AtomicU64::new(0),
            slow_db_operations_total: AtomicU64::new(0),
            cleanup_active: AtomicBool::new(false),
            cleanup_runs_total: AtomicU64::new(0),
            cleanup_errors_total: AtomicU64::new(0),
            cleanup_rows_cleared_total: AtomicU64::new(0),
            cleanup_batches_total: AtomicU64::new(0),
            cleanup_current_rows_cleared: AtomicU64::new(0),
            cleanup_current_batches: AtomicU64::new(0),
            cleanup_last_started_unix_seconds: AtomicI64::new(0),
            cleanup_last_finished_unix_seconds: AtomicI64::new(0),
            cleanup_last_duration_ms: AtomicU64::new(0),
            cleanup_last_rows_cleared: AtomicU64::new(0),
            recent_sse_disconnects: std::sync::Mutex::new(VecDeque::new()),
        }
    }

    pub fn start_sse_stream(&self) {
        self.active_sse_streams.fetch_add(1, Ordering::Relaxed);
    }

    pub fn finish_sse_stream(&self) {
        let _ =
            self.active_sse_streams
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_sub(1)
                });
    }

    pub fn record_sse_complete(&self) {
        self.sse_completed_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_sse_client_disconnect(&self) {
        self.sse_client_disconnects_total
            .fetch_add(1, Ordering::Relaxed);
        let mut recent = self
            .recent_sse_disconnects
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        recent.push_back(Instant::now());
        prune_recent_instants(&mut recent, SSE_RECENT_DISCONNECT_WINDOW);
    }

    pub fn record_sse_upstream_error(&self) {
        self.sse_upstream_errors_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_log_enqueue(&self) {
        self.log_queue_depth.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_log_dequeue(&self, count: u64) {
        let _ = self
            .log_queue_depth
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(count))
            });
    }

    pub fn record_log_written(&self, count: u64) {
        if count == 0 {
            return;
        }
        self.log_written_total.fetch_add(count, Ordering::Relaxed);
        self.log_write_batches_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_log_drop(&self) {
        self.log_dropped_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_log_write_failure_count(&self, count: u64) {
        self.log_write_failures_total
            .fetch_add(count, Ordering::Relaxed);
    }

    pub fn record_slow_db_operation(&self) {
        self.slow_db_operations_total
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn begin_cleanup(&self) {
        self.cleanup_active.store(true, Ordering::Relaxed);
        self.cleanup_current_rows_cleared
            .store(0, Ordering::Relaxed);
        self.cleanup_current_batches.store(0, Ordering::Relaxed);
        self.cleanup_last_started_unix_seconds
            .store(unix_seconds_now(), Ordering::Relaxed);
        self.cleanup_runs_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_cleanup_batch(&self, rows_cleared: u64) {
        if rows_cleared == 0 {
            return;
        }
        self.cleanup_current_rows_cleared
            .fetch_add(rows_cleared, Ordering::Relaxed);
        self.cleanup_rows_cleared_total
            .fetch_add(rows_cleared, Ordering::Relaxed);
        self.cleanup_current_batches.fetch_add(1, Ordering::Relaxed);
        self.cleanup_batches_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn finish_cleanup(&self, success: bool, duration: Duration) {
        if !success {
            self.cleanup_errors_total.fetch_add(1, Ordering::Relaxed);
        }
        self.cleanup_last_finished_unix_seconds
            .store(unix_seconds_now(), Ordering::Relaxed);
        self.cleanup_last_duration_ms
            .store(duration.as_millis() as u64, Ordering::Relaxed);
        self.cleanup_last_rows_cleared.store(
            self.cleanup_current_rows_cleared.load(Ordering::Relaxed),
            Ordering::Relaxed,
        );
        self.cleanup_active.store(false, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> RuntimeMetricsSnapshot {
        let recent_disconnects = {
            let mut recent = self
                .recent_sse_disconnects
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            prune_recent_instants(&mut recent, SSE_RECENT_DISCONNECT_WINDOW);
            recent.len() as u64
        };

        RuntimeMetricsSnapshot {
            active_sse_streams: self.active_sse_streams.load(Ordering::Relaxed),
            sse_completed_total: self.sse_completed_total.load(Ordering::Relaxed),
            sse_client_disconnects_total: self.sse_client_disconnects_total.load(Ordering::Relaxed),
            sse_recent_disconnects_10m: recent_disconnects,
            sse_upstream_errors_total: self.sse_upstream_errors_total.load(Ordering::Relaxed),
            log_queue_depth: self.log_queue_depth.load(Ordering::Relaxed),
            log_written_total: self.log_written_total.load(Ordering::Relaxed),
            log_write_batches_total: self.log_write_batches_total.load(Ordering::Relaxed),
            log_dropped_total: self.log_dropped_total.load(Ordering::Relaxed),
            log_write_failures_total: self.log_write_failures_total.load(Ordering::Relaxed),
            slow_db_operations_total: self.slow_db_operations_total.load(Ordering::Relaxed),
            cleanup_active: self.cleanup_active.load(Ordering::Relaxed),
            cleanup_runs_total: self.cleanup_runs_total.load(Ordering::Relaxed),
            cleanup_errors_total: self.cleanup_errors_total.load(Ordering::Relaxed),
            cleanup_rows_cleared_total: self.cleanup_rows_cleared_total.load(Ordering::Relaxed),
            cleanup_batches_total: self.cleanup_batches_total.load(Ordering::Relaxed),
            cleanup_current_rows_cleared: self.cleanup_current_rows_cleared.load(Ordering::Relaxed),
            cleanup_current_batches: self.cleanup_current_batches.load(Ordering::Relaxed),
            cleanup_last_started_unix_seconds: nonzero_i64(
                self.cleanup_last_started_unix_seconds
                    .load(Ordering::Relaxed),
            ),
            cleanup_last_finished_unix_seconds: nonzero_i64(
                self.cleanup_last_finished_unix_seconds
                    .load(Ordering::Relaxed),
            ),
            cleanup_last_duration_ms: nonzero_u64(
                self.cleanup_last_duration_ms.load(Ordering::Relaxed),
            ),
            cleanup_last_rows_cleared: self.cleanup_last_rows_cleared.load(Ordering::Relaxed),
        }
    }
}

fn prune_recent_instants(recent: &mut VecDeque<Instant>, window: Duration) {
    let now = Instant::now();
    let Some(cutoff) = now.checked_sub(window) else {
        return;
    };
    while recent.front().is_some_and(|instant| *instant < cutoff) {
        recent.pop_front();
    }
}

fn nonzero_i64(value: i64) -> Option<i64> {
    (value > 0).then_some(value)
}

fn nonzero_u64(value: u64) -> Option<u64> {
    (value > 0).then_some(value)
}

impl AdminAuthCache {
    pub(crate) fn new() -> Self {
        let mut key = [0_u8; 32];
        OsRng.fill_bytes(&mut key);
        Self {
            key,
            verified: Mutex::new(None),
            #[cfg(test)]
            argon2_verifications: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn fingerprint(&self, token: &str) -> [u8; 32] {
        let mut mac = AdminTokenMac::new_from_slice(&self.key)
            .expect("admin authentication cache key has a valid length");
        mac.update(token.as_bytes());
        mac.finalize().into_bytes().into()
    }

    async fn clear(&self) {
        *self.verified.lock().await = None;
    }
}

/// Application shared state.
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub http_client: reqwest::Client,
    pub settings: Settings,
    pub backoff: Arc<BackoffManager>,
    pub runtime_settings: Arc<RwLock<RuntimeSettings>>,
    /// Current Argon2id credential snapshot. It is published only after a DB commit.
    pub admin_credential: Arc<RwLock<AdminCredential>>,
    /// Commit generation, advanced before publishing a newly committed snapshot.
    /// This closes the commit-to-publication window for newly-started requests.
    pub admin_credential_version: Arc<AtomicI64>,
    pub(crate) admin_auth_cache: Arc<AdminAuthCache>,
    pub runtime_metrics: Arc<RuntimeMetrics>,
    pub log_writer: crate::proxy::logging::LogWriter,
    pub log_stats: Arc<crate::db::log_stats::LogStatsCache>,
    pub started_at: Instant,
}

impl AppState {
    pub async fn authenticate_admin_token(&self, token: String) -> Option<i64> {
        let credential = self.admin_credential.read().await.clone();
        let credential_version = self.admin_credential_version.load(Ordering::Acquire);
        if credential.credential_version != credential_version {
            return None;
        }

        let fingerprint = self.admin_auth_cache.fingerprint(&token);
        let mut cached = self.admin_auth_cache.verified.lock().await;
        if self.admin_credential_version.load(Ordering::Acquire) != credential_version {
            return None;
        }
        if cached.as_ref().is_some_and(|entry| {
            entry.credential_version == credential_version
                && bool::from(entry.fingerprint.ct_eq(&fingerprint))
        }) {
            return Some(credential_version);
        }

        #[cfg(test)]
        self.admin_auth_cache
            .argon2_verifications
            .fetch_add(1, Ordering::Relaxed);
        if !verify_admin_token(credential, token).await
            || self.admin_credential_version.load(Ordering::Acquire) != credential_version
        {
            return None;
        }

        *cached = Some(CachedAdminToken {
            credential_version,
            fingerprint,
        });
        Some(credential_version)
    }

    /// Publish a credential that has already committed to SQLite.
    ///
    /// The atomic generation closes the commit-to-publication window for
    /// authentication. `fetch_max` makes that signal irreversible, while the
    /// lock keeps the credential snapshot itself monotonic when rotations
    /// complete their database work out of order.
    pub async fn publish_admin_credential(&self, credential: AdminCredential) {
        self.admin_credential_version
            .fetch_max(credential.credential_version, Ordering::AcqRel);

        {
            let mut snapshot = self.admin_credential.write().await;
            if credential.credential_version > snapshot.credential_version {
                *snapshot = credential;
            }
        }
        self.admin_auth_cache.clear().await;
    }
}

/// Create database tables and enable WAL mode + foreign keys.
pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("PRAGMA journal_mode=WAL;")
        .execute(pool)
        .await?;

    sqlx::query("PRAGMA foreign_keys=ON;").execute(pool).await?;

    // ---------- upstreams ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS upstreams (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL UNIQUE,
            base_url        TEXT NOT NULL,
            api_key         TEXT,
            model_names     TEXT NOT NULL DEFAULT '[]',
            model_prefixes  TEXT NOT NULL DEFAULT '[]',
            model_mappings  TEXT NOT NULL DEFAULT '{}',
            priority        INTEGER NOT NULL DEFAULT 100,
            enabled         INTEGER NOT NULL DEFAULT 1,
            extra_headers   TEXT NOT NULL DEFAULT '{}',
            timeout_seconds REAL NOT NULL DEFAULT 300.0,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS model_test_prompt_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );"#).execute(pool).await?;
    sqlx::query(r#"INSERT INTO model_test_prompt_templates (name, prompt) VALUES
        ('模型能力概览', '请用中文说明你当前使用的模型名称、两项主要能力，以及用户提交复杂任务时应提供的关键信息。使用自然段，不要使用表格、工具或外部引用。总回复不超过 120 个汉字。'),
        ('代码审查', '请审查以下需求的实现风险：一个 HTTP API 需要支持鉴权、超时、错误处理和请求日志。用三条简短建议说明优先级和原因，不要编造未提供的事实。'),
        ('问题排查', '请给出排查 API 请求失败的步骤。按网络、认证、请求格式、上游响应四个方面排序，每项一句，并说明最先应收集的证据。'),
        ('结构化摘要', '请用三条要点总结：如何把一项复杂工程任务拆分为可验证的步骤。每条不超过 30 个汉字，不要使用表格。'),
        ('中文问答', '请用中文解释为什么客户端超时不一定代表上游服务故障。给出一个简短例子，并说明日志中应重点查看哪些字段。')
        ON CONFLICT(name) DO NOTHING"#).execute(pool).await?;

    // ---------- admin_credential ----------
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS admin_credential (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            credential_hash TEXT NOT NULL,
            credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
            rotated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_upstreams_enabled_priority ON upstreams(enabled, priority, id);",
    )
    .execute(pool)
    .await?;

    // ---------- request_logs ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS request_logs (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            method              TEXT NOT NULL,
            path                TEXT NOT NULL,
            downstream_token_id INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL,
            downstream_token_name TEXT,
            client_type         TEXT NOT NULL DEFAULT 'unknown',
            upstream_id         INTEGER REFERENCES upstreams(id) ON DELETE SET NULL,
            upstream_name       TEXT,
            model               TEXT,
            reasoning_effort    TEXT,
            response_reasoning_effort TEXT,
            stream              INTEGER NOT NULL DEFAULT 0,
            status_code         INTEGER,
            prompt_tokens       INTEGER,
            completion_tokens   INTEGER,
            total_tokens        INTEGER,
            duration_ms         INTEGER,
            first_token_ms      INTEGER,
            error               TEXT,
            downstream_request  TEXT,
            upstream_request    TEXT,
            upstream_response   TEXT,
            downstream_response TEXT
        );
        "#,
    )
    .execute(pool)
    .await?;

    for definition in [
        "downstream_token_id INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL",
        "downstream_token_name TEXT",
        "client_type TEXT NOT NULL DEFAULT 'unknown'",
        "response_reasoning_effort TEXT",
    ] {
        let column = definition
            .split_whitespace()
            .next()
            .expect("column definition must start with a name");
        let exists: Option<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('request_logs') WHERE name = ?")
                .bind(column)
                .fetch_optional(pool)
                .await?;
        if exists.is_none() {
            sqlx::query(&format!("ALTER TABLE request_logs ADD COLUMN {definition}"))
                .execute(pool)
                .await?;
        }
    }

    // ---------- app_migrations ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS app_migrations (
            name       TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await?;

    // These derivations must consume the legacy snapshots before the payload
    // migration clears them from the hot request_logs table.
    backfill_response_reasoning_effort_once(pool).await?;
    backfill_client_type_once(pool).await?;
    migrate_request_log_payloads_once(pool).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_logs_created_at_id_desc ON request_logs(created_at DESC, id DESC);",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at ON request_logs(upstream_id, created_at);",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at_id_desc ON request_logs(upstream_id, created_at DESC, id DESC);",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_log_payloads_bodies_cleared ON request_log_payloads(bodies_cleared, request_log_id);",
    )
    .execute(pool)
    .await?;

    // ---------- api_tokens ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS api_tokens (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            token       TEXT NOT NULL UNIQUE,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await?;

    // ---------- runtime_settings ----------
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS runtime_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            log_body_keep_count INTEGER NOT NULL CHECK (log_body_keep_count BETWEEN 1 AND 10000),
            log_retention_days INTEGER NOT NULL CHECK (log_retention_days BETWEEN 1 AND 3650),
            log_body_max_bytes INTEGER NOT NULL CHECK (log_body_max_bytes BETWEEN 0 AND 1048576),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );"#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO runtime_settings (id, log_body_keep_count, log_retention_days, log_body_max_bytes, revision) VALUES (1, 100, 30, 200000, 1) ON CONFLICT(id) DO NOTHING",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS model_test_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            request_kind TEXT NOT NULL CHECK (request_kind IN ('responses', 'chat_completions')),
            prompt TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );"#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"INSERT INTO model_test_templates (name, request_kind, prompt)
        VALUES
            ('Codex', 'responses', '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。'),
            ('OpenCode', 'chat_completions', '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。')
        ON CONFLICT(name) DO NOTHING"#,
    )
    .execute(pool)
    .await?;
    // Upgrade only the original short defaults; administrator-customized templates remain untouched.
    sqlx::query(
        r#"UPDATE model_test_templates
        SET prompt = '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。', updated_at = datetime('now')
        WHERE name IN ('Codex', 'OpenCode') AND prompt IN ('Reply with exactly: WildToken test passed.', '请用中文完成一次简短的连通性测试。先说明你已收到请求，再用两句话概括：当前模型名称、你能提供的主要能力。不要使用 Markdown 表格，不要调用工具，不要编造外部信息。最后单独输出“WildToken 模型测试通过”，并确保总回复不超过 120 个汉字。')"#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Hash a token with Argon2id on the blocking pool. The plaintext is never persisted.
pub async fn hash_admin_token(token: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        use argon2::{
            password_hash::{rand_core::OsRng, SaltString},
            Argon2, PasswordHasher,
        };
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(token.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| AppError::Internal("could not hash admin credential".into()))
    })
    .await
    .map_err(|_| AppError::Internal("admin credential hashing task failed".into()))?
}

/// Verify an admin token against a credential snapshot without exposing Argon2
/// work on the async runtime.
pub async fn verify_admin_token(credential: AdminCredential, token: String) -> bool {
    tokio::task::spawn_blocking(move || {
        use argon2::{Argon2, PasswordHash, PasswordVerifier};
        PasswordHash::new(&credential.credential_hash)
            .ok()
            .map(|hash| {
                Argon2::default()
                    .verify_password(token.as_bytes(), &hash)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Bootstrap once and return the committed credential snapshot.
pub async fn bootstrap_admin_credential(
    pool: &SqlitePool,
    startup_token: String,
) -> Result<AdminCredential, AppError> {
    if let Some(credential) = settings_db::load_admin_credential(pool).await? {
        return Ok(credential);
    }
    let hash = hash_admin_token(startup_token).await?;
    settings_db::bootstrap_admin_credential(pool, hash).await
}

#[cfg(test)]
mod tests;

/// Load the persisted policy, falling back to safe startup defaults if it is absent or invalid.
pub async fn load_runtime_settings(pool: &SqlitePool) -> RuntimeSettings {
    match settings_db::load_runtime_settings(pool).await {
        Ok(Some(mut settings)) if settings.validate().is_ok() => {
            settings.database_override = true;
            settings
        }
        Ok(Some(_)) => {
            tracing::warn!("runtime_settings contains invalid values; using startup defaults");
            RuntimeSettings::default()
        }
        Ok(None) => {
            tracing::warn!("runtime_settings row is missing; using startup defaults");
            RuntimeSettings::default()
        }
        Err(error) => {
            tracing::warn!(
                ?error,
                "could not load runtime_settings; using startup defaults"
            );
            RuntimeSettings::default()
        }
    }
}
