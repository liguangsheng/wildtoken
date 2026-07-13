use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};

use crate::error::AppError;
use crate::models::request_log::{
    RequestLogDetailOut, RequestLogOut, TokenUsageStatsOut, TokenUsageWindowOut,
};

const LOG_BODY_CLEANUP_BATCH_SIZE: i64 = 4;
const LOG_BODY_CLEANUP_BATCH_PAUSE: std::time::Duration = std::time::Duration::from_millis(25);

// ── Internal query types (to avoid exceeding sqlx tuple limit) ──────────────

#[derive(Debug, FromRow)]
struct LogListRow {
    id: i64,
    created_at: String,
    method: String,
    path: String,
    downstream_token_id: Option<i64>,
    downstream_token_name: Option<String>,
    client_type: String,
    upstream_id: Option<i64>,
    upstream_name: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    response_reasoning_effort: Option<String>,
    stream: i32,
    status_code: Option<i32>,
    prompt_tokens: Option<i32>,
    completion_tokens: Option<i32>,
    total_tokens: Option<i32>,
    duration_ms: Option<i32>,
    first_token_ms: Option<i32>,
    error: Option<String>,
}

#[derive(Debug, FromRow)]
struct LogDetailRow {
    id: i64,
    created_at: String,
    method: String,
    path: String,
    downstream_token_id: Option<i64>,
    downstream_token_name: Option<String>,
    client_type: String,
    upstream_id: Option<i64>,
    upstream_name: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    response_reasoning_effort: Option<String>,
    stream: i32,
    status_code: Option<i32>,
    prompt_tokens: Option<i32>,
    completion_tokens: Option<i32>,
    total_tokens: Option<i32>,
    duration_ms: Option<i32>,
    first_token_ms: Option<i32>,
    error: Option<String>,
    request_snapshot: Option<String>,
    upstream_request_override: Option<String>,
    upstream_request_is_override: i32,
    response_snapshot: Option<String>,
    downstream_response_override: Option<String>,
    downstream_response_is_override: i32,
}

#[derive(Debug, FromRow)]
struct LogBodyCleanupRow {
    request_log_id: i64,
    request_snapshot: Option<String>,
    upstream_request_override: Option<String>,
    upstream_request_is_override: i32,
    response_snapshot: Option<String>,
    downstream_response_override: Option<String>,
    downstream_response_is_override: i32,
}

// ── Public functions ────────────────────────────────────────────────────────

fn push_log_filters(
    query: &mut QueryBuilder<'_, Sqlite>,
    upstream_id: Option<i64>,
    search: Option<&str>,
    status: Option<&str>,
) {
    if let Some(upstream_id) = upstream_id {
        query.push(" AND upstream_id = ").push_bind(upstream_id);
    }
    if let Some(search) = search {
        let search = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        query.push(" AND (LOWER(model) LIKE LOWER(");
        query.push_bind(search.clone());
        query.push(") ESCAPE '\\' OR LOWER(upstream_name) LIKE LOWER(");
        query.push_bind(search.clone());
        query.push(") ESCAPE '\\' OR LOWER(error) LIKE LOWER(");
        query.push_bind(search.clone());
        query.push(") ESCAPE '\\' OR CAST(id AS TEXT) LIKE ");
        query.push_bind(search.clone());
        query.push(" ESCAPE '\\' OR CAST(status_code AS TEXT) LIKE ");
        query.push_bind(search);
        query.push(" ESCAPE '\\')");
    }
    if let Some(status_filter) = match status {
        Some("2xx") => Some(" AND status_code BETWEEN 200 AND 299"),
        Some("4xx") => Some(" AND status_code BETWEEN 400 AND 499"),
        Some("5xx") => Some(" AND status_code BETWEEN 500 AND 599"),
        Some("none") => Some(" AND status_code IS NULL"),
        _ => None,
    } {
        query.push(status_filter);
    }
}

