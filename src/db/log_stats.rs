use std::{
    collections::BTreeMap,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use chrono::{DateTime, Local, TimeZone, Utc};
use sqlx::{FromRow, SqlitePool};

use crate::{
    error::AppError,
    models::request_log::{TokenUsageStatsOut, TokenUsageWindowOut},
    state::RuntimeMetrics,
};

const LOG_STATS_WINDOW_DAYS: i64 = 30;
const SLOW_DB_OPERATION_THRESHOLD: Duration = Duration::from_secs(1);
pub const LOG_STATS_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy)]
pub struct PersistedLogStats {
    pub id: i64,
    pub created_at_unix_seconds: i64,
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct LogStatsSnapshot {
    pub total_log_count: i64,
    pub log_count_24h: i64,
    pub token_usage: TokenUsageStatsOut,
}

#[derive(Debug, Clone, Copy, Default)]
struct LogStatsBucket {
    request_count: i64,
    token_request_count: i64,
    total_tokens: i64,
}

#[derive(Debug, Default)]
struct LogStatsState {
    total_log_count: i64,
    max_refreshed_log_id: i64,
    minute_buckets: BTreeMap<i64, LogStatsBucket>,
    pending_entries: BTreeMap<i64, PersistedLogStats>,
}

#[derive(Debug, FromRow)]
struct LogStatsTotalsRow {
    total_log_count: i64,
    max_log_id: Option<i64>,
}

#[derive(Debug, FromRow)]
struct LogStatsBucketRow {
    bucket_start_unix_seconds: i64,
    request_count: i64,
    token_request_count: i64,
    total_tokens: i64,
}

pub struct LogStatsCache {
    refresh_lock: tokio::sync::Mutex<()>,
    state: Mutex<LogStatsState>,
}

impl LogStatsCache {
    pub fn empty() -> Self {
        Self {
            refresh_lock: tokio::sync::Mutex::new(()),
            state: Mutex::new(LogStatsState::default()),
        }
    }

    pub async fn load(pool: &SqlitePool) -> Result<Self, AppError> {
        let cache = Self::empty();
        cache.refresh_from_db(pool).await?;
        Ok(cache)
    }

    pub async fn refresh_from_db(&self, pool: &SqlitePool) -> Result<(), AppError> {
        let _refresh_guard = self.refresh_lock.lock().await;

        let totals: LogStatsTotalsRow = sqlx::query_as(
            "SELECT COUNT(*) AS total_log_count, MAX(id) AS max_log_id FROM request_logs",
        )
        .fetch_one(pool)
        .await?;
        let refreshed_max_log_id = totals.max_log_id.unwrap_or(0);
        let rows: Vec<LogStatsBucketRow> = sqlx::query_as(
            r#"SELECT
                   CAST((CAST(strftime('%s', created_at) AS INTEGER) / 60) * 60 AS INTEGER)
                       AS bucket_start_unix_seconds,
                   COUNT(*) AS request_count,
                   COALESCE(SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END), 0)
                       AS token_request_count,
                   COALESCE(SUM(total_tokens), 0) AS total_tokens
               FROM request_logs
               WHERE created_at >= datetime('now', '-30 days')
               GROUP BY bucket_start_unix_seconds
               ORDER BY bucket_start_unix_seconds"#,
        )
        .fetch_all(pool)
        .await?;

        let now = Utc::now();
        let mut refreshed = LogStatsState {
            total_log_count: totals.total_log_count,
            max_refreshed_log_id: refreshed_max_log_id,
            minute_buckets: rows
                .into_iter()
                .map(|row| {
                    (
                        row.bucket_start_unix_seconds,
                        LogStatsBucket {
                            request_count: row.request_count,
                            token_request_count: row.token_request_count,
                            total_tokens: row.total_tokens,
                        },
                    )
                })
                .collect(),
            pending_entries: BTreeMap::new(),
        };

        let mut state = self.lock_state();
        let pending_entries: Vec<PersistedLogStats> = state
            .pending_entries
            .values()
            .copied()
            .filter(|entry| entry.id > refreshed_max_log_id)
            .collect();
        for entry in pending_entries {
            refreshed.apply_persisted_entry(entry, now);
            refreshed.pending_entries.insert(entry.id, entry);
        }
        refreshed.prune(now);

        *state = refreshed;
        Ok(())
    }

