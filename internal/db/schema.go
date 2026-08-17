// Package db owns the SQLite schema and every query WildToken issues.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
)

// ensureColumn adds a column when a database created by an older schema lacks it.
func ensureColumn(ctx context.Context, db *sql.DB, table, column, definition string) error {
	var exists int64
	query := fmt.Sprintf("SELECT COUNT(*) FROM pragma_table_info('%s') WHERE name = ?", table)
	if err := db.QueryRowContext(ctx, query, column).Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		return nil
	}
	_, err := db.ExecContext(ctx, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, definition))
	return err
}

// seedPromptTemplatesOnce inserts the starting model-test templates, but only
// into a table that has never held any.
//
// Seeding on every start meant a template the operator deleted came back at the
// next restart, and one they renamed came back alongside the rename as a
// duplicate. ON CONFLICT(name) DO NOTHING protects a row that still exists; it
// says nothing about one that was removed on purpose. These rows are starting
// examples, not an invariant to restore.
func seedPromptTemplatesOnce(ctx context.Context, db *sql.DB) error {
	var existing int64
	if err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM model_test_prompt_templates").Scan(&existing); err != nil {
		return fmt.Errorf("count prompt templates: %w", err)
	}
	if existing != 0 {
		return nil
	}
	if _, err := db.ExecContext(ctx, seedModelTestPromptTemplates); err != nil {
		return fmt.Errorf("seed prompt templates: %w", err)
	}
	return nil
}

