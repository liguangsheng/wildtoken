use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct RequestLogRow {
    pub id: i64,
    pub created_at: String,
    pub method: String,
    pub path: String,
    pub downstream_token_id: Option<i64>,
    pub downstream_token_name: Option<String>,
    pub client_type: String,
    pub upstream_id: Option<i64>,
    pub upstream_name: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub response_reasoning_effort: Option<String>,
    pub stream: i32,
    pub status_code: Option<i32>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub total_tokens: Option<i32>,
    pub duration_ms: Option<i32>,
    pub first_token_ms: Option<i32>,
    pub error: Option<String>,
    pub downstream_request: Option<String>,
    pub upstream_request: Option<String>,
    pub upstream_response: Option<String>,
    pub downstream_response: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogOut {
    pub id: i64,
    pub created_at: String,
    pub method: String,
    pub path: String,
    pub downstream_token_id: Option<i64>,
    pub downstream_token_name: Option<String>,
    pub client_type: String,
    pub upstream_id: Option<i64>,
    pub upstream_name: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub response_reasoning_effort: Option<String>,
    pub stream: i32,
    pub status_code: Option<i32>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub total_tokens: Option<i32>,
    pub duration_ms: Option<i32>,
    pub first_token_ms: Option<i32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogDetailOut {
    #[serde(flatten)]
    pub base: RequestLogOut,
    pub downstream_request: Option<serde_json::Value>,
    pub upstream_request: Option<serde_json::Value>,
    pub upstream_response: Option<serde_json::Value>,
    pub downstream_response: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogPage {
    pub items: Vec<RequestLogOut>,
    pub has_more: bool,
    pub recent_rpm: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageWindowOut {
    pub total_tokens: i64,
    pub request_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageStatsOut {
    pub today: TokenUsageWindowOut,
    pub one_day: TokenUsageWindowOut,
    pub seven_days: TokenUsageWindowOut,
    pub thirty_days: TokenUsageWindowOut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyError {
    pub error: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestRequest {
    #[serde(default = "default_path")]
    pub path: String,
}

fn default_path() -> String {
    "/v1/models".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListOut {
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFetchIn {
    pub base_url: String,

    #[serde(default)]
    pub api_key: Option<String>,

    #[serde(default)]
    pub extra_headers: Option<HashMap<String, String>>,

    #[serde(default)]
    pub timeout_seconds: Option<f64>,
}
