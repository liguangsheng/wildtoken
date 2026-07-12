use serde::{Deserialize, Serialize};

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