    pub fn record_persisted_entries(&self, entries: &[PersistedLogStats]) {
        if entries.is_empty() {
            return;
        }

        let now = Utc::now();
        let mut state = self.lock_state();
        state.prune(now);
        for entry in entries {
            if entry.id <= state.max_refreshed_log_id
                || state.pending_entries.contains_key(&entry.id)
            {
                continue;
            }
            state.apply_persisted_entry(*entry, now);
            state.pending_entries.insert(entry.id, *entry);
        }
    }

    pub fn snapshot(&self) -> LogStatsSnapshot {
        let now = Utc::now();
        let mut state = self.lock_state();
        state.prune(now);
        state.snapshot(now)
    }

    fn lock_state(&self) -> MutexGuard<'_, LogStatsState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Count request logs in the strict trailing 60-second window.
///
/// Keep RPM separate from the minute-bucket cache: minute buckets are precise
/// enough for multi-day usage summaries, but cannot represent a rolling
/// second-level boundary without over-counting part of the previous minute.
pub async fn recent_one_minute_log_count(pool: &SqlitePool) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM request_logs WHERE created_at >= datetime('now', '-60 seconds')",
    )
    .fetch_one(pool)
    .await?)
}

impl LogStatsState {
    fn apply_persisted_entry(&mut self, entry: PersistedLogStats, now: DateTime<Utc>) {
        self.total_log_count = self.total_log_count.saturating_add(1);
        if entry.created_at_unix_seconds < oldest_window_start(now) {
            return;
        }

        let bucket = self
            .minute_buckets
            .entry(floor_to_minute(entry.created_at_unix_seconds))
            .or_default();
        bucket.request_count = bucket.request_count.saturating_add(1);
        if let Some(total_tokens) = entry.total_tokens {
            bucket.token_request_count = bucket.token_request_count.saturating_add(1);
            bucket.total_tokens = bucket.total_tokens.saturating_add(total_tokens);
        }
    }

    fn prune(&mut self, now: DateTime<Utc>) {
        let oldest_bucket = floor_to_minute(oldest_window_start(now));
        let expired: Vec<i64> = self
            .minute_buckets
            .range(..oldest_bucket)
            .map(|(bucket_start, _)| *bucket_start)
            .collect();
        for bucket_start in expired {
            self.minute_buckets.remove(&bucket_start);
        }
    }

    fn snapshot(&self, now: DateTime<Utc>) -> LogStatsSnapshot {
        let today_cutoff = local_day_start_unix_seconds(now);
        let one_day_cutoff = floor_to_minute((now - chrono::Duration::days(1)).timestamp());
        let seven_days_cutoff = floor_to_minute((now - chrono::Duration::days(7)).timestamp());
        let thirty_days_cutoff = floor_to_minute(oldest_window_start(now));

        let mut today = LogStatsBucket::default();
        let mut one_day = LogStatsBucket::default();
        let mut seven_days = LogStatsBucket::default();
        let mut thirty_days = LogStatsBucket::default();

        for (bucket_start, bucket) in &self.minute_buckets {
            if *bucket_start >= today_cutoff {
                today.add(*bucket);
            }
            if *bucket_start >= one_day_cutoff {
                one_day.add(*bucket);
            }
            if *bucket_start >= seven_days_cutoff {
                seven_days.add(*bucket);
            }
            if *bucket_start >= thirty_days_cutoff {
                thirty_days.add(*bucket);
            }
        }

        LogStatsSnapshot {
            total_log_count: self.total_log_count,
            log_count_24h: one_day.request_count,
            token_usage: TokenUsageStatsOut {
                today: today.into_window(),
                one_day: one_day.into_window(),
                seven_days: seven_days.into_window(),
                thirty_days: thirty_days.into_window(),
            },
        }
    }
}

impl LogStatsBucket {
    fn add(&mut self, other: Self) {
        self.request_count = self.request_count.saturating_add(other.request_count);
        self.token_request_count = self
            .token_request_count
            .saturating_add(other.token_request_count);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
    }

    fn into_window(self) -> TokenUsageWindowOut {
        TokenUsageWindowOut {
            total_tokens: self.total_tokens,
            request_count: self.token_request_count,
            all_request_count: self.request_count,
        }
    }
}

fn oldest_window_start(now: DateTime<Utc>) -> i64 {
    (now - chrono::Duration::days(LOG_STATS_WINDOW_DAYS)).timestamp()
}

fn floor_to_minute(timestamp: i64) -> i64 {
    timestamp - timestamp.rem_euclid(60)
}

fn local_day_start_unix_seconds(now: DateTime<Utc>) -> i64 {
    let local_now = now.with_timezone(&Local);
    let Some(day_start) = local_now.date_naive().and_hms_opt(0, 0, 0) else {
        return now.timestamp();
    };
    Local
        .from_local_datetime(&day_start)
        .earliest()
        .map(|datetime| datetime.with_timezone(&Utc).timestamp())
        .unwrap_or_else(|| now.timestamp())
}