pub async fn list_logs(
    pool: &SqlitePool,
    limit: i32,
    offset: i32,
    upstream_id: Option<i64>,
    search: Option<&str>,
    status: Option<&str>,
) -> Result<(Vec<RequestLogOut>, i64), AppError> {
    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT id, created_at, method, path,
                downstream_token_id, downstream_token_name,
                client_type,
                upstream_id, upstream_name, model, reasoning_effort, response_reasoning_effort,
                stream, status_code,
                prompt_tokens, completion_tokens, total_tokens,
                duration_ms, first_token_ms,
                error
         FROM request_logs WHERE 1 = 1",
    );

    push_log_filters(&mut query, upstream_id, search, status);
    query
        .push(" ORDER BY created_at DESC LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    let rows: Vec<LogListRow> = query.build_query_as().fetch_all(pool).await?;

    let outputs: Vec<RequestLogOut> = rows
        .into_iter()
        .map(|r| RequestLogOut {
            id: r.id,
            created_at: r.created_at,
            method: r.method,
            path: r.path,
            downstream_token_id: r.downstream_token_id,
            downstream_token_name: r.downstream_token_name,
            client_type: r.client_type,
            upstream_id: r.upstream_id,
            upstream_name: r.upstream_name,
            model: r.model,
            reasoning_effort: r.reasoning_effort,
            response_reasoning_effort: r.response_reasoning_effort,
            stream: r.stream,
            status_code: r.status_code,
            prompt_tokens: r.prompt_tokens,
            completion_tokens: r.completion_tokens,
            total_tokens: r.total_tokens,
            duration_ms: r.duration_ms,
            first_token_ms: r.first_token_ms,
            error: r.error,
        })
        .collect();

    let recent_rpm: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM request_logs WHERE created_at >= datetime('now', '-60 seconds')",
    )
    .fetch_one(pool)
    .await?;

    Ok((outputs, recent_rpm))
}

pub async fn get_log_detail(
    pool: &SqlitePool,
    log_id: i64,
) -> Result<Option<RequestLogDetailOut>, AppError> {
    let row: Option<LogDetailRow> = sqlx::query_as(
        r#"SELECT l.id, l.created_at, l.method, l.path,
                  l.downstream_token_id, l.downstream_token_name,
                  l.client_type,
                  l.upstream_id, l.upstream_name, l.model,
                  l.reasoning_effort, l.response_reasoning_effort,
                  l.stream, l.status_code,
                  l.prompt_tokens, l.completion_tokens, l.total_tokens,
                  l.duration_ms, l.first_token_ms,
                  l.error,
                  p.request_snapshot,
                  p.upstream_request_override,
                  COALESCE(p.upstream_request_is_override, 0)
                      AS upstream_request_is_override,
                  p.response_snapshot,
                  p.downstream_response_override,
                  COALESCE(p.downstream_response_is_override, 0)
                      AS downstream_response_is_override
           FROM request_logs AS l
           LEFT JOIN request_log_payloads AS p ON p.request_log_id = l.id
           WHERE l.id = ?"#,
    )
    .bind(log_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| {
        let upstream_request = if r.upstream_request_is_override != 0 {
            r.upstream_request_override.as_deref()
        } else {
            r.request_snapshot.as_deref()
        };
        let downstream_response = if r.downstream_response_is_override != 0 {
            r.downstream_response_override.as_deref()
        } else {
            r.response_snapshot.as_deref()
        };

        RequestLogDetailOut {
            base: RequestLogOut {
                id: r.id,
                created_at: r.created_at,
                method: r.method,
                path: r.path,
                downstream_token_id: r.downstream_token_id,
                downstream_token_name: r.downstream_token_name,
                client_type: r.client_type,
                upstream_id: r.upstream_id,
                upstream_name: r.upstream_name,
                model: r.model,
                reasoning_effort: r.reasoning_effort,
                response_reasoning_effort: r.response_reasoning_effort,
                stream: r.stream,
                status_code: r.status_code,
                prompt_tokens: r.prompt_tokens,
                completion_tokens: r.completion_tokens,
                total_tokens: r.total_tokens,
                duration_ms: r.duration_ms,
                first_token_ms: r.first_token_ms,
                error: r.error,
            },
            downstream_request: r
                .request_snapshot
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok()),
            upstream_request: upstream_request.and_then(|s| serde_json::from_str(s).ok()),
            upstream_response: r
                .response_snapshot
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok()),
            downstream_response: downstream_response.and_then(|s| serde_json::from_str(s).ok()),
        }
    }))
}

