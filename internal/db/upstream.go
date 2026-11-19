package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

const upstreamColumns = `id, name, base_url, api_key, model_names, model_prefixes,
    model_mappings, effort_mappings, priority, weight, auto_weight_enabled, enabled,
    archived, archived_prev_enabled,
    extra_headers, timeout_seconds, rate_limit, created_at, updated_at,
    (SELECT COUNT(*) FROM upstream_keys k WHERE k.upstream_id = upstreams.id),
    (SELECT COUNT(*) FROM upstream_keys k WHERE k.upstream_id = upstreams.id AND k.enabled = 1)`

// parseJSONArray decodes a stored list. A stored null reads as empty: decoding
// it leaves the slice nil, which the API sent on as null and the console's
// channel page crashed on.
func parseJSONArray(value string) ([]string, error) {
	parsed := []string{}
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, apperr.JSON(err)
	}
	if parsed == nil {
		parsed = []string{}
	}
	return parsed, nil
}

// parseJSONMap decodes a stored map, reading null as empty for the same reason.
func parseJSONMap(value string) (map[string]string, error) {
	parsed := map[string]string{}
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, apperr.JSON(err)
	}
	if parsed == nil {
		parsed = map[string]string{}
	}
	return parsed, nil
}

func scanUpstreamRow(row interface{ Scan(...any) error }) (models.UpstreamRow, error) {
	var upstream models.UpstreamRow
	var apiKey, rateLimit sql.NullString
	// effort_mappings is scanned through a NullString even though the column
	// carries a NOT NULL default: an UPDATE that predates this field could still
	// have written a NULL into it, and scanning that straight into a string
	// fails the whole query rather than the one channel.
	var effortMappings sql.NullString
	err := row.Scan(&upstream.ID, &upstream.Name, &upstream.BaseURL, &apiKey,
		&upstream.ModelNames, &upstream.ModelPrefixes, &upstream.ModelMappings,
		&effortMappings, &upstream.Priority, &upstream.Weight,
		&upstream.AutoWeightEnabled, &upstream.Enabled, &upstream.Archived,
		&upstream.ArchivedPrevEnabled, &upstream.ExtraHeaders,
		&upstream.TimeoutSeconds, &rateLimit, &upstream.CreatedAt, &upstream.UpdatedAt,
		&upstream.KeyCount, &upstream.EnabledKeyCount)
	if err != nil {
		return upstream, err
	}
	if upstream.ExtraHeaders, err = openSecret(upstream.ExtraHeaders); err != nil {
		return upstream, err
	}
	if apiKey.Valid {
		plain, err := openSecret(apiKey.String)
		if err != nil {
			return upstream, err
		}
		upstream.APIKey = &plain
	}
	if rateLimit.Valid && rateLimit.String != "" {
		upstream.RateLimit = &rateLimit.String
	}
	upstream.EffortMappings = "{}"
	if effortMappings.Valid && effortMappings.String != "" {
		upstream.EffortMappings = effortMappings.String
	}
	return upstream, nil
}

// RowToUpstreamOut converts a row into its API shape, leaving the runtime health
// fields at their neutral defaults for the caller to fill in.
func RowToUpstreamOut(row *models.UpstreamRow) (models.UpstreamOut, error) {
	modelNames, err := parseJSONArray(row.ModelNames)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	modelPrefixes, err := parseJSONArray(row.ModelPrefixes)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	modelMappings, err := parseJSONMap(row.ModelMappings)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	effortMappings, err := parseJSONMap(row.EffortMappings)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	extraHeaders, err := parseJSONMap(row.ExtraHeaders)
	if err != nil {
		return models.UpstreamOut{}, err
	}

	out := models.UpstreamOut{
		ID:                 row.ID,
		Name:               row.Name,
		BaseURL:            row.BaseURL,
		APIKeySet:          row.KeyCount > 0,
		KeyCount:           row.KeyCount,
		EnabledKeyCount:    row.EnabledKeyCount,
		ModelNames:         modelNames,
		ModelPrefixes:      modelPrefixes,
		ModelMappings:      modelMappings,
		EffortMappings:     effortMappings,
		Priority:           row.Priority,
		Weight:             row.Weight,
		AutoWeightEnabled:  row.AutoWeightEnabled == 1,
		Enabled:            row.Enabled == 1,
		Archived:           row.Archived == 1,
		ExtraHeaders:       extraHeaders,
		TimeoutSeconds:     row.TimeoutSeconds,
		RateLimit:          row.RateLimit,
		CreatedAt:          row.CreatedAt,
		UpdatedAt:          row.UpdatedAt,
		RuntimeHealthScore: 100,
		EffectiveWeight:    float64(row.Weight),
	}
	out.EnabledBeforeArchive = EnabledBeforeArchive(row)
	return out, nil
}