pub async fn refresh_loop(
    pool: SqlitePool,
    cache: std::sync::Arc<LogStatsCache>,
    metrics: std::sync::Arc<RuntimeMetrics>,
) {
    tokio::time::sleep(LOG_STATS_REFRESH_INTERVAL).await;
    let mut interval = tokio::time::interval(LOG_STATS_REFRESH_INTERVAL);
    loop {
        interval.tick().await;
        let started_at = std::time::Instant::now();
        if let Err(error) = cache.refresh_from_db(&pool).await {
            tracing::error!(?error, "failed to refresh request log statistics cache");
        }
        if started_at.elapsed() >= SLOW_DB_OPERATION_THRESHOLD {
            metrics.record_slow_db_operation();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

    use super::{recent_one_minute_log_count, LogStatsCache, PersistedLogStats};

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                total_tokens INTEGER
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn refresh_groups_logs_into_usage_windows() {
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

        let cache = LogStatsCache::load(&pool).await.unwrap();
        let snapshot = cache.snapshot();

        assert_eq!(snapshot.total_log_count, 5);
        assert_eq!(snapshot.log_count_24h, 2);
        assert_eq!(
            (
                snapshot.token_usage.today.total_tokens,
                snapshot.token_usage.today.request_count,
                snapshot.token_usage.today.all_request_count,
            ),
            (100, 1, 2)
        );
        assert_eq!(
            (
                snapshot.token_usage.one_day.total_tokens,
                snapshot.token_usage.one_day.request_count,
                snapshot.token_usage.one_day.all_request_count,
            ),
            (100, 1, 2)
        );
        assert_eq!(
            (
                snapshot.token_usage.seven_days.total_tokens,
                snapshot.token_usage.seven_days.request_count,
                snapshot.token_usage.seven_days.all_request_count,
            ),
            (300, 2, 3)
        );
        assert_eq!(
            (
                snapshot.token_usage.thirty_days.total_tokens,
                snapshot.token_usage.thirty_days.request_count,
                snapshot.token_usage.thirty_days.all_request_count,
            ),
            (300, 2, 4)
        );
    }

    #[tokio::test]
    async fn record_persisted_entries_updates_cache_without_refresh() {
        let cache = LogStatsCache::empty();
        let now = chrono::Utc::now().timestamp();

        cache.record_persisted_entries(&[
            PersistedLogStats {
                id: 1,
                created_at_unix_seconds: now,
                total_tokens: Some(12),
            },
            PersistedLogStats {
                id: 2,
                created_at_unix_seconds: now,
                total_tokens: None,
            },
        ]);

        let snapshot = cache.snapshot();
        assert_eq!(snapshot.total_log_count, 2);
        assert_eq!(snapshot.log_count_24h, 2);
        assert_eq!(snapshot.token_usage.thirty_days.total_tokens, 12);
        assert_eq!(snapshot.token_usage.thirty_days.request_count, 1);
        assert_eq!(snapshot.token_usage.thirty_days.all_request_count, 2);
    }

    #[tokio::test]
    async fn recent_one_minute_count_uses_strict_sixty_second_window() {
        let pool = test_pool().await;
        sqlx::query(
            r#"INSERT INTO request_logs (id, created_at, total_tokens) VALUES
               (1, datetime('now'), 10),
               (2, datetime('now', '-30 seconds'), 20),
               (3, datetime('now', '-90 seconds'), 30)"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(recent_one_minute_log_count(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn refresh_preserves_pending_entries_newer_than_db_watermark() {
        let pool = test_pool().await;
        sqlx::query(
            "INSERT INTO request_logs (id, created_at, total_tokens) VALUES (1, datetime('now'), 10)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let cache = Arc::new(LogStatsCache::empty());
        cache.record_persisted_entries(&[PersistedLogStats {
            id: 2,
            created_at_unix_seconds: chrono::Utc::now().timestamp(),
            total_tokens: Some(5),
        }]);
        cache.refresh_from_db(&pool).await.unwrap();

        let snapshot = cache.snapshot();
        assert_eq!(snapshot.total_log_count, 2);
        assert_eq!(snapshot.token_usage.thirty_days.total_tokens, 15);
        assert_eq!(snapshot.token_usage.thirty_days.request_count, 2);
        assert_eq!(snapshot.token_usage.thirty_days.all_request_count, 2);
    }
}
