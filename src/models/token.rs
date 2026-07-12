use serde::{Deserialize, Serialize};

// ── DB row ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ApiTokenRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub token: String,
    pub enabled: i64, // 0 / 1
    pub created_at: String,
    pub updated_at: String,
}

// ── Input model ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ApiTokenIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// If None, a token will be auto-generated.
    pub token: Option<String>,
}

// ── Output models ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ApiTokenOut {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub token_preview: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Created on first creation – includes the full token value (shown once).
#[derive(Debug, Clone, Serialize)]
pub struct ApiTokenDetailOut {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub token: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}
