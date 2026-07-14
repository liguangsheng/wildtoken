use config::{Config, ConfigError, Environment, File};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub server: ServerSettings,
    pub database: DatabaseSettings,
    pub logging: LoggingSettings,
    pub upstream: UpstreamSettings,
    pub admin: AdminSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ServerSettings {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct DatabaseSettings {
    pub url: String,
    pub max_connections: u32,
    pub sqlite_cache_size_kib: i64,
    pub sqlite_statement_cache_capacity: usize,
    pub sqlite_mmap_size_bytes: i64,
    pub idle_timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct LoggingSettings {
    pub log_queue_capacity: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct UpstreamSettings {
    pub default_timeout_seconds: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct AdminSettings {
    pub token: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: ServerSettings::default(),
            database: DatabaseSettings::default(),
            logging: LoggingSettings::default(),
            upstream: UpstreamSettings::default(),
            admin: AdminSettings::default(),
        }
    }
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".into(),
            port: 3100,
        }
    }
}

impl Default for DatabaseSettings {
    fn default() -> Self {
        Self {
            url: "sqlite:wildtoken.db?mode=rwc".into(),
            max_connections: 3,
            sqlite_cache_size_kib: 2048,
            sqlite_statement_cache_capacity: 32,
            sqlite_mmap_size_bytes: 0,
            idle_timeout_seconds: 60,
        }
    }
}

impl Default for LoggingSettings {
    fn default() -> Self {
        Self {
            log_queue_capacity: 512,
        }
    }
}

impl Default for UpstreamSettings {
    fn default() -> Self {
        Self {
            default_timeout_seconds: 300.0,
        }
    }
}

impl Default for AdminSettings {
    fn default() -> Self {
        Self {
            token: "change-me".into(),
        }
    }
}

impl Settings {
    pub fn load() -> Result<Self, ConfigError> {
        dotenvy::dotenv().ok();

        let run_env = std::env::var("RUN_ENV").unwrap_or_else(|_| "development".into());

        let mut settings: Settings = Config::builder()
            .add_source(File::with_name("config/default").required(false))
            .add_source(File::with_name(&format!("config/{}", run_env)).required(false))
            .add_source(Environment::with_prefix("APP").separator("__"))
            .build()?
            .try_deserialize()
            .unwrap_or_default();

        // Compatibility with legacy .env variables
        if let Ok(token) = std::env::var("ADMIN_TOKEN") {
            if !token.is_empty() {
                settings.admin.token = token;
            }
        }
        if let Ok(url) = std::env::var("DATABASE_URL") {
            if !url.is_empty() {
                settings.database.url = url;
            }
        }

        Ok(settings)
    }
}
