use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::models::upstream::UpstreamRow;

// ── Backoff ──────────────────────────────────────────────────────────────────

pub const BACKOFF_INITIAL_SECONDS: u64 = 60;
pub const BACKOFF_STEP_SECONDS: u64 = 60;
pub const BACKOFF_MAX_SECONDS: u64 = 300;
pub const AUTO_DISABLE_STATUS_CODES: [u16; 3] = [401, 402, 403];

struct BackoffState {
    until: Instant,
    step: u32,
}

pub struct BackoffManager {
    backoffs: Mutex<HashMap<i64, BackoffState>>,
}

impl BackoffManager {
    pub fn new() -> Self {
        Self {
            backoffs: Mutex::new(HashMap::new()),
        }
    }

    /// Check whether an upstream is currently in back-off.
    pub fn is_backed_off(&self, upstream_id: i64) -> bool {
        let guard = self.backoffs.lock().unwrap();
        match guard.get(&upstream_id) {
            Some(state) => Instant::now() < state.until,
            None => false,
        }
    }

    /// Record a failure – increase the back-off duration.
    pub fn record_failure(&self, upstream_id: i64) {
        let mut guard = self.backoffs.lock().unwrap();
        let entry = guard.entry(upstream_id).or_insert_with(|| BackoffState {
            until: Instant::now(),
            step: 0,
        });

        entry.step += 1;
        let seconds = std::cmp::min(
            BACKOFF_INITIAL_SECONDS + (entry.step as u64 - 1) * BACKOFF_STEP_SECONDS,
            BACKOFF_MAX_SECONDS,
        );
        entry.until = Instant::now() + Duration::from_secs(seconds);
    }

    /// Clear back-off after a successful request.
    pub fn record_success(&self, upstream_id: i64) {
        let mut guard = self.backoffs.lock().unwrap();
        guard.remove(&upstream_id);
    }

    /// Returns the remaining back-off seconds, if any.
    pub fn backoff_remaining_seconds(&self, upstream_id: i64) -> Option<i64> {
        let guard = self.backoffs.lock().unwrap();
        guard.get(&upstream_id).and_then(|state| {
            let now = Instant::now();
            if now < state.until {
                Some((state.until - now).as_secs() as i64)
            } else {
                None
            }
        })
    }
}

// ── Model matching ───────────────────────────────────────────────────────────

/// Normalize a model name: trim whitespace and lowercase.
fn normalize_model_match(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Return a match score 0–4.
///
/// - 4: exact match in `model_mappings`
/// - 3: prefix match in `model_prefixes`
/// - 2: any candidate in `model_names` starts with the requested model
/// - 1: any candidate in `model_names` ends with the requested model
/// - 0: no match
pub fn model_match_score(upstream: &UpstreamRow, model: Option<&str>) -> i32 {
    let model = match model {
        Some(m) => m,
        None => return 0,
    };

    let req = normalize_model_match(model);

    // 4: exact match in model_mappings
    if let Ok(map) =
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&upstream.model_mappings)
    {
        for key in map.keys() {
            if normalize_model_match(key) == req {
                return 4;
            }
        }
    }

    // 3: prefix match in model_prefixes
    if let Ok(prefixes) = serde_json::from_str::<Vec<String>>(&upstream.model_prefixes) {
        for prefix in &prefixes {
            if req.starts_with(&normalize_model_match(prefix)) {
                return 3;
            }
        }
    }

    // 2: candidate starts with request
    // 1: candidate ends with request
    if let Ok(names) = serde_json::from_str::<Vec<String>>(&upstream.model_names) {
        let mut best = 0i32;
        for name in &names {
            let n = normalize_model_match(name);
            if n == req {
                // exact name match → score 2 (falls under starts-with)
                best = best.max(2);
            } else if n.starts_with(&req) {
                best = best.max(2);
            } else if n.ends_with(&req) {
                best = best.max(1);
            }
        }
        return best;
    }

    0
}

/// Check whether the upstream supports the given model.
pub fn match_model(upstream: &UpstreamRow, model: Option<&str>) -> bool {
    model.is_none_or(|model| model_match_score(upstream, Some(model)) > 0)
}

/// Select the forward model name.
///
/// 1. If there is an exact mapping key → return the mapped value.
/// 2. Else if a model_names candidate starts with / equals the request → return that candidate.
/// 3. Else if a model_names candidate ends with the request → return that candidate.
/// 4. Otherwise fall back to the original model.
pub fn select_forward_model(
    upstream: &UpstreamRow,
    requested_model: Option<&str>,
) -> Option<String> {
    let model = requested_model?;
    let req = normalize_model_match(model);

    // 1. check mappings
    if let Ok(map) =
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&upstream.model_mappings)
    {
        for (key, val) in map.iter() {
            if normalize_model_match(key) == req {
                // prefer the string value
                if let Some(s) = val.as_str() {
                    return Some(s.to_string());
                }
            }
        }
    }

    // 2. check model_names — starts_with / exact first (higher priority)
    if let Ok(names) = serde_json::from_str::<Vec<String>>(&upstream.model_names) {
        for name in &names {
            let n = normalize_model_match(name);
            if n.starts_with(&req) || n == req {
                return Some(name.clone());
            }
        }
        // 3. ends_with fallback (matches Python select_forward_model)
        for name in &names {
            let n = normalize_model_match(name);
            if !n.is_empty() && n.ends_with(&req) {
                return Some(name.clone());
            }
        }
    }

    // 4. fallback
    Some(model.to_string())
}

// ── Upstream selection ───────────────────────────────────────────────────────

use crate::db;
use crate::error::AppError;
use rand::prelude::SliceRandom;

