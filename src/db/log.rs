use sqlx::{FromRow, QueryBuilder, Sqlite, SqlitePool};

use crate::error::AppError;
use crate::models::request_log::{
    RequestLogDetailOut, RequestLogOut, RequestLogTopItemOut, RequestLogTopStatsOut,
};
#[cfg(test)]
use crate::models::request_log::{TokenUsageStatsOut, TokenUsageWindowOut};
use crate::state::RuntimeMetrics;

const LOG_BODY_CLEANUP_BATCH_SIZE: i64 = 8;
const LOG_BODY_CLEANUP_BATCH_PAUSE: std::time::Duration = std::time::Duration::from_millis(25);
const SLOW_DB_OPERATION_THRESHOLD: std::time::Duration = std::time::Duration::from_secs(1);

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

#[derive(Debug, FromRow)]
struct TopCountRow {
    name: String,
    count: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogTopWindow {
    Today,
    OneDay,
    ThreeDays,
    SevenDays,
    ThirtyDays,
}

impl LogTopWindow {
    pub fn from_query_value(value: &str) -> Option<Self> {
        match value {
            "today" => Some(Self::Today),
            "1d" => Some(Self::OneDay),
            "3d" => Some(Self::ThreeDays),
            "7d" => Some(Self::SevenDays),
            "30d" => Some(Self::ThirtyDays),
            _ => None,
        }
    }

    pub fn as_query_value(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::OneDay => "1d",
            Self::ThreeDays => "3d",
            Self::SevenDays => "7d",
            Self::ThirtyDays => "30d",
        }
    }

    fn cutoff_expression(self) -> &'static str {
        match self {
            Self::Today => "datetime('now', 'localtime', 'start of day', 'utc')",
            Self::OneDay => "datetime('now', '-1 day')",
            Self::ThreeDays => "datetime('now', '-3 days')",
            Self::SevenDays => "datetime('now', '-7 days')",
            Self::ThirtyDays => "datetime('now', '-30 days')",
        }
    }
}

// ── Public functions ────────────────────────────────────────────────────────

fn push_log_filters(
    query: &mut QueryBuilder<'_, Sqlite>,
    upstream_id: Option<i64>,
    search: Option<&str>,
    status: Option<&str>,
    client_type: Option<&str>,
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
    if let Some(client_type) = client_type {
        query
            .push(" AND client_type = ")
            .push_bind(client_type.to_string());
    }
}