// EnabledBeforeArchive is what unarchiving a row would restore, nil while it
// is not archived.
func EnabledBeforeArchive(row *models.UpstreamRow) *bool {
	if row.Archived != 1 {
		return nil
	}
	enabled := row.ArchivedPrevEnabled != nil && *row.ArchivedPrevEnabled == 1
	return &enabled
}

func queryUpstreamRows(ctx context.Context, db *sql.DB, query string, args ...any) ([]models.UpstreamRow, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	upstreams := []models.UpstreamRow{}
	for rows.Next() {
		upstream, err := scanUpstreamRow(rows)
		if err != nil {
			return nil, apperr.Database(err)
		}
		upstreams = append(upstreams, upstream)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return upstreams, nil
}

func ListUpstreams(ctx context.Context, db *sql.DB) ([]models.UpstreamOut, error) {
	rows, err := queryUpstreamRows(ctx, db,
		"SELECT "+upstreamColumns+" FROM upstreams ORDER BY priority DESC, id ASC")
	if err != nil {
		return nil, err
	}
	membership, err := UpstreamGroupMembership(ctx, db)
	if err != nil {
		return nil, err
	}

	upstreams := make([]models.UpstreamOut, 0, len(rows))
	for i := range rows {
		out, err := RowToUpstreamOut(&rows[i])
		if err != nil {
			return nil, err
		}
		out.GroupIDs = membership[out.ID]
		if out.GroupIDs == nil {
			out.GroupIDs = []int64{}
		}
		upstreams = append(upstreams, out)
	}
	return upstreams, nil
}

func ListEnabledUpstreams(ctx context.Context, db *sql.DB) ([]models.UpstreamRow, error) {
	// An archived channel must not route, even if some older code path left
	// enabled at 1. This is the query the proxy picks candidates from.
	return queryUpstreamRows(ctx, db,
		"SELECT "+upstreamColumns+" FROM upstreams WHERE enabled = 1 AND archived = 0"+
			routableKeys+" ORDER BY priority DESC, id ASC")
}

// SetUpstreamArchived parks a channel out of routing, or puts it back.
//
// Parking one turns it off and remembers what it was, so a channel that was
// already disabled comes back disabled when unarchived. Without the memory,
// unarchiving would switch on every channel it touched, including ones an
// operator had taken out of service for their own reasons.
func SetUpstreamArchived(ctx context.Context, db *sql.DB, id int64, archived bool) (models.UpstreamOut, error) {
	if err := setArchived(ctx, db, id, archived); err != nil {
		return models.UpstreamOut{}, err
	}
	return reloadUpstreamOut(ctx, db, id)
}

// setArchived is SetUpstreamArchived's write, for callers inside a transaction.
func setArchived(ctx context.Context, db Queryer, id int64, archived bool) error {
	// Each statement only touches a row not already in the requested state, so
	// a repeat is a no-op. Without that, archiving twice recorded the parked
	// channel's enabled=0 as its previous state, and unarchiving a channel that
	// was never archived switched it off.
	var query string
	if archived {
		query = `UPDATE upstreams
			SET archived = 1, enabled = 0, archived_prev_enabled = enabled,
				updated_at = datetime('now')
			WHERE id = ? AND archived = 0`
	} else {
		query = `UPDATE upstreams
			SET archived = 0, enabled = COALESCE(archived_prev_enabled, 0),
				archived_prev_enabled = NULL,
				updated_at = datetime('now')
			WHERE id = ? AND archived = 1`
	}
	if _, err := db.ExecContext(ctx, query, id); err != nil {
		return apperr.Database(err)
	}
	return nil
}

// GetUpstream returns ok=false when no row carries the id.
func GetUpstream(ctx context.Context, db Queryer, id int64) (models.UpstreamRow, bool, error) {
	row := db.QueryRowContext(ctx, "SELECT "+upstreamColumns+" FROM upstreams WHERE id = ?", id)
	upstream, err := scanUpstreamRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return upstream, false, nil
	}
	if err != nil {
		return upstream, false, apperr.Database(err)
	}
	return upstream, true, nil
}

func GetUpstreamByName(ctx context.Context, db *sql.DB, name string) (models.UpstreamRow, bool, error) {
	row := db.QueryRowContext(ctx, "SELECT "+upstreamColumns+" FROM upstreams WHERE name = ?", name)
	upstream, err := scanUpstreamRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return upstream, false, nil
	}
	if err != nil {
		return upstream, false, apperr.Database(err)
	}
	return upstream, true, nil
}

// encodedCollections holds the JSON-backed columns of one channel, ready to bind.
//
// They travel as a struct rather than as a run of same-typed return values
// because every one of them is a string: a pair swapped at a call site would
// compile, and would quietly store a channel's headers as its model list.
type encodedCollections struct {
	Names          string
	Prefixes       string
	ModelMappings  string
	EffortMappings string
	Headers        string
}

