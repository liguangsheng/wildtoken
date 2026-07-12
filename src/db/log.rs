use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};

use crate::error::AppError;
use crate::models::request_log::{
    RequestLogDetailOut, RequestLogOut, TokenUsageStatsOut, TokenUsageWindowOut,
};

// ── Internal query types (to avoid exceeding sqlx tuple limit) ──────────────

#[derive(Debug, FromRow)]
struct LogListRow {
    id: i64,
    created_at: String,
    method: String,
    path: String,
    upstream_id: Option<i64>,
    upstream_name: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
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
    upstream_id: Option<i64>,
    upstream_name: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    stream: i32,
    status_code: Option<i32>,
    prompt_tokens: Option<i32>,
    completion_tokens: Option<i32>,
    total_tokens: Option<i32>,
    duration_ms: Option<i32>,
    first_token_ms: Option<i32>,
    error: Option<String>,
    downstream_request: Option<String>,
    upstream_request: Option<String>,
    upstream_response: Option<String>,
    downstream_response: Option<String>,
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
                upstream_id, upstream_name, model, reasoning_effort,
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
            upstream_id: r.upstream_id,
            upstream_name: r.upstream_name,
            model: r.model,
            reasoning_effort: r.reasoning_effort,
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

    let mut rpm_query = QueryBuilder::<Sqlite>::new(
        "SELECT COUNT(*) FROM request_logs WHERE created_at >= datetime('now', '-60 seconds')",
    );
    push_log_filters(&mut rpm_query, upstream_id, search, status);
    let recent_rpm: i64 = rpm_query.build_query_scalar().fetch_one(pool).await?;

    Ok((outputs, recent_rpm))
}

pub async fn get_log_detail(
    pool: &SqlitePool,
    log_id: i64,
) -> Result<Option<RequestLogDetailOut>, AppError> {
    let row: Option<LogDetailRow> = sqlx::query_as(
        r#"SELECT id, created_at, method, path,
                  upstream_id, upstream_name, model, reasoning_effort,
                  stream, status_code,
                  prompt_tokens, completion_tokens, total_tokens,
                  duration_ms, first_token_ms,
                  error,
                  downstream_request, upstream_request,
                  upstream_response, downstream_response
           FROM request_logs
           WHERE id = ?"#,
    )
    .bind(log_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| RequestLogDetailOut {
        base: RequestLogOut {
            id: r.id,
            created_at: r.created_at,
            method: r.method,
            path: r.path,
            upstream_id: r.upstream_id,
            upstream_name: r.upstream_name,
            model: r.model,
            reasoning_effort: r.reasoning_effort,
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
            .downstream_request
            .and_then(|s| serde_json::from_str(&s).ok()),
        upstream_request: r
            .upstream_request
            .and_then(|s| serde_json::from_str(&s).ok()),
        upstream_response: r
            .upstream_response
            .and_then(|s| serde_json::from_str(&s).ok()),
        downstream_response: r
            .downstream_response
            .and_then(|s| serde_json::from_str(&s).ok()),
    }))
}

pub async fn token_usage_stats(pool: &SqlitePool) -> Result<TokenUsageStatsOut, AppError> {
    let row: (i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
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
                WHEN created_at >= datetime('now', '-1 day')
                THEN COALESCE(total_tokens, 0) ELSE 0 END), 0) AS one_day_tokens,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-1 day')
                 AND total_tokens IS NOT NULL
                THEN 1 ELSE 0 END), 0) AS one_day_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-7 days')
                THEN COALESCE(total_tokens, 0) ELSE 0 END), 0) AS seven_days_tokens,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-7 days')
                 AND total_tokens IS NOT NULL
                THEN 1 ELSE 0 END), 0) AS seven_days_requests,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-30 days')
                THEN COALESCE(total_tokens, 0) ELSE 0 END), 0) AS thirty_days_tokens,
            COALESCE(SUM(CASE
                WHEN created_at >= datetime('now', '-30 days')
                 AND total_tokens IS NOT NULL
                THEN 1 ELSE 0 END), 0) AS thirty_days_requests
        FROM request_logs
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(TokenUsageStatsOut {
        today: TokenUsageWindowOut {
            total_tokens: row.0,
            request_count: row.1,
        },
        one_day: TokenUsageWindowOut {
            total_tokens: row.2,
            request_count: row.3,
        },
        seven_days: TokenUsageWindowOut {
            total_tokens: row.4,
            request_count: row.5,
        },
        thirty_days: TokenUsageWindowOut {
            total_tokens: row.6,
            request_count: row.7,
        },
    })
}