pub async fn list_logs(
    pool: &SqlitePool,
    limit: i32,
    offset: i32,
    before_created_at: Option<&str>,
    before_id: Option<i64>,
    upstream_id: Option<i64>,
    search: Option<&str>,
    status: Option<&str>,
    client_type: Option<&str>,
) -> Result<Vec<RequestLogOut>, AppError> {
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

    push_log_filters(&mut query, upstream_id, search, status, client_type);
    if let (Some(before_created_at), Some(before_id)) = (before_created_at, before_id) {
        query.push(" AND (created_at < ");
        query.push_bind(before_created_at);
        query.push(" OR (created_at = ");
        query.push_bind(before_created_at);
        query.push(" AND id < ");
        query.push_bind(before_id);
        query.push("))");
    }
    query
        .push(" ORDER BY created_at DESC, id DESC LIMIT ")
        .push_bind(limit);
    if before_created_at.is_none() || before_id.is_none() {
        query.push(" OFFSET ").push_bind(offset);
    }
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

    Ok(outputs)
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

pub async fn top_log_stats(
    pool: &SqlitePool,
    window: LogTopWindow,
    limit: i64,
) -> Result<RequestLogTopStatsOut, AppError> {
    let limit = limit.clamp(1, 20);
    let models = top_log_counts(
        pool,
        window,
        "TRIM(model)",
        "model IS NOT NULL AND TRIM(model) <> ''",
        "1",
        None,
        limit,
    )
    .await?;
    let channels = top_log_counts(
        pool,
        window,
        r#"CASE
              WHEN upstream_name IS NOT NULL AND TRIM(upstream_name) <> '' THEN TRIM(upstream_name)
              WHEN upstream_id IS NOT NULL THEN '#' || upstream_id
              ELSE NULL
           END"#,
        "upstream_id IS NOT NULL OR (upstream_name IS NOT NULL AND TRIM(upstream_name) <> '')",
        "1",
        None,
        limit,
    )
    .await?;
    let model_tokens = top_log_counts(
        pool,
        window,
        "TRIM(model)",
        "model IS NOT NULL AND TRIM(model) <> ''",
        "COALESCE(total_tokens, 0)",
        Some("total_tokens IS NOT NULL AND total_tokens > 0"),
        limit,
    )
    .await?;
    let channel_tokens = top_log_counts(
        pool,
        window,
        r#"CASE
              WHEN upstream_name IS NOT NULL AND TRIM(upstream_name) <> '' THEN TRIM(upstream_name)
              WHEN upstream_id IS NOT NULL THEN '#' || upstream_id
              ELSE NULL
           END"#,
        "upstream_id IS NOT NULL OR (upstream_name IS NOT NULL AND TRIM(upstream_name) <> '')",
        "COALESCE(total_tokens, 0)",
        Some("total_tokens IS NOT NULL AND total_tokens > 0"),
        limit,
    )
    .await?;

    Ok(RequestLogTopStatsOut {
        window: window.as_query_value().to_string(),
        models,
        channels,
        model_tokens,
        channel_tokens,
    })
}

async fn top_log_counts(
    pool: &SqlitePool,
    window: LogTopWindow,
    name_expression: &str,
    source_filter: &str,
    metric_expression: &str,
    metric_filter: Option<&str>,
    limit: i64,
) -> Result<Vec<RequestLogTopItemOut>, AppError> {
    let mut query = QueryBuilder::<Sqlite>::new("SELECT name, SUM(value) AS count FROM (SELECT ");
    query
        .push(name_expression)
        .push(" AS name, ")
        .push(metric_expression)
        .push(" AS value FROM request_logs WHERE created_at >= ")
        .push(window.cutoff_expression())
        .push(" AND (")
        .push(source_filter)
        .push(")");
    if let Some(metric_filter) = metric_filter {
        query.push(" AND (").push(metric_filter).push(")");
    }
    query
        .push(") WHERE name IS NOT NULL AND name <> '' GROUP BY name HAVING count > 0 ORDER BY count DESC, name COLLATE NOCASE ASC LIMIT ")
        .push_bind(limit);

    let rows: Vec<TopCountRow> = query.build_query_as().fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|row| RequestLogTopItemOut {
            name: row.name,
            count: row.count,
        })
        .collect())
}

#[cfg(test)]
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
        WHERE created_at >= datetime('now', '-30 days')
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

#[cfg(test)]
async fn clear_old_log_bodies(pool: &SqlitePool, keep_count: i64) -> Result<u64, AppError> {
    clear_old_log_bodies_inner(pool, keep_count, None).await
}

pub async fn clear_old_log_bodies_with_metrics(
    pool: &SqlitePool,
    keep_count: i64,
    metrics: &RuntimeMetrics,
) -> Result<u64, AppError> {
    clear_old_log_bodies_inner(pool, keep_count, Some(metrics)).await
}

/// Return free SQLite pages to the filesystem when incremental auto-vacuum is enabled.
///
/// Existing databases need one full `VACUUM` after switching from `NONE` to
/// `INCREMENTAL`; until then this safely acts as a no-op.
pub async fn reclaim_free_pages(pool: &SqlitePool, max_pages: u32) -> Result<u64, AppError> {
    if max_pages == 0 {
        return Ok(0);
    }

    let auto_vacuum: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
        .fetch_one(pool)
        .await?;
    if auto_vacuum != 2 {
        return Ok(0);
    }

    let before: i64 = sqlx::query_scalar("PRAGMA freelist_count")
        .fetch_one(pool)
        .await?;
    if before == 0 {
        return Ok(0);
    }

    sqlx::query(&format!("PRAGMA incremental_vacuum({max_pages})"))
        .execute(pool)
        .await?;
    let after: i64 = sqlx::query_scalar("PRAGMA freelist_count")
        .fetch_one(pool)
        .await?;
    Ok(before.saturating_sub(after) as u64)
}