// encodeUpstreamCollections serializes the JSON-backed columns.
func encodeUpstreamCollections(input *models.UpstreamIn) (encodedCollections, error) {
	encoded := encodedCollections{}
	encode := func(value any) (string, error) {
		marshaled, err := json.Marshal(value)
		if err != nil {
			return "", apperr.JSON(err)
		}
		return string(marshaled), nil
	}

	var err error
	if encoded.Names, err = encode(input.ModelNames); err != nil {
		return encoded, err
	}
	if encoded.Prefixes, err = encode(input.ModelPrefixes); err != nil {
		return encoded, err
	}
	if encoded.ModelMappings, err = encode(input.ModelMappings); err != nil {
		return encoded, err
	}
	if encoded.EffortMappings, err = encode(input.EffortMappings); err != nil {
		return encoded, err
	}
	encoded.Headers, err = encode(input.ExtraHeaders)
	if err == nil && hasHeaderSecrets(encoded.Headers) {
		encoded.Headers, err = sealSecret(encoded.Headers)
	}
	return encoded, err
}

func boolToInt64(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

// CreateUpstream creates a channel or replaces an archived namesake in place.
// Configuration, keys and groups all come from input. A missing timeout stores
// 0, so requests follow the service default when they run.
func CreateUpstream(ctx context.Context, db *sql.DB, input *models.UpstreamIn) (models.UpstreamOut, error) {
	var timeout float64
	if input.TimeoutSeconds != nil {
		timeout = *input.TimeoutSeconds
	}
	encoded, err := encodeUpstreamCollections(input)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	rateLimit, err := input.NormalizedRateLimit()
	if err != nil {
		return models.UpstreamOut{}, apperr.BadRequest(err.Error())
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	defer tx.Rollback()

	var id int64
	err = tx.QueryRowContext(ctx, `INSERT INTO upstreams
        (name, base_url, model_names, model_prefixes, model_mappings,
         effort_mappings, priority, weight, auto_weight_enabled, enabled,
         extra_headers, timeout_seconds, rate_limit, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT (name) DO UPDATE SET
            base_url = excluded.base_url,
            model_names = excluded.model_names, model_prefixes = excluded.model_prefixes,
            model_mappings = excluded.model_mappings, effort_mappings = excluded.effort_mappings,
            priority = excluded.priority, weight = excluded.weight,
            auto_weight_enabled = excluded.auto_weight_enabled, enabled = excluded.enabled,
            extra_headers = excluded.extra_headers, timeout_seconds = excluded.timeout_seconds,
            rate_limit = excluded.rate_limit, archived = 0, archived_prev_enabled = NULL,
            updated_at = excluded.updated_at
        WHERE upstreams.archived = 1
        RETURNING id`,
		input.Name, input.BaseURL, encoded.Names, encoded.Prefixes,
		encoded.ModelMappings, encoded.EffortMappings, input.Priority, input.Weight,
		boolToInt64(input.AutoWeightEnabled), boolToInt64(input.Enabled),
		encoded.Headers, timeout, rateLimit).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return models.UpstreamOut{}, apperr.BadRequest("upstream name already exists")
	}
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}

	// Membership commits with the channel, so a channel can never exist without
	// belonging to a group and therefore being unreachable.
	if err := ReplaceUpstreamGroups(ctx, tx, id, input.GroupIDs); err != nil {
		return models.UpstreamOut{}, err
	}
	if err := replaceUpstreamKeys(ctx, tx, id, createKeys(input)); err != nil {
		return models.UpstreamOut{}, err
	}

	// An imported archived channel is never visible unarchived, so it never
	// routes between the insert and the archiving.
	if input.Archived != nil && *input.Archived {
		if err := setArchived(ctx, tx, id, true); err != nil {
			return models.UpstreamOut{}, err
		}
	}

	// Read back inside the transaction, so the response describes the channel
	// this call created rather than what a concurrent edit had made of it by
	// the time the read ran.
	row, ok, err := GetUpstream(ctx, tx, id)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	if !ok {
		return models.UpstreamOut{}, apperr.Internal("upstream was not persisted")
	}
	out, err := RowToUpstreamOut(&row)
	if err != nil {
		return out, err
	}
	if out.GroupIDs, err = ListUpstreamGroupIDs(ctx, tx, id); err != nil {
		return out, err
	}

	if err := tx.Commit(); err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	return out, nil
}

// createKeys is the key list a new channel starts with: keys as given, or the
// older single api_key as its one key.
func createKeys(input *models.UpstreamIn) []models.UpstreamKeyIn {
	if input.Keys != nil {
		return *input.Keys
	}
	if input.APIKey != nil {
		return []models.UpstreamKeyIn{{APIKey: *input.APIKey}}
	}
	return nil
}