// Init creates the current database schema, seeds defaults, and enables the
// SQLite runtime settings WildToken depends on.
func Init(ctx context.Context, db *sql.DB) error {
	statements := []string{
		"PRAGMA journal_mode=WAL;",
		"PRAGMA foreign_keys=ON;",
		createUpstreams,
		createModelTestPromptTemplates,
		createAdminCredential,
		"CREATE INDEX IF NOT EXISTS idx_upstreams_enabled_priority ON upstreams(enabled, priority, id);",
		createRequestLogs,
		createRequestLogPayloads,
		"CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);",
		"CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at ON request_logs(upstream_id, created_at);",
		// The DESC pair these replace was never used. id is the rowid, which
		// every index entry already carries, so the ASC indexes are (created_at,
		// id) and (upstream_id, created_at, id) — a reverse scan of either
		// satisfies ORDER BY created_at DESC, id DESC without a sort. The
		// planner picked the ASC index even when both were present.
		//
		// Measured on 200k rows: dropping them left every query plan unchanged
		// with no temporary B-tree, halved the time to insert 50k rows, and
		// returned 20 MB of the 37 MB the indexes occupied. request_logs takes
		// a row per proxied request, so that write cost was on the hot path.
		"DROP INDEX IF EXISTS idx_request_logs_created_at_id_desc;",
		"DROP INDEX IF EXISTS idx_request_logs_upstream_created_at_id_desc;",
		// downstream_token_id carries ON DELETE SET NULL. Without an index
		// SQLite has to scan every log row to apply it, so deleting one token
		// took the write lock for as long as that scan, with every proxied
		// request's log write queued behind it.
		"CREATE INDEX IF NOT EXISTS idx_request_logs_downstream_token_created_at ON request_logs(downstream_token_id, created_at);",
		"CREATE INDEX IF NOT EXISTS idx_request_log_payloads_bodies_cleared ON request_log_payloads(bodies_cleared, request_log_id);",
		createAPITokens,
		createGroups,
		seedDefaultGroup,
		createUpstreamGroups,
		createUpstreamGroupsIndex,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("schema statement failed: %w", err)
		}
	}

	if err := seedPromptTemplatesOnce(ctx, db); err != nil {
		return err
	}

	for _, column := range []struct{ name, definition string }{
		{"weight", "INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 0 AND 10000)"},
		{"auto_weight_enabled", "INTEGER NOT NULL DEFAULT 1 CHECK (auto_weight_enabled IN (0, 1))"},
		// NULL means the channel is not rate-limited; the stored shape is the
		// operator's expression ("100/m"), mirroring api_tokens.rate_limit.
		{"rate_limit", "TEXT"},
	} {
		if err := ensureColumn(ctx, db, "upstreams", column.name, column.definition); err != nil {
			return err
		}
	}

	for _, column := range []struct{ name, definition string }{
		{"request_model", "TEXT"},
		{"upstream_model", "TEXT"},
		{"prompt_cached_tokens", "INTEGER"},
		{"cache_creation_tokens", "INTEGER"},
		{"completion_reasoning_tokens", "INTEGER"},
	} {
		if err := ensureColumn(ctx, db, "request_logs", column.name, column.definition); err != nil {
			return err
		}
	}

	if err := ensureColumn(ctx, db, "api_tokens", "expires_at", "TEXT"); err != nil {
		return err
	}
	// A token reaches only its own group's channels. The column is added without
	// a foreign key because SQLite cannot attach one to an existing table; the
	// stores enforce the reference instead.
	if err := ensureColumn(ctx, db, "api_tokens", "group_id", "INTEGER"); err != nil {
		return err
	}
	// The running total is kept on the token rather than aggregated from
	// request_logs: logs are pruned by the retention policy, which would make a
	// quota silently refill once its usage aged out.
	for _, column := range []struct{ name, definition string }{
		{"used_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"limit_tokens", "INTEGER"},
		{"rate_limit", "TEXT"},
	} {
		if err := ensureColumn(ctx, db, "api_tokens", column.name, column.definition); err != nil {
			return err
		}
	}
	if err := MigrateLegacyTokenStorage(ctx, db); err != nil {
		return err
	}

	// Existing rows join the default group, so an upgraded database keeps
	// routing exactly as it did before groups existed.
	for _, statement := range []string{backfillUpstreamGroups, backfillTokenGroups} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}

	if _, err := db.ExecContext(ctx, createRuntimeSettings); err != nil {
		return err
	}
	for _, column := range []struct{ name, definition string }{
		{"max_retries", "INTEGER NOT NULL DEFAULT 1 CHECK (max_retries BETWEEN 0 AND 5)"},
		{"same_upstream_retry_interval_ms", "INTEGER NOT NULL DEFAULT 1000 CHECK (same_upstream_retry_interval_ms BETWEEN 0 AND 60000)"},
		{"auto_weight_failure_penalty", "INTEGER NOT NULL DEFAULT 20 CHECK (auto_weight_failure_penalty BETWEEN 0 AND 100)"},
		{"auto_weight_success_increment", "INTEGER NOT NULL DEFAULT 5 CHECK (auto_weight_success_increment BETWEEN 0 AND 100)"},
		{"auto_weight_recovery_increment", "INTEGER NOT NULL DEFAULT 10 CHECK (auto_weight_recovery_increment BETWEEN 0 AND 100)"},
		{"auto_weight_recovery_interval_seconds", "INTEGER NOT NULL DEFAULT 60 CHECK (auto_weight_recovery_interval_seconds BETWEEN 1 AND 3600)"},
		{"proxy_enabled", "INTEGER NOT NULL DEFAULT 0 CHECK (proxy_enabled IN (0, 1))"},
		{"proxy_url", "TEXT NOT NULL DEFAULT ''"},
	} {
		if err := ensureColumn(ctx, db, "runtime_settings", column.name, column.definition); err != nil {
			return err
		}
	}
	if _, err := db.ExecContext(ctx, seedRuntimeSettings); err != nil {
		return err
	}

	return nil
}

// CheckAutoVacuum warns when incremental auto-vacuum is not active, which means
// deleted log pages are never returned to the filesystem.
func CheckAutoVacuum(ctx context.Context, db *sql.DB) error {
	var mode int64
	if err := db.QueryRowContext(ctx, "PRAGMA auto_vacuum").Scan(&mode); err != nil {
		return err
	}
	if mode != 2 {
		slog.Warn("SQLite incremental auto-vacuum is not active; run a maintenance VACUUM once",
			"sqlite_auto_vacuum", mode)
	}
	return nil
}
