package db

import (
	"context"
	"database/sql"
	"errors"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

const modelTestPromptColumns = "id, name, prompt, created_at, updated_at"

func scanModelTestPromptTemplate(row interface{ Scan(...any) error }) (models.ModelTestPromptTemplate, error) {
	var template models.ModelTestPromptTemplate
	err := row.Scan(&template.ID, &template.Name, &template.Prompt,
		&template.CreatedAt, &template.UpdatedAt)
	return template, err
}

func ListModelTestPromptTemplates(ctx context.Context, db *sql.DB) ([]models.ModelTestPromptTemplate, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT "+modelTestPromptColumns+" FROM model_test_prompt_templates ORDER BY id ASC")
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	templates := []models.ModelTestPromptTemplate{}
	for rows.Next() {
		template, err := scanModelTestPromptTemplate(rows)
		if err != nil {
			return nil, apperr.Database(err)
		}
		templates = append(templates, template)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return templates, nil
}

func getModelTestPromptTemplate(ctx context.Context, db Queryer, id int64) (models.ModelTestPromptTemplate, error) {
	row := db.QueryRowContext(ctx,
		"SELECT "+modelTestPromptColumns+" FROM model_test_prompt_templates WHERE id = ?", id)
	return scanModelTestPromptTemplate(row)
}

// CreateModelTestPromptTemplate inserts a template and returns the row it made.
//
// The read back shares the transaction with the write, so it reports this
// insert rather than a later edit's work.
func CreateModelTestPromptTemplate(ctx context.Context, db *sql.DB, input *models.ModelTestPromptTemplateIn) (models.ModelTestPromptTemplate, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.ModelTestPromptTemplate{}, apperr.Database(err)
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx,
		"INSERT INTO model_test_prompt_templates (name, prompt, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
		trimSpace(input.Name), input.Prompt)
	if err != nil {
		return models.ModelTestPromptTemplate{}, apperr.Database(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return models.ModelTestPromptTemplate{}, apperr.Database(err)
	}
	template, err := getModelTestPromptTemplate(ctx, tx, id)
	if err != nil {
		return models.ModelTestPromptTemplate{}, apperr.Database(err)
	}
	if err := tx.Commit(); err != nil {
		return models.ModelTestPromptTemplate{}, apperr.Database(err)
	}
	return template, nil
}

func UpdateModelTestPromptTemplate(ctx context.Context, db *sql.DB, id int64, input *models.ModelTestPromptTemplateIn) (models.ModelTestPromptTemplate, bool, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.ModelTestPromptTemplate{}, false, apperr.Database(err)
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx,
		"UPDATE model_test_prompt_templates SET name = ?, prompt = ?, updated_at = datetime('now') WHERE id = ?",
		trimSpace(input.Name), input.Prompt, id)
	if err != nil {
		return models.ModelTestPromptTemplate{}, false, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return models.ModelTestPromptTemplate{}, false, apperr.Database(err)
	}
	if affected == 0 {
		return models.ModelTestPromptTemplate{}, false, nil
	}
	template, err := getModelTestPromptTemplate(ctx, tx, id)
	if err != nil {
		return models.ModelTestPromptTemplate{}, false, apperr.Database(err)
	}
	if err := tx.Commit(); err != nil {
		return models.ModelTestPromptTemplate{}, false, apperr.Database(err)
	}
	return template, true, nil
}

func DeleteModelTestPromptTemplate(ctx context.Context, db *sql.DB, id int64) (bool, error) {
	return execAffectsOne(ctx, db, "DELETE FROM model_test_prompt_templates WHERE id = ?", id)
}

// LoadAdminCredential returns the sole credential row, or ok=false when this
// database has never been bootstrapped.
func LoadAdminCredential(ctx context.Context, db Queryer) (models.AdminCredential, bool, error) {
	var credential models.AdminCredential
	err := db.QueryRowContext(ctx,
		"SELECT credential_hash, credential_version FROM admin_credential WHERE id = 1").
		Scan(&credential.CredentialHash, &credential.CredentialVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return credential, false, nil
	}
	if err != nil {
		return credential, false, apperr.Database(err)
	}
	return credential, true, nil
}

// BootstrapAdminCredential inserts the bootstrap credential only when this
// database has never had one. The caller must publish the returned snapshot
// only after this function succeeds.
func BootstrapAdminCredential(ctx context.Context, db *sql.DB, bootstrapHash string) (models.AdminCredential, error) {
	if credential, ok, err := LoadAdminCredential(ctx, db); err != nil || ok {
		return credential, err
	}

	_, err := db.ExecContext(ctx,
		"INSERT INTO admin_credential (id, credential_hash, credential_version) VALUES (1, ?, 1) ON CONFLICT(id) DO NOTHING",
		bootstrapHash)
	if err != nil {
		return models.AdminCredential{}, apperr.Database(err)
	}

	credential, ok, err := LoadAdminCredential(ctx, db)
	if err != nil {
		return models.AdminCredential{}, err
	}
	if !ok {
		return models.AdminCredential{}, apperr.Internal("admin credential was not persisted")
	}
	return credential, nil
}

// RotateAdminCredential atomically replaces the sole credential if it is still
// at expectedVersion.
//
// ok=false is an expected compare-and-swap miss, not a database error. The
// single UPDATE statement commits atomically and does not require holding an
// application lock across the call.
func RotateAdminCredential(ctx context.Context, db *sql.DB, replacementHash string, expectedVersion int64) (models.AdminCredential, bool, error) {
	var credential models.AdminCredential
	err := db.QueryRowContext(ctx,
		"UPDATE admin_credential SET credential_hash = ?, credential_version = credential_version + 1, rotated_at = datetime('now') WHERE id = 1 AND credential_version = ? RETURNING credential_hash, credential_version",
		replacementHash, expectedVersion).
		Scan(&credential.CredentialHash, &credential.CredentialVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return credential, false, nil
	}
	if err != nil {
		return credential, false, apperr.Database(err)
	}
	return credential, true, nil
}

const runtimeSettingsColumns = `log_body_keep_count, log_retention_days, log_body_max_bytes,
    max_retries, same_upstream_retry_interval_ms,
    auto_weight_failure_penalty, auto_weight_success_increment,
    auto_weight_recovery_increment, auto_weight_recovery_interval_seconds,
    proxy_enabled, proxy_url,
    revision, updated_at`

func scanRuntimeSettings(row interface{ Scan(...any) error }) (models.RuntimeSettings, error) {
	var settings models.RuntimeSettings
	err := row.Scan(&settings.LogBodyKeepCount, &settings.LogRetentionDays,
		&settings.LogBodyMaxBytes, &settings.MaxRetries,
		&settings.SameUpstreamRetryIntervalMs, &settings.AutoWeightFailurePenalty,
		&settings.AutoWeightSuccessIncrement, &settings.AutoWeightRecoveryIncrement,
		&settings.AutoWeightRecoveryIntervalSeconds,
		&settings.ProxyEnabled, &settings.ProxyURL,
		&settings.Revision, &settings.UpdatedAt)
	return settings, err
}

// LoadRuntimeSettings returns ok=false when the singleton row is missing.
func LoadRuntimeSettings(ctx context.Context, db *sql.DB) (models.RuntimeSettings, bool, error) {
	row := db.QueryRowContext(ctx,
		"SELECT "+runtimeSettingsColumns+" FROM runtime_settings WHERE id = 1")
	settings, err := scanRuntimeSettings(row)
	if errors.Is(err, sql.ErrNoRows) {
		return settings, false, nil
	}
	if err != nil {
		return settings, false, apperr.Database(err)
	}
	return settings, true, nil
}

// UpdateRuntimeSettings applies a revision compare-and-swap, so a console that
// edited a stale copy is rejected rather than silently overwriting a peer.
func UpdateRuntimeSettings(ctx context.Context, db *sql.DB, input *models.RuntimeSettingsIn) (models.RuntimeSettings, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.RuntimeSettings{}, apperr.Database(err)
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx, `UPDATE runtime_settings
       SET log_body_keep_count = ?, log_retention_days = ?, log_body_max_bytes = ?,
           max_retries = ?, same_upstream_retry_interval_ms = ?,
           auto_weight_failure_penalty = ?, auto_weight_success_increment = ?,
           auto_weight_recovery_increment = ?, auto_weight_recovery_interval_seconds = ?,
           proxy_enabled = ?, proxy_url = ?,
           revision = revision + 1, updated_at = datetime('now')
       WHERE id = 1 AND revision = ?`,
		input.LogBodyKeepCount, input.LogRetentionDays, input.LogBodyMaxBytes,
		input.MaxRetries, input.SameUpstreamRetryIntervalMs,
		input.AutoWeightFailurePenalty, input.AutoWeightSuccessIncrement,
		input.AutoWeightRecoveryIncrement, input.AutoWeightRecoveryIntervalSeconds,
		input.ProxyEnabled, trimSpace(input.ProxyURL),
		input.Revision)
	if err != nil {
		return models.RuntimeSettings{}, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return models.RuntimeSettings{}, apperr.Database(err)
	}
	if affected != 1 {
		return models.RuntimeSettings{}, apperr.Conflict("runtime settings revision conflict")
	}

	row := tx.QueryRowContext(ctx,
		"SELECT "+runtimeSettingsColumns+" FROM runtime_settings WHERE id = 1")
	updated, err := scanRuntimeSettings(row)
	if err != nil {
		return models.RuntimeSettings{}, apperr.Database(err)
	}
	updated.DatabaseOverride = true

	if err := tx.Commit(); err != nil {
		return models.RuntimeSettings{}, apperr.Database(err)
	}
	return updated, nil
}