pub async fn token_usage_stats(pool: &SqlitePool) -> Result<TokenUsageStatsOut, AppError> {
    let row: (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        r#"
        SELECT
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', 'localtime', 'start of day', 'utc')
                THEN COALESCE(total_tokens, 0) ELSE 0 END), 0) AS today_tokens,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', 'localtime', 'start of day', 'utc')
                 AND total_tokens IS NOT NULL
                THEN 1 ELSE 0 END), 0) AS today_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', 'localtime', 'start of day', 'utc')
                THEN 1 ELSE 0 END), 0) AS today_all_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-1 day')
                THEN COALESCE(total_tokens, 0) ELSE 0 END), 0) AS one_day_tokens,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-1 day')
                 AND total_tokens IS NOT NULL
                THEN 1 ELSE 0 END), 0) AS one_day_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-1 day')
                THEN 1 ELSE 0 END), 0) AS one_day_all_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-7 days')
                THEN COALESCE(total_tokens, 0) ELSE 0 END), 0) AS seven_days_tokens,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-7 days')
                 AND total_tokens IS NOT NULL
                THEN 1 ELSE 0 END), 0) AS seven_days_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-7 days')
                THEN 1 ELSE 0 END), 0) AS seven_days_all_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-30 days')
                THEN COALESCE(total_tokens, 0) ELSE 0 END), 0) AS thirty_days_tokens,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-30 days')
                 AND total_tokens IS NOT NULL
                THEN 1 ELSE 0 END), 0) AS thirty_days_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-30 days')
                THEN 1 ELSE 0 END), 0) AS thirty_days_all_requests
        FROM request_logs
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(TokenUsageStatsOut {
        today: TokenUsageWindowOut {
            total_tokens: row.0,
            request_count: row.1,
            all_request_count: row.2,
        },
        one_day: TokenUsageWindowOut {
            total_tokens: row.3,
            request_count: row.4,
            all_request_count: row.5,
        },
        seven_days: TokenUsageWindowOut {
            total_tokens: row.6,
            request_count: row.7,
            all_request_count: row.8,
        },
        thirty_days: TokenUsageWindowOut {
            total_tokens: row.9,
            request_count: row.10,
            all_request_count: row.11,
        },
    })
}

pub async fn clear_old_log_bodies(pool: &SqlitePool, keep_count: i64) -> Result<(), AppError> {
    loop {
        let affected =
            clear_old_log_bodies_batch(pool, keep_count, LOG_BODY_CLEANUP_BATCH_SIZE).await?;
        if affected == 0 || affected < LOG_BODY_CLEANUP_BATCH_SIZE as u64 {
            break;
        }

        tokio::time::sleep(LOG_BODY_CLEANUP_BATCH_PAUSE).await;
    }

    Ok(())
}

