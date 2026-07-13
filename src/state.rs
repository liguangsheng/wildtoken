use std::{
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Instant,
};

use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::config::Settings;
use crate::error::AppError;
use crate::proxy::matcher::BackoffManager;
use crate::{
    db::settings as settings_db,
    models::settings::{AdminCredential, RuntimeSettings},
};

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
    pub started_at: Instant,
}

impl AppState {
    /// Publish a credential that has already committed to SQLite.
    ///
    /// The atomic generation closes the commit-to-publication window for
    /// authentication. `fetch_max` makes that signal irreversible, while the
    /// lock keeps the credential snapshot itself monotonic when rotations
    /// complete their database work out of order.
    pub async fn publish_admin_credential(&self, credential: AdminCredential) {
        self.admin_credential_version
            .fetch_max(credential.credential_version, Ordering::AcqRel);

        let mut snapshot = self.admin_credential.write().await;
        if credential.credential_version > snapshot.credential_version {
            *snapshot = credential;
        }
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
    ] {
        let column = definition
            .split_whitespace()
            .next()
            .expect("column definition must start with a name");
        let exists: Option<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_info('request_logs') WHERE name = ?",
        )
        .bind(column)
        .fetch_optional(pool)
        .await?;
        if exists.is_none() {
            sqlx::query(&format!("ALTER TABLE request_logs ADD COLUMN {definition}"))
                .execute(pool)
                .await?;
        }
    }

    sqlx::query(
        r#"UPDATE request_logs
           SET client_type = CASE
               WHEN LOWER(CASE WHEN json_valid(downstream_request) THEN COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '') ELSE '' END) LIKE '%opencode%' THEN 'opencode'
               WHEN LOWER(CASE WHEN json_valid(downstream_request) THEN COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '') ELSE '' END) LIKE '%codex%' THEN 'codex'
               WHEN path = 'messages'
                 OR LOWER(CASE WHEN json_valid(downstream_request) THEN COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '') ELSE '' END) LIKE '%claude%'
                 OR LOWER(CASE WHEN json_valid(downstream_request) THEN COALESCE(json_extract(downstream_request, '$.headers.anthropic-version'), '') ELSE '' END) <> '' THEN 'claude'
               ELSE 'unknown'
           END
           WHERE json_valid(downstream_request)"#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at ON request_logs(upstream_id, created_at);",
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
mod tests {
    use std::{sync::atomic::AtomicI64, sync::Arc, time::Instant};

    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    use sqlx::SqlitePool;
    use tokio::sync::RwLock;

    use crate::{
        config::Settings,
        models::settings::{AdminCredential, RuntimeSettings},
        proxy::matcher::BackoffManager,
    };

    use super::{hash_admin_token, init_db, verify_admin_token, AppState};

    fn state_with_credential(credential: AdminCredential) -> AppState {
        AppState {
            db: SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
            http_client: reqwest::Client::new(),
            settings: Settings::default(),
            backoff: Arc::new(BackoffManager::new()),
            runtime_settings: Arc::new(RwLock::new(RuntimeSettings::default())),
            admin_credential_version: Arc::new(AtomicI64::new(credential.credential_version)),
            admin_credential: Arc::new(RwLock::new(credential)),
            started_at: Instant::now(),
        }
    }

    #[tokio::test]
    async fn initialization_does_not_overwrite_existing_runtime_settings() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        init_db(&pool).await.unwrap();
        sqlx::query(
            "UPDATE runtime_settings SET log_body_keep_count = 42, revision = 7 WHERE id = 1",
        )
        .execute(&pool)
        .await
        .unwrap();

        init_db(&pool).await.unwrap();

        let row: (i64, i64) = sqlx::query_as(
            "SELECT log_body_keep_count, revision FROM runtime_settings WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, (42, 7));
    }

    #[tokio::test]
    async fn generated_argon2_hash_verifies_only_its_token() {
        let hash = hash_admin_token("test-token-not-a-deployment-secret".into())
            .await
            .unwrap();
        assert!(hash.starts_with("$argon2id$"));
        let parsed = PasswordHash::new(&hash).unwrap();
        assert!(Argon2::default()
            .verify_password(b"test-token-not-a-deployment-secret", &parsed)
            .is_ok());
        assert!(Argon2::default()
            .verify_password(b"wrong-token", &parsed)
            .is_err());
    }

    #[tokio::test]
    async fn credential_publication_never_reverts_to_an_older_version() {
        let state = state_with_credential(AdminCredential {
            credential_hash: "version-one".into(),
            credential_version: 1,
        });
        let version_three = AdminCredential {
            credential_hash: "version-three".into(),
            credential_version: 3,
        };
        let version_two = AdminCredential {
            credential_hash: "version-two".into(),
            credential_version: 2,
        };

        state.publish_admin_credential(version_three).await;
        state.publish_admin_credential(version_two).await;

        let published = state.admin_credential.read().await;
        assert_eq!(published.credential_version, 3);
        assert_eq!(published.credential_hash, "version-three");
        assert_eq!(
            state
                .admin_credential_version
                .load(std::sync::atomic::Ordering::Acquire),
            3
        );
    }

    #[tokio::test]
    async fn published_rotation_rejects_the_old_token_and_accepts_the_new_one() {
        let old_token = "old-admin-token".to_string();
        let new_token = "new-admin-token".to_string();
        let state = state_with_credential(AdminCredential {
            credential_hash: hash_admin_token(old_token.clone()).await.unwrap(),
            credential_version: 1,
        });

        state
            .publish_admin_credential(AdminCredential {
                credential_hash: hash_admin_token(new_token.clone()).await.unwrap(),
                credential_version: 2,
            })
            .await;

        let published = state.admin_credential.read().await.clone();
        assert!(!verify_admin_token(published.clone(), old_token).await);
        assert!(verify_admin_token(published, new_token).await);
    }
}

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