/// Core upstream selection.
///
/// 1. Direct selection via `x-wildtoken-upstream` header or `upstream` query param
///    (value can be an id or a name).
/// 2. Otherwise fetch all enabled upstreams.
/// 3. Filter by model match score, keeping only those with the highest score.
/// 4. Group by priority and randomly pick within the highest-priority group.
///    Prefer non-back-off upstreams, but fall back to backed-off candidates
///    when no other matching enabled upstream is available.
pub async fn select_upstream(
    pool: &sqlx::SqlitePool,
    backoff: &BackoffManager,
    upstream_selector: Option<&str>,
    model: Option<&str>,
) -> Result<Option<(UpstreamRow, Option<String>)>, AppError> {
    // ── Direct selection ─────────────────────────────────────────────────
    if let Some(selector) = upstream_selector {
        // Try as id first
        if let Ok(id) = selector.parse::<i64>() {
            let row = db::upstream::get_upstream(pool, id).await?;
            if let Some(upstream) = row {
                if upstream.enabled == 1 && match_model(&upstream, model) {
                    let fwd = select_forward_model(&upstream, model);
                    return Ok(Some((upstream, fwd)));
                }
            }
        }

        // Then try as name
        let row = db::upstream::get_upstream_by_name(pool, selector).await?;
        if let Some(upstream) = row {
            if upstream.enabled == 1 && match_model(&upstream, model) {
                let fwd = select_forward_model(&upstream, model);
                return Ok(Some((upstream, fwd)));
            }
        }

        return Ok(None);
    }

    // ── Pool-based selection ─────────────────────────────────────────────
    let all = db::upstream::list_enabled_upstreams(pool).await?;
    if all.is_empty() {
        return Ok(None);
    }

    // Filter by model score
    let mut scored: Vec<(&UpstreamRow, i32)> = all
        .iter()
        .map(|u| (u, model_match_score(u, model)))
        .collect();

    if let Some(_) = model {
        // keep the best score
        let best = scored.iter().map(|(_, s)| *s).max().unwrap_or(0);
        if best <= 0 {
            return Ok(None);
        }
        scored.retain(|(_, s)| *s == best);
    }

    // Prefer healthy candidates. A backed-off upstream remains a last-resort
    // route so a temporary back-off never turns an otherwise usable pool into
    // "no upstream available".
    let mut available_by_priority: HashMap<i32, Vec<&UpstreamRow>> = HashMap::new();
    let mut backed_off_by_priority: HashMap<i32, Vec<&UpstreamRow>> = HashMap::new();
    for (up, _) in &scored {
        if backoff.is_backed_off(up.id) {
            backed_off_by_priority
                .entry(up.priority)
                .or_default()
                .push(up);
        } else {
            available_by_priority
                .entry(up.priority)
                .or_default()
                .push(up);
        }
    }

    let candidates_by_priority = if available_by_priority.is_empty() {
        &backed_off_by_priority
    } else {
        &available_by_priority
    };
    if candidates_by_priority.is_empty() {
        return Ok(None);
    }

    // Pick the highest priority within the preferred candidate set.
    let max_priority = candidates_by_priority.keys().max().copied().unwrap();
    let candidates = candidates_by_priority.get(&max_priority).unwrap();

    // Random choice within the group
    let chosen = candidates.choose(&mut rand::thread_rng()).unwrap();

    let fwd = select_forward_model(chosen, model);

    Ok(Some(((*chosen).clone(), fwd)))
}

#[cfg(test)]
mod tests {
    use super::{select_upstream, BackoffManager};
    use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE upstreams (
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
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn insert_upstream(pool: &SqlitePool, name: &str, model_names: &[&str], priority: i32) {
        sqlx::query(
            r#"
            INSERT INTO upstreams
                (name, base_url, model_names, model_prefixes, model_mappings,
                 priority, enabled, extra_headers, timeout_seconds)
            VALUES (?, 'https://example.test', ?, '[]', '{}', ?, 1, '{}', 300.0)
            "#,
        )
        .bind(name)
        .bind(serde_json::to_string(model_names).unwrap())
        .bind(priority)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn pool_selection_rejects_only_enabled_channel_when_model_does_not_match() {
        let pool = test_pool().await;
        insert_upstream(&pool, "deepseek-only", &["DeepSeek-V4-Flash"], 100).await;

        let selected = select_upstream(&pool, &BackoffManager::new(), None, Some("gpt-5.5"))
            .await
            .unwrap();

        assert!(selected.is_none());
    }

    #[tokio::test]
    async fn direct_selection_cannot_bypass_model_matching() {
        let pool = test_pool().await;
        insert_upstream(&pool, "deepseek-only", &["DeepSeek-V4-Flash"], 100).await;

        let by_name = select_upstream(
            &pool,
            &BackoffManager::new(),
            Some("deepseek-only"),
            Some("gpt-5.5"),
        )
        .await
        .unwrap();
        let by_id = select_upstream(&pool, &BackoffManager::new(), Some("1"), Some("gpt-5.5"))
            .await
            .unwrap();

        assert!(by_name.is_none());
        assert!(by_id.is_none());
    }

    #[tokio::test]
    async fn matching_model_still_selects_enabled_channel() {
        let pool = test_pool().await;
        insert_upstream(&pool, "deepseek-only", &["DeepSeek-V4-Flash"], 100).await;

        let selected = select_upstream(
            &pool,
            &BackoffManager::new(),
            None,
            Some("DeepSeek-V4-Flash"),
        )
        .await
        .unwrap();

        let (upstream, forward_model) = selected.unwrap();
        assert_eq!(upstream.name, "deepseek-only");
        assert_eq!(forward_model.as_deref(), Some("DeepSeek-V4-Flash"));
    }
}
