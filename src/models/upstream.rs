use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── DB row ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UpstreamRow {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model_names: String,    // JSON array string "[]"
    pub model_prefixes: String, // JSON array string "[]"
    pub model_mappings: String, // JSON object string "{}"
    pub priority: i32,
    pub weight: i64,
    pub auto_weight_enabled: i64, // 0 or 1
    pub enabled: i64,             // 0 or 1
    pub extra_headers: String,    // JSON object string "{}"
    pub timeout_seconds: f64,
    pub created_at: String,
    pub updated_at: String,
}

// ── Input models ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamIn {
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model_names: Vec<String>,
    #[serde(default)]
    pub model_prefixes: Vec<String>,
    #[serde(default)]
    pub model_mappings: HashMap<String, String>,
    #[serde(default = "default_priority")]
    pub priority: i32,
    #[serde(default = "default_weight")]
    pub weight: i64,
    #[serde(default = "default_enabled")]
    pub auto_weight_enabled: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub extra_headers: HashMap<String, String>,
    #[serde(default)]
    pub timeout_seconds: Option<f64>,
}

fn default_priority() -> i32 {
    100
}

fn default_weight() -> i64 {
    100
}

fn default_enabled() -> bool {
    true
}

impl UpstreamIn {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(0..=10_000).contains(&self.weight) {
            return Err("weight must be between 0 and 10000");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamUpdate {
    #[serde(flatten)]
    pub base: UpstreamIn,
    #[serde(default)]
    pub clear_api_key: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamEnabledIn {
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamPriorityIn {
    pub priority: i32,
}

// ── Output models ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct UpstreamOut {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub api_key_set: bool,
    pub model_names: Vec<String>,
    pub model_prefixes: Vec<String>,
    pub model_mappings: HashMap<String, String>,
    pub priority: i32,
    pub weight: i64,
    pub auto_weight_enabled: bool,
    pub enabled: bool,
    pub extra_headers: HashMap<String, String>,
    pub timeout_seconds: f64,
    pub created_at: String,
    pub updated_at: String,
    pub runtime_health_score: i64,
    pub effective_weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_recovery_remaining_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpstreamDetailOut {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub api_key_set: bool,
    pub model_names: Vec<String>,
    pub model_prefixes: Vec<String>,
    pub model_mappings: HashMap<String, String>,
    pub priority: i32,
    pub weight: i64,
    pub auto_weight_enabled: bool,
    pub enabled: bool,
    pub extra_headers: HashMap<String, String>,
    pub timeout_seconds: f64,
    pub created_at: String,
    pub updated_at: String,
    pub runtime_health_score: i64,
    pub effective_weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_recovery_remaining_seconds: Option<i64>,
}
