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
}

#[derive(Debug, Serialize)]
pub struct AdminTokenRotateOut {
    pub token: String,
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

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct RuntimeSettings {
    pub log_body_keep_count: i64,
    pub log_retention_days: i64,
    pub log_body_max_bytes: i64,
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
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSettingsIn {
    pub log_body_keep_count: i64,
    pub log_retention_days: i64,
    pub log_body_max_bytes: i64,
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

        assert!(RuntimeSettingsIn {
            log_body_keep_count: 100,
            log_retention_days: 30,
            log_body_max_bytes: 200_000,
            revision: 0,
        }
        .validate()
        .is_err());
    }
}
