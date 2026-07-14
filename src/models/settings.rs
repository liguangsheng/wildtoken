use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ModelTestTemplate {
    pub id: i64,
    pub name: String,
    pub request_kind: String,
    pub prompt: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelTestTemplateIn {
    pub name: String,
    pub request_kind: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelTestRequest {
    pub model: String,
    pub wrapper_id: i64,
    pub prompt_template_id: i64,
    #[serde(default)]
    pub prompt: String,
}

impl ModelTestRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.model.trim().is_empty() || self.model.len() > 500 {
            return Err("model must be between 1 and 500 bytes");
        }
        if self.wrapper_id < 1 || self.prompt_template_id < 1 {
            return Err("wrapper_id and prompt_template_id must be positive");
        }
        if self.prompt.len() > 20_000 {
            return Err("prompt must be at most 20000 bytes");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ModelTestPromptTemplate {
    pub id: i64,
    pub name: String,
    pub prompt: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelTestPromptTemplateIn {
    pub name: String,
    pub prompt: String,
}

impl ModelTestPromptTemplateIn {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.name.trim().is_empty() || self.name.chars().count() > 80 {
            return Err("prompt template name must be between 1 and 80 characters");
        }
        if self.prompt.trim().is_empty() || self.prompt.len() > 20_000 {
            return Err("prompt template prompt must be between 1 and 20000 bytes");
        }
        Ok(())
    }
}

impl ModelTestTemplateIn {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.name.trim().is_empty() || self.name.chars().count() > 80 {
            return Err("template name must be between 1 and 80 characters");
        }
        if !matches!(self.request_kind.as_str(), "responses" | "chat_completions") {
            return Err("request_kind must be responses or chat_completions");
        }
        if self.prompt.trim().is_empty() || self.prompt.len() > 20_000 {
            return Err("template prompt must be between 1 and 20000 bytes");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AdminCredential {
    pub credential_hash: String,
    pub credential_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminTokenRotateIn {
    #[serde(default)]
    pub confirm: bool,
    pub token: String,
}

impl AdminTokenRotateIn {
    pub fn validated_token(&self) -> Result<&str, &'static str> {
        let token = self.token.trim();
        if !(8..=256).contains(&token.len()) {
            return Err("admin token must be between 8 and 256 bytes");
        }
        if !token.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err("admin token must contain only printable ASCII characters without spaces");
        }
        Ok(token)
    }
}

#[derive(Debug, Serialize)]
pub struct RuntimeLogSettingsSummary {
    pub log_body_keep_count: i64,
    pub log_retention_days: i64,
    pub log_body_max_bytes: i64,
    pub revision: i64,
}

#[derive(Debug, Serialize)]
pub struct RuntimeCleanupMetricsOut {
    pub active: bool,
    pub runs_total: u64,
    pub errors_total: u64,
    pub rows_cleared_total: u64,
    pub batches_total: u64,
    pub current_rows_cleared: u64,
    pub current_batches: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_started_unix_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_finished_unix_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_duration_ms: Option<u64>,
    pub last_rows_cleared: u64,
}

#[derive(Debug, Serialize)]
pub struct RuntimeMetricsOut {
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
    pub cleanup: RuntimeCleanupMetricsOut,
}

#[derive(Debug, Serialize)]
pub struct SystemInfoOut {
    pub service: &'static str,
    pub version: &'static str,
    pub default_upstream_timeout_seconds: f64,
    pub uptime_seconds: u64,
    pub current_server_time: String,
    pub database_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_allocated_bytes: Option<i64>,
    pub total_log_count: i64,
    pub log_count_24h: i64,
    pub enabled_upstream_count: i64,
    pub total_upstream_count: i64,
    pub recent_one_minute_log_count: i64,
    pub runtime_log_settings: RuntimeLogSettingsSummary,
    pub runtime_metrics: RuntimeMetricsOut,
}

pub const DEFAULT_LOG_BODY_KEEP_COUNT: i64 = 100;
pub const DEFAULT_LOG_RETENTION_DAYS: i64 = 30;
pub const DEFAULT_LOG_BODY_MAX_BYTES: i64 = 200_000;
pub const DEFAULT_MAX_RETRIES: i64 = 1;
pub const DEFAULT_SAME_UPSTREAM_RETRY_INTERVAL_MS: i64 = 1_000;
pub const DEFAULT_AUTO_WEIGHT_FAILURE_PENALTY: i64 = 20;
pub const DEFAULT_AUTO_WEIGHT_SUCCESS_INCREMENT: i64 = 5;
pub const DEFAULT_AUTO_WEIGHT_RECOVERY_INCREMENT: i64 = 10;
pub const DEFAULT_AUTO_WEIGHT_RECOVERY_INTERVAL_SECONDS: i64 = 60;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RuntimeSettings {
    pub log_body_keep_count: i64,
    pub log_retention_days: i64,
    pub log_body_max_bytes: i64,
    pub max_retries: i64,
    pub same_upstream_retry_interval_ms: i64,
    pub auto_weight_failure_penalty: i64,
    pub auto_weight_success_increment: i64,
    pub auto_weight_recovery_increment: i64,
    pub auto_weight_recovery_interval_seconds: i64,
    pub revision: i64,
    pub updated_at: String,
    #[sqlx(skip)]
    #[serde(skip_serializing)]
    pub database_override: bool,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            log_body_keep_count: DEFAULT_LOG_BODY_KEEP_COUNT,
            log_retention_days: DEFAULT_LOG_RETENTION_DAYS,
            log_body_max_bytes: DEFAULT_LOG_BODY_MAX_BYTES,
            max_retries: DEFAULT_MAX_RETRIES,
            same_upstream_retry_interval_ms: DEFAULT_SAME_UPSTREAM_RETRY_INTERVAL_MS,
            auto_weight_failure_penalty: DEFAULT_AUTO_WEIGHT_FAILURE_PENALTY,
            auto_weight_success_increment: DEFAULT_AUTO_WEIGHT_SUCCESS_INCREMENT,
            auto_weight_recovery_increment: DEFAULT_AUTO_WEIGHT_RECOVERY_INCREMENT,
            auto_weight_recovery_interval_seconds: DEFAULT_AUTO_WEIGHT_RECOVERY_INTERVAL_SECONDS,
            revision: 0,
            updated_at: String::new(),
            database_override: false,
        }
    }
}

impl RuntimeSettings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=10_000).contains(&self.log_body_keep_count) {
            return Err("log_body_keep_count must be between 1 and 10000");
        }
        if !(1..=3650).contains(&self.log_retention_days) {
            return Err("log_retention_days must be between 1 and 3650");
        }
        if !(0..=1_048_576).contains(&self.log_body_max_bytes) {
            return Err("log_body_max_bytes must be between 0 and 1048576");
        }
        if !(0..=5).contains(&self.max_retries) {
            return Err("max_retries must be between 0 and 5");
        }
        if !(0..=60_000).contains(&self.same_upstream_retry_interval_ms) {
            return Err("same_upstream_retry_interval_ms must be between 0 and 60000");
        }
        if !(0..=100).contains(&self.auto_weight_failure_penalty) {
            return Err("auto_weight_failure_penalty must be between 0 and 100");
        }
        if !(0..=100).contains(&self.auto_weight_success_increment) {
            return Err("auto_weight_success_increment must be between 0 and 100");
        }
        if !(0..=100).contains(&self.auto_weight_recovery_increment) {
            return Err("auto_weight_recovery_increment must be between 0 and 100");
        }
        if !(1..=3_600).contains(&self.auto_weight_recovery_interval_seconds) {
            return Err("auto_weight_recovery_interval_seconds must be between 1 and 3600");
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSettingsIn {
    pub log_body_keep_count: i64,
    pub log_retention_days: i64,
    pub log_body_max_bytes: i64,
    pub max_retries: i64,
    pub same_upstream_retry_interval_ms: i64,
    pub auto_weight_failure_penalty: i64,
    pub auto_weight_success_increment: i64,
    pub auto_weight_recovery_increment: i64,
    pub auto_weight_recovery_interval_seconds: i64,
    pub revision: i64,
}

impl RuntimeSettingsIn {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.revision < 1 {
            return Err("revision must be at least 1");
        }
        RuntimeSettings {
            log_body_keep_count: self.log_body_keep_count,
            log_retention_days: self.log_retention_days,
            log_body_max_bytes: self.log_body_max_bytes,
            max_retries: self.max_retries,
            same_upstream_retry_interval_ms: self.same_upstream_retry_interval_ms,
            auto_weight_failure_penalty: self.auto_weight_failure_penalty,
            auto_weight_success_increment: self.auto_weight_success_increment,
            auto_weight_recovery_increment: self.auto_weight_recovery_increment,
            auto_weight_recovery_interval_seconds: self.auto_weight_recovery_interval_seconds,
            ..Default::default()
        }
        .validate()
    }
}

#[derive(Debug, Serialize)]
pub struct RuntimeSettingsOut {
    pub log_body_keep_count: i64,
    pub log_retention_days: i64,
    pub log_body_max_bytes: i64,
    pub max_retries: i64,
    pub same_upstream_retry_interval_ms: i64,
    pub auto_weight_failure_penalty: i64,
    pub auto_weight_success_increment: i64,
    pub auto_weight_recovery_increment: i64,
    pub auto_weight_recovery_interval_seconds: i64,
    pub revision: i64,
    pub updated_at: String,
    pub database_override: bool,
}

impl From<&RuntimeSettings> for RuntimeSettingsOut {
    fn from(value: &RuntimeSettings) -> Self {
        Self {
            log_body_keep_count: value.log_body_keep_count,
            log_retention_days: value.log_retention_days,
            log_body_max_bytes: value.log_body_max_bytes,
            max_retries: value.max_retries,
            same_upstream_retry_interval_ms: value.same_upstream_retry_interval_ms,
            auto_weight_failure_penalty: value.auto_weight_failure_penalty,
            auto_weight_success_increment: value.auto_weight_success_increment,
            auto_weight_recovery_increment: value.auto_weight_recovery_increment,
            auto_weight_recovery_interval_seconds: value.auto_weight_recovery_interval_seconds,
            revision: value.revision,
            updated_at: value.updated_at.clone(),
            database_override: value.database_override,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_runtime_setting_boundaries() {
        assert!(RuntimeSettings::default().validate().is_ok());
        assert!(RuntimeSettings {
            log_body_keep_count: 0,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(RuntimeSettings {
            log_retention_days: 3651,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(RuntimeSettings {
            log_body_max_bytes: 1_048_577,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(RuntimeSettings {
            log_body_max_bytes: 0,
            ..Default::default()
        }
        .validate()
        .is_ok());
        assert!(RuntimeSettings {
            max_retries: 6,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(RuntimeSettings {
            same_upstream_retry_interval_ms: 60_001,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(RuntimeSettings {
            auto_weight_failure_penalty: 101,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(RuntimeSettings {
            auto_weight_recovery_interval_seconds: 0,
            ..Default::default()
        }
        .validate()
        .is_err());

        assert!(RuntimeSettingsIn {
            log_body_keep_count: 100,
            log_retention_days: 30,
            log_body_max_bytes: 200_000,
            max_retries: 1,
            same_upstream_retry_interval_ms: 1_000,
            auto_weight_failure_penalty: 20,
            auto_weight_success_increment: 5,
            auto_weight_recovery_increment: 10,
            auto_weight_recovery_interval_seconds: 60,
            revision: 0,
        }
        .validate()
        .is_err());
    }

    #[test]
    fn validates_user_supplied_admin_tokens() {
        let input = AdminTokenRotateIn {
            confirm: true,
            token: "  user-chosen-admin-token  ".into(),
        };
        assert_eq!(input.validated_token().unwrap(), "user-chosen-admin-token");

        for token in ["short", "contains space", "含中文的管理员令牌"] {
            assert!(AdminTokenRotateIn {
                confirm: true,
                token: token.into(),
            }
            .validated_token()
            .is_err());
        }

        assert!(AdminTokenRotateIn {
            confirm: true,
            token: "x".repeat(257),
        }
        .validated_token()
        .is_err());
    }
}