pub async fn insert_log(
    pool: &SqlitePool,
    method: &str,
    path: &str,
    upstream_id: Option<i64>,
    upstream_name: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    stream: bool,
    status_code: Option<i32>,
    prompt_tokens: Option<i32>,
    completion_tokens: Option<i32>,
    total_tokens: Option<i32>,
    duration_ms: Option<i32>,
    first_token_ms: Option<i32>,
    error: Option<&str>,
    downstream_request: &str,
    upstream_request: &str,
    upstream_response: &str,
    downstream_response: &str,
) -> Result<(), AppError> {
    let stream_int: i32 = if stream { 1 } else { 0 };

    sqlx::query(
        r#"INSERT INTO request_logs
            (method, path,
             upstream_id, upstream_name, model, reasoning_effort,
             stream, status_code,
             prompt_tokens, completion_tokens, total_tokens,
             duration_ms, first_token_ms, error,
             downstream_request, upstream_request,
             upstream_response, downstream_response, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"#,
    )
    .bind(method)
    .bind(path)
    .bind(upstream_id)
    .bind(upstream_name)
    .bind(model)
    .bind(reasoning_effort)
    .bind(stream_int)
    .bind(status_code)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .bind(total_tokens)
    .bind(duration_ms)
    .bind(first_token_ms)
    .bind(error)
    .bind(downstream_request)
    .bind(upstream_request)
    .bind(upstream_response)
    .bind(downstream_response)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn clear_old_log_bodies(pool: &SqlitePool, keep_count: i64) -> Result<(), AppError> {
    sqlx::query(
        r#"UPDATE request_logs
        SET downstream_request = CASE
                WHEN json_valid(downstream_request) = 1 THEN CASE
                    WHEN json_type(downstream_request) = 'object' THEN CASE
                        WHEN COALESCE(json_extract(downstream_request, '$.body.cleared'), 0) = 1 THEN downstream_request
                        ELSE json_set(downstream_request, '$.body', json('{"cleared":true}'))
                    END
                    ELSE '{"body":{"cleared":true}}'
                END
                ELSE '{"body":{"cleared":true}}'
            END,
            upstream_request = CASE
                WHEN json_valid(upstream_request) = 1 THEN CASE
                    WHEN json_type(upstream_request) = 'object' THEN CASE
                        WHEN COALESCE(json_extract(upstream_request, '$.body.cleared'), 0) = 1 THEN upstream_request
                        ELSE json_set(upstream_request, '$.body', json('{"cleared":true}'))
                    END
                    ELSE '{"body":{"cleared":true}}'
                END
                ELSE '{"body":{"cleared":true}}'
            END,
            upstream_response = CASE
                WHEN json_valid(upstream_response) = 1 THEN CASE
                    WHEN json_type(upstream_response) = 'object' THEN CASE
                        WHEN COALESCE(json_extract(upstream_response, '$.body.cleared'), 0) = 1 THEN upstream_response
                        ELSE json_set(upstream_response, '$.body', json('{"cleared":true}'))
                    END
                    ELSE '{"body":{"cleared":true}}'
                END
                ELSE '{"body":{"cleared":true}}'
            END,
            downstream_response = CASE
                WHEN json_valid(downstream_response) = 1 THEN CASE
                    WHEN json_type(downstream_response) = 'object' THEN CASE
                        WHEN COALESCE(json_extract(downstream_response, '$.body.cleared'), 0) = 1 THEN downstream_response
                        ELSE json_set(downstream_response, '$.body', json('{"cleared":true}'))
                    END
                    ELSE '{"body":{"cleared":true}}'
                END
                ELSE '{"body":{"cleared":true}}'
            END
        WHERE id NOT IN (
            SELECT id FROM request_logs
            ORDER BY created_at DESC, id DESC
            LIMIT ?
        ) AND (
            CASE
                WHEN downstream_request IS NULL OR downstream_request = '' THEN 1
                WHEN json_valid(downstream_request) = 0 THEN 1
                WHEN json_type(downstream_request) != 'object' THEN 1
                WHEN COALESCE(json_extract(downstream_request, '$.body.cleared'), 0) != 1 THEN 1
                ELSE 0
            END = 1
            OR CASE
                WHEN upstream_request IS NULL OR upstream_request = '' THEN 1
                WHEN json_valid(upstream_request) = 0 THEN 1
                WHEN json_type(upstream_request) != 'object' THEN 1
                WHEN COALESCE(json_extract(upstream_request, '$.body.cleared'), 0) != 1 THEN 1
                ELSE 0
            END = 1
            OR CASE
                WHEN upstream_response IS NULL OR upstream_response = '' THEN 1
                WHEN json_valid(upstream_response) = 0 THEN 1
                WHEN json_type(upstream_response) != 'object' THEN 1
                WHEN COALESCE(json_extract(upstream_response, '$.body.cleared'), 0) != 1 THEN 1
                ELSE 0
            END = 1
            OR CASE
                WHEN downstream_response IS NULL OR downstream_response = '' THEN 1
                WHEN json_valid(downstream_response) = 0 THEN 1
                WHEN json_type(downstream_response) != 'object' THEN 1
                WHEN COALESCE(json_extract(downstream_response, '$.body.cleared'), 0) != 1 THEN 1
                ELSE 0
            END = 1
        )"#,
    )
    .bind(keep_count)
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;

    use super::clear_old_log_bodies;

    #[tokio::test]
    async fn cleanup_handles_malformed_and_non_object_snapshots() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE request_logs (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, downstream_request TEXT, upstream_request TEXT, upstream_response TEXT, downstream_response TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO request_logs VALUES (1, '2026-01-01', NULL, '', 'not json', '[]')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO request_logs VALUES (2, '2026-01-02', '{\"headers\":{\"x\":\"y\"},\"body\":{\"text\":\"old\"}}', '{\"body\":{\"text\":\"old\"}}', '{\"body\":{\"text\":\"old\"}}', '{\"body\":{\"text\":\"old\"}}')")
            .execute(&pool)
            .await
            .unwrap();

        clear_old_log_bodies(&pool, 0).await.unwrap();

        let snapshots: (String, String, String, String) = sqlx::query_as(
            "SELECT downstream_request, upstream_request, upstream_response, downstream_response FROM request_logs WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        for snapshot in [snapshots.0, snapshots.1, snapshots.2, snapshots.3] {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&snapshot).unwrap()["body"]["cleared"],
                true
            );
        }

        let preserved: String =
            sqlx::query_scalar("SELECT downstream_request FROM request_logs WHERE id = 2")
                .fetch_one(&pool)
                .await
                .unwrap();
        let preserved: serde_json::Value = serde_json::from_str(&preserved).unwrap();
        assert_eq!(preserved["headers"]["x"], "y");
        assert_eq!(preserved["body"]["cleared"], true);
    }

    #[tokio::test]
    async fn repeat_cleanup_does_not_rewrite_cleared_object_snapshots() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE request_logs (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, downstream_request TEXT, upstream_request TEXT, upstream_response TEXT, downstream_response TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO request_logs VALUES (1, '2026-01-01', '{\"headers\":{\"x\":\"y\"},\"body\":{\"text\":\"old\"}}', '{\"body\":{\"text\":\"old\"}}', '{\"body\":{\"text\":\"old\"}}', '{\"body\":{\"text\":\"old\"}}')")
            .execute(&pool)
            .await
            .unwrap();

        clear_old_log_bodies(&pool, 0).await.unwrap();
        let after_first: (String, String, String, String) = sqlx::query_as(
            "SELECT downstream_request, upstream_request, upstream_response, downstream_response FROM request_logs WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        clear_old_log_bodies(&pool, 0).await.unwrap();
        let after_second: (String, String, String, String) = sqlx::query_as(
            "SELECT downstream_request, upstream_request, upstream_response, downstream_response FROM request_logs WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(after_second, after_first);
    }
}

pub async fn delete_old_logs(pool: &SqlitePool, retention_days: i64) -> Result<(), AppError> {
    sqlx::query("DELETE FROM request_logs WHERE created_at < datetime('now', '-' || ? || ' days')")
        .bind(retention_days)
        .execute(pool)
        .await?;

    Ok(())
}