func UpdateUpstream(ctx context.Context, db *sql.DB, id int64, input *models.UpstreamUpdate) (models.UpstreamOut, error) {
	encoded, err := encodeUpstreamCollections(&input.UpstreamIn)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	rateLimit, err := input.NormalizedRateLimit()
	if err != nil {
		return models.UpstreamOut{}, apperr.BadRequest(err.Error())
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	defer tx.Rollback()

	// The fields this edit does not carry are read inside the transaction that
	// writes them back. Reading them before it meant a save could carry a value
	// another edit had already replaced — restoring an API key that had just
	// been cleared, because the form that did not mention the key still wrote
	// the one it had loaded.
	existing, ok, err := GetUpstream(ctx, tx, id)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	if !ok {
		return models.UpstreamOut{}, apperr.NotFound(fmt.Sprintf("upstream %d not found", id))
	}

	timeout := existing.TimeoutSeconds
	if input.TimeoutSeconds != nil {
		timeout = *input.TimeoutSeconds
	}

	// Unarchived first, so the enabled below is the one that sticks rather than
	// the one unarchiving restores.
	if input.Archived != nil && !*input.Archived {
		if err := setArchived(ctx, tx, id, false); err != nil {
			return models.UpstreamOut{}, err
		}
	}

	// An archived channel stays off whatever the edit says, as archiving
	// guarantees; unarchiving restores what it was.
	_, err = tx.ExecContext(ctx, `UPDATE upstreams
        SET name = ?, base_url = ?,
            model_names = ?, model_prefixes = ?, model_mappings = ?,
            effort_mappings = ?, priority = ?, weight = ?, auto_weight_enabled = ?,
            enabled = CASE WHEN archived = 1 THEN 0 ELSE ? END, extra_headers = ?,
            timeout_seconds = ?, rate_limit = ?, updated_at = datetime('now')
        WHERE id = ?`,
		input.Name, input.BaseURL, encoded.Names, encoded.Prefixes,
		encoded.ModelMappings, encoded.EffortMappings, input.Priority, input.Weight,
		boolToInt64(input.AutoWeightEnabled), boolToInt64(input.Enabled),
		encoded.Headers, timeout, rateLimit, id)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	if err := ReplaceUpstreamGroups(ctx, tx, id, input.GroupIDs); err != nil {
		return models.UpstreamOut{}, err
	}
	// Keys the edit does not mention stay as they are.
	switch {
	case input.ClearAPIKey:
		err = replaceUpstreamKeys(ctx, tx, id, nil)
	case input.Keys != nil:
		err = replaceUpstreamKeys(ctx, tx, id, *input.Keys)
	case input.APIKey != nil:
		err = setLegacyKey(ctx, tx, id, *input.APIKey)
	}
	if err != nil {
		return models.UpstreamOut{}, err
	}

	// Archived last, so it remembers the enabled this edit wrote.
	if input.Archived != nil && *input.Archived {
		if err := setArchived(ctx, tx, id, true); err != nil {
			return models.UpstreamOut{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}

	return reloadUpstreamOut(ctx, db, id)
}

func SetUpstreamEnabled(ctx context.Context, db *sql.DB, id int64, enabled bool) (models.UpstreamOut, error) {
	_, err := db.ExecContext(ctx,
		"UPDATE upstreams SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
		boolToInt64(enabled), id)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	return reloadUpstreamOut(ctx, db, id)
}

func SetUpstreamPriority(ctx context.Context, db *sql.DB, id int64, priority int32) (models.UpstreamOut, error) {
	_, err := db.ExecContext(ctx,
		"UPDATE upstreams SET priority = ?, updated_at = datetime('now') WHERE id = ?",
		priority, id)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	return reloadUpstreamOut(ctx, db, id)
}

func reloadUpstreamOut(ctx context.Context, db *sql.DB, id int64) (models.UpstreamOut, error) {
	row, ok, err := GetUpstream(ctx, db, id)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	if !ok {
		return models.UpstreamOut{}, apperr.NotFound(fmt.Sprintf("upstream %d not found", id))
	}
	out, err := RowToUpstreamOut(&row)
	if err != nil {
		return out, err
	}
	out.GroupIDs, err = ListUpstreamGroupIDs(ctx, db, id)
	return out, err
}

func DeleteUpstream(ctx context.Context, db *sql.DB, id int64) (bool, error) {
	// Finished even if the caller leaves: stopping between the batches and the
	// delete left the channel standing with part of its history cut away.
	ctx = context.WithoutCancel(ctx)
	if err := detachLogs(ctx, db, "upstream_id", id); err != nil {
		return false, err
	}
	return execAffectsAny(ctx, db, "DELETE FROM upstreams WHERE id = ?", id)
}