async fn clear_old_log_bodies_inner(
    pool: &SqlitePool,
    keep_count: i64,
    metrics: Option<&RuntimeMetrics>,
) -> Result<u64, AppError> {
    let mut total_affected = 0;
    loop {
        let batch_started_at = std::time::Instant::now();
        let affected =
            clear_old_log_bodies_batch(pool, keep_count, LOG_BODY_CLEANUP_BATCH_SIZE).await?;
        if batch_started_at.elapsed() >= SLOW_DB_OPERATION_THRESHOLD {
            if let Some(metrics) = metrics {
                metrics.record_slow_db_operation();
            }
        }
        if let Some(metrics) = metrics {
            metrics.record_cleanup_batch(affected);
        }
        total_affected += affected;

        if affected == 0 || affected < LOG_BODY_CLEANUP_BATCH_SIZE as u64 {
            break;
        }

        tokio::time::sleep(LOG_BODY_CLEANUP_BATCH_PAUSE).await;
    }

    Ok(total_affected)
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

    let count = rows.len() as u64;
    let updates: Vec<_> = rows
        .into_iter()
        .map(|row| {
            (
                row.request_log_id,
                clear_snapshot_body(row.request_snapshot, true),
                clear_snapshot_body(
                    row.upstream_request_override,
                    row.upstream_request_is_override != 0,
                ),
                clear_snapshot_body(row.response_snapshot, true),
                clear_snapshot_body(
                    row.downstream_response_override,
                    row.downstream_response_is_override != 0,
                ),
            )
        })
        .collect();

    // Parse and shrink the potentially large JSON values before acquiring the
    // SQLite write lock; the transaction only contains the bounded UPDATEs.
    let mut transaction = pool.begin().await?;
    for (
        request_log_id,
        request_snapshot,
        upstream_request_override,
        response_snapshot,
        downstream_response_override,
    ) in updates
    {
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
        .bind(request_log_id)
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
    use sqlx::{sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions, SqlitePool};

    use super::{
        clear_old_log_bodies, delete_old_logs, get_log_detail, list_logs, reclaim_free_pages,
        token_usage_stats, top_log_stats, LogTopWindow, LOG_BODY_CLEANUP_BATCH_SIZE,
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
    async fn list_filters_do_not_affect_returned_logs() {
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

        let items = list_logs(&pool, 10, 0, None, None, Some(1), None, Some("2xx"), None)
            .await
            .unwrap();

        assert_eq!(items.iter().map(|item| item.id).collect::<Vec<_>>(), [1, 3]);
    }

    #[tokio::test]
    async fn list_filters_by_client_type() {
        let pool = test_pool().await;
        sqlx::query(
            r#"INSERT INTO request_logs (id, created_at, client_type) VALUES
               (1, datetime('now'), 'codex-tui'),
               (2, datetime('now', '-30 seconds'), 'codex-desktop'),
               (3, datetime('now', '-60 seconds'), 'codex-tui'),
               (4, datetime('now', '-90 seconds'), 'unknown')"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let items = list_logs(
            &pool,
            10,
            0,
            None,
            None,
            None,
            None,
            None,
            Some("codex-tui"),
        )
        .await
        .unwrap();

        assert_eq!(items.iter().map(|item| item.id).collect::<Vec<_>>(), [1, 3]);
        assert!(items.iter().all(|item| item.client_type == "codex-tui"));
    }

    #[tokio::test]
    async fn list_uses_created_at_and_id_cursor_for_stable_pagination() {
        let pool = test_pool().await;
        sqlx::query(
            r#"INSERT INTO request_logs (id, created_at) VALUES
               (1, '2026-01-01 00:00:00'),
               (2, '2026-01-01 00:00:01'),
               (3, '2026-01-01 00:00:01'),
               (4, '2026-01-01 00:00:02')"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let first_page = list_logs(&pool, 2, 0, None, None, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            first_page.iter().map(|item| item.id).collect::<Vec<_>>(),
            [4, 3]
        );

        let cursor = first_page.last().unwrap();
        let second_page = list_logs(
            &pool,
            2,
            0,
            Some(&cursor.created_at),
            Some(cursor.id),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            second_page.iter().map(|item| item.id).collect::<Vec<_>>(),
            [2, 1]
        );
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
    async fn top_log_stats_respect_window_and_limit() {
        let pool = test_pool().await;
        sqlx::query(
            r#"INSERT INTO request_logs
               (id, created_at, model, upstream_id, upstream_name, total_tokens)
               VALUES
               (1, datetime('now'), 'gpt-5', 1, 'fast', 100),
               (2, datetime('now', '-2 days'), 'gpt-5', 2, 'slow', 400),
               (3, datetime('now', '-2 days'), 'claude', 1, 'fast', 300),
               (4, datetime('now', '-4 days'), 'old', 3, 'old', 900),
               (5, datetime('now'), NULL, NULL, NULL, 500),
               (6, datetime('now'), 'zero-token', 4, 'zero', NULL)"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let stats = top_log_stats(&pool, LogTopWindow::ThreeDays, 5)
            .await
            .unwrap();
        assert_eq!(stats.window, "3d");
        assert_eq!(
            stats
                .models
                .iter()
                .map(|item| (item.name.as_str(), item.count))
                .collect::<Vec<_>>(),
            [("gpt-5", 2), ("claude", 1), ("zero-token", 1)]
        );
        assert_eq!(
            stats
                .channels
                .iter()
                .map(|item| (item.name.as_str(), item.count))
                .collect::<Vec<_>>(),
            [("fast", 2), ("slow", 1), ("zero", 1)]
        );
        assert_eq!(
            stats
                .model_tokens
                .iter()
                .map(|item| (item.name.as_str(), item.count))
                .collect::<Vec<_>>(),
            [("gpt-5", 500), ("claude", 300)]
        );
        assert_eq!(
            stats
                .channel_tokens
                .iter()
                .map(|item| (item.name.as_str(), item.count))
                .collect::<Vec<_>>(),
            [("fast", 400), ("slow", 400)]
        );

        let limited = top_log_stats(&pool, LogTopWindow::ThirtyDays, 1)
            .await
            .unwrap();
        assert_eq!(
            limited
                .models
                .iter()
                .map(|item| (item.name.as_str(), item.count))
                .collect::<Vec<_>>(),
            [("gpt-5", 2)]
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

    #[tokio::test]
    async fn incremental_vacuum_reclaims_a_bounded_number_of_pages() {
        let unique = format!(
            "wildtoken-vacuum-test-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .pragma("auto_vacuum", "INCREMENTAL");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();

        let mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode, 2);
        sqlx::query("CREATE TABLE reclaim_test (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"WITH RECURSIVE ids(value) AS (
                   SELECT 1 UNION ALL SELECT value + 1 FROM ids WHERE value < 128
               )
               INSERT INTO reclaim_test (id, payload)
               SELECT value, zeroblob(8192) FROM ids"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM reclaim_test")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO reclaim_test (id, payload) VALUES (999, X'6B6565706572')")
            .execute(&pool)
            .await
            .unwrap();

        let before: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(before > 0);
        let reclaimed = reclaim_free_pages(&pool, 32).await.unwrap();
        let after: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(reclaimed > 0);
        assert!(reclaimed <= 32);
        assert_eq!(before - after, reclaimed as i64);
        let keeper: Vec<u8> = sqlx::query_scalar("SELECT payload FROM reclaim_test WHERE id = 999")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(keeper, b"keeper");

        pool.close().await;
        let reopened = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(&path))
            .await
            .unwrap();
        let persisted_mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(persisted_mode, 2);
        reopened.close().await;
        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn incremental_vacuum_is_a_no_op_for_legacy_none_mode() {
        let unique = format!(
            "wildtoken-vacuum-none-test-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE legacy_reclaim_test (payload BLOB NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO legacy_reclaim_test VALUES (zeroblob(1048576))")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM legacy_reclaim_test")
            .execute(&pool)
            .await
            .unwrap();

        let page_count_before: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&pool)
            .await
            .unwrap();
        let freelist_before: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(freelist_before > 0);
        assert_eq!(reclaim_free_pages(&pool, 32).await.unwrap(), 0);
        let page_count_after: i64 = sqlx::query_scalar("PRAGMA page_count")
            .fetch_one(&pool)
            .await
            .unwrap();
        let freelist_after: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(page_count_after, page_count_before);
        assert_eq!(freelist_after, freelist_before);

        pool.close().await;
        std::fs::remove_file(&path).unwrap();
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