async fn clear_old_log_bodies_batch(
    pool: &SqlitePool,
    keep_count: i64,
    batch_size: i64,
) -> Result<u64, AppError> {
    let rows: Vec<LogBodyCleanupRow> = sqlx::query_as(
        r#"SELECT p.request_log_id,
                  p.request_snapshot,
                  p.upstream_request_override,
                  p.upstream_request_is_override,
                  p.response_snapshot,
                  p.downstream_response_override,
                  p.downstream_response_is_override
           FROM request_log_payloads AS p
           WHERE p.bodies_cleared = 0
             AND p.request_log_id NOT IN (
                 SELECT id FROM request_logs
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?
             )
           ORDER BY p.request_log_id
           LIMIT ?"#,
    )
    .bind(keep_count)
    .bind(batch_size)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(0);
    }

    let mut transaction = pool.begin().await?;
    let count = rows.len() as u64;
    for row in rows {
        let request_snapshot = clear_snapshot_body(row.request_snapshot, true);
        let upstream_request_override = clear_snapshot_body(
            row.upstream_request_override,
            row.upstream_request_is_override != 0,
        );
        let response_snapshot = clear_snapshot_body(row.response_snapshot, true);
        let downstream_response_override = clear_snapshot_body(
            row.downstream_response_override,
            row.downstream_response_is_override != 0,
        );

        sqlx::query(
            r#"UPDATE request_log_payloads
               SET request_snapshot = ?,
                   upstream_request_override = ?,
                   response_snapshot = ?,
                   downstream_response_override = ?,
                   bodies_cleared = 1
               WHERE request_log_id = ?"#,
        )
        .bind(request_snapshot)
        .bind(upstream_request_override)
        .bind(response_snapshot)
        .bind(downstream_response_override)
        .bind(row.request_log_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;

    Ok(count)
}

fn clear_snapshot_body(snapshot: Option<String>, should_clear: bool) -> Option<String> {
    let Some(snapshot) = snapshot else {
        return None;
    };
    if !should_clear || snapshot.is_empty() {
        return Some(snapshot);
    }

    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&snapshot) else {
        return Some(r#"{"body":{"cleared":true}}"#.to_string());
    };
    let Some(object) = value.as_object_mut() else {
        return Some(r#"{"body":{"cleared":true}}"#.to_string());
    };
    object.insert(
        "body".to_string(),
        serde_json::json!({
            "cleared": true,
        }),
    );
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

    use super::{
        clear_old_log_bodies, delete_old_logs, get_log_detail, list_logs, token_usage_stats,
        LOG_BODY_CLEANUP_BATCH_SIZE,
    };

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE request_logs (
                id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                method TEXT NOT NULL DEFAULT 'POST',
                path TEXT NOT NULL DEFAULT '/v1/responses',
                downstream_token_id INTEGER,
                downstream_token_name TEXT,
                client_type TEXT NOT NULL DEFAULT 'unknown',
                upstream_id INTEGER,
                upstream_name TEXT,
                model TEXT,
                reasoning_effort TEXT,
                response_reasoning_effort TEXT,
                stream INTEGER NOT NULL DEFAULT 0,
                status_code INTEGER,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                duration_ms INTEGER,
                first_token_ms INTEGER,
                error TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE request_log_payloads (
                request_log_id INTEGER PRIMARY KEY
                    REFERENCES request_logs(id) ON DELETE CASCADE,
                request_snapshot TEXT,
                upstream_request_override TEXT,
                upstream_request_is_override INTEGER NOT NULL DEFAULT 0,
                response_snapshot TEXT,
                downstream_response_override TEXT,
                downstream_response_is_override INTEGER NOT NULL DEFAULT 0,
                bodies_cleared INTEGER NOT NULL DEFAULT 0
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn insert_log(pool: &SqlitePool, id: i64, created_at: &str) {
        sqlx::query("INSERT INTO request_logs (id, created_at) VALUES (?, ?)")
            .bind(id)
            .bind(created_at)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rpm_counts_all_requests_in_trailing_minute_independent_of_list_filters() {
        let pool = test_pool().await;
        sqlx::query(
            r#"INSERT INTO request_logs (id, created_at, upstream_id, status_code) VALUES
               (1, datetime('now'), 1, 200),
               (2, datetime('now', '-30 seconds'), 2, 500),
               (3, datetime('now', '-90 seconds'), 1, 200)"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let (items, recent_rpm) = list_logs(&pool, 10, 0, Some(1), None, Some("2xx"))
            .await
            .unwrap();

        assert_eq!(items.iter().map(|item| item.id).collect::<Vec<_>>(), [1, 3]);
        assert_eq!(recent_rpm, 2);
    }

    #[tokio::test]
    async fn usage_windows_count_all_requests_even_without_token_data() {
        let pool = test_pool().await;
        sqlx::query(
            r#"INSERT INTO request_logs (id, created_at, total_tokens) VALUES
               (1, datetime('now'), 100),
               (2, datetime('now'), NULL),
               (3, datetime('now', '-2 days'), 200),
               (4, datetime('now', '-8 days'), NULL),
               (5, datetime('now', '-31 days'), 400)"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let stats = token_usage_stats(&pool).await.unwrap();

        assert_eq!(
            (
                stats.today.total_tokens,
                stats.today.request_count,
                stats.today.all_request_count,
            ),
            (100, 1, 2)
        );
        assert_eq!(
            (
                stats.one_day.total_tokens,
                stats.one_day.request_count,
                stats.one_day.all_request_count,
            ),
            (100, 1, 2)
        );
        assert_eq!(
            (
                stats.seven_days.total_tokens,
                stats.seven_days.request_count,
                stats.seven_days.all_request_count,
            ),
            (300, 2, 3)
        );
        assert_eq!(
            (
                stats.thirty_days.total_tokens,
                stats.thirty_days.request_count,
                stats.thirty_days.all_request_count,
            ),
            (300, 2, 4)
        );
    }

    #[tokio::test]
    async fn detail_reconstructs_canonical_overridden_and_null_snapshots() {
        let pool = test_pool().await;
        insert_log(&pool, 1, "2026-01-01").await;
        insert_log(&pool, 2, "2026-01-02").await;

        sqlx::query(
            r#"INSERT INTO request_log_payloads
               (request_log_id, request_snapshot,
                upstream_request_override, upstream_request_is_override,
                response_snapshot,
                downstream_response_override, downstream_response_is_override)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(1_i64)
        .bind(r#"{"kind":"downstream-request"}"#)
        .bind(r#"{"kind":"ignored-request-override"}"#)
        .bind(0_i32)
        .bind(r#"{"kind":"upstream-response"}"#)
        .bind(r#"{"kind":"downstream-response"}"#)
        .bind(1_i32)
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT INTO request_log_payloads
               (request_log_id, request_snapshot,
                upstream_request_override, upstream_request_is_override,
                response_snapshot,
                downstream_response_override, downstream_response_is_override)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(2_i64)
        .bind(r#"{"kind":"downstream-request"}"#)
        .bind(Option::<String>::None)
        .bind(1_i32)
        .bind(r#"{"kind":"upstream-response"}"#)
        .bind(Option::<String>::None)
        .bind(1_i32)
        .execute(&pool)
        .await
        .unwrap();

        let detail = get_log_detail(&pool, 1).await.unwrap().unwrap();
        assert_eq!(
            detail.downstream_request.unwrap()["kind"],
            "downstream-request"
        );
        assert_eq!(
            detail.upstream_request.unwrap()["kind"],
            "downstream-request"
        );
        assert_eq!(
            detail.upstream_response.unwrap()["kind"],
            "upstream-response"
        );
        assert_eq!(
            detail.downstream_response.unwrap()["kind"],
            "downstream-response"
        );

        let null_override = get_log_detail(&pool, 2).await.unwrap().unwrap();
        assert!(null_override.upstream_request.is_none());
        assert!(null_override.downstream_response.is_none());
        assert_eq!(
            null_override.downstream_request.unwrap()["kind"],
            "downstream-request"
        );
        assert_eq!(
            null_override.upstream_response.unwrap()["kind"],
            "upstream-response"
        );
    }

    #[tokio::test]
    async fn detail_without_payload_keeps_log_and_returns_empty_snapshots() {
        let pool = test_pool().await;
        insert_log(&pool, 1, "2026-01-01").await;

        let detail = get_log_detail(&pool, 1).await.unwrap().unwrap();
        assert_eq!(detail.base.id, 1);
        assert!(detail.downstream_request.is_none());
        assert!(detail.upstream_request.is_none());
        assert!(detail.upstream_response.is_none());
        assert!(detail.downstream_response.is_none());
    }

    #[tokio::test]
    async fn cleanup_clears_only_old_active_snapshots_and_preserves_metadata() {
        let pool = test_pool().await;
        insert_log(&pool, 1, "2026-01-01").await;
        insert_log(&pool, 2, "2026-01-02").await;

        let ignored_override = r#"{"body":{"text":"must stay"}}"#;
        sqlx::query(
            r#"INSERT INTO request_log_payloads
               (request_log_id, request_snapshot,
                upstream_request_override, upstream_request_is_override,
                response_snapshot,
                downstream_response_override, downstream_response_is_override)
               VALUES (?, ?, ?, 1, ?, ?, 0)"#,
        )
        .bind(1_i64)
        .bind(r#"{"url":"/v1/responses","headers":{"x-request":"kept"},"body":{"secret":"request"}}"#)
        .bind(r#"{"url":"https://upstream.test","headers":{"x-upstream":"kept"},"body":{"secret":"override"}}"#)
        .bind(r#"{"status":201,"headers":{"x-response":"kept"},"body":{"secret":"response"}}"#)
        .bind(ignored_override)
        .execute(&pool)
        .await
        .unwrap();
        let recent_request = r#"{"headers":{"recent":"kept"},"body":{"secret":"recent"}}"#;
        sqlx::query(
            r#"INSERT INTO request_log_payloads
               (request_log_id, request_snapshot,
                upstream_request_override, upstream_request_is_override,
                response_snapshot,
                downstream_response_override, downstream_response_is_override)
               VALUES (?, ?, NULL, 0, ?, NULL, 0)"#,
        )
        .bind(2_i64)
        .bind(recent_request)
        .bind(r#"{"body":{"secret":"recent response"}}"#)
        .execute(&pool)
        .await
        .unwrap();

        clear_old_log_bodies(&pool, 1).await.unwrap();

        let old: (String, String, String, String) = sqlx::query_as(
            r#"SELECT request_snapshot, upstream_request_override,
                      response_snapshot, downstream_response_override
               FROM request_log_payloads WHERE request_log_id = 1"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let request: serde_json::Value = serde_json::from_str(&old.0).unwrap();
        let upstream_request: serde_json::Value = serde_json::from_str(&old.1).unwrap();
        let response: serde_json::Value = serde_json::from_str(&old.2).unwrap();
        assert_eq!(request["url"], "/v1/responses");
        assert_eq!(request["headers"]["x-request"], "kept");
        assert_eq!(request["body"], serde_json::json!({"cleared": true}));
        assert_eq!(upstream_request["url"], "https://upstream.test");
        assert_eq!(upstream_request["headers"]["x-upstream"], "kept");
        assert_eq!(
            upstream_request["body"],
            serde_json::json!({"cleared": true})
        );
        assert_eq!(response["status"], 201);
        assert_eq!(response["headers"]["x-response"], "kept");
        assert_eq!(response["body"], serde_json::json!({"cleared": true}));
        assert_eq!(old.3, ignored_override);

        let recent_after: String = sqlx::query_scalar(
            "SELECT request_snapshot FROM request_log_payloads WHERE request_log_id = 2",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(recent_after, recent_request);

        clear_old_log_bodies(&pool, 1).await.unwrap();
        let after_repeat: (String, String, String, String) = sqlx::query_as(
            r#"SELECT request_snapshot, upstream_request_override,
                      response_snapshot, downstream_response_override
               FROM request_log_payloads WHERE request_log_id = 1"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after_repeat, old);

        let bodies_cleared: i64 = sqlx::query_scalar(
            "SELECT bodies_cleared FROM request_log_payloads WHERE request_log_id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(bodies_cleared, 1);
    }

    #[tokio::test]
    async fn cleanup_finishes_rows_spanning_multiple_small_batches() {
        let pool = test_pool().await;
        let old_count = LOG_BODY_CLEANUP_BATCH_SIZE + 2;
        for id in 1..=old_count {
            insert_log(&pool, id, "2026-01-01").await;
            sqlx::query(
                "INSERT INTO request_log_payloads (request_log_id, request_snapshot) VALUES (?, ?)",
            )
            .bind(id)
            .bind(r#"{"body":{"text":"old"}}"#)
            .execute(&pool)
            .await
            .unwrap();
        }
        let recent_id = old_count + 1;
        insert_log(&pool, recent_id, "2026-01-02").await;
        sqlx::query(
            "INSERT INTO request_log_payloads (request_log_id, request_snapshot) VALUES (?, ?)",
        )
        .bind(recent_id)
        .bind(r#"{"body":{"text":"recent"}}"#)
        .execute(&pool)
        .await
        .unwrap();

        clear_old_log_bodies(&pool, 1).await.unwrap();

        let cleared_old_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM request_log_payloads WHERE request_log_id <= ? AND bodies_cleared = 1",
        )
        .bind(old_count)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cleared_old_rows, old_count);

        let recent: (i64, String) = sqlx::query_as(
            "SELECT bodies_cleared, request_snapshot FROM request_log_payloads WHERE request_log_id = ?",
        )
        .bind(recent_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(recent.0, 0);
        assert_eq!(recent.1, r#"{"body":{"text":"recent"}}"#);
    }

    #[tokio::test]
    async fn deleting_old_parent_log_cascades_to_payload() {
        let pool = test_pool().await;
        insert_log(&pool, 1, "2000-01-01").await;
        sqlx::query("INSERT INTO request_logs (id, created_at) VALUES (2, datetime('now'))")
            .execute(&pool)
            .await
            .unwrap();
        for id in [1_i64, 2_i64] {
            sqlx::query(
                "INSERT INTO request_log_payloads (request_log_id, request_snapshot) VALUES (?, '{}')",
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }

        delete_old_logs(&pool, 30).await.unwrap();

        let old_log_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM request_logs WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        let old_payload_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM request_log_payloads WHERE request_log_id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let recent_payload_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM request_log_payloads WHERE request_log_id = 2",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(old_log_count, 0);
        assert_eq!(old_payload_count, 0);
        assert_eq!(recent_payload_count, 1);
    }
}

pub async fn delete_old_logs(pool: &SqlitePool, retention_days: i64) -> Result<(), AppError> {
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"DELETE FROM request_log_payloads
           WHERE request_log_id IN (
               SELECT id FROM request_logs
               WHERE created_at < datetime('now', '-' || ? || ' days')
           )"#,
    )
    .bind(retention_days)
    .execute(&mut *transaction)
    .await?;
    sqlx::query("DELETE FROM request_logs WHERE created_at < datetime('now', '-' || ? || ' days')")
        .bind(retention_days)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;

    Ok(())
}
