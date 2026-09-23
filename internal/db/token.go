package db

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

const tokenPreviewChars = 8

const (
	// apiTokenPrefix follows the convention downstream clients already expect
	// from OpenAI-shaped keys, so a wildtoken value can be pasted anywhere one
	// of those is accepted.
	apiTokenPrefix      = "sk-"
	apiTokenRandomChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	apiTokenRandomLen   = 32
	// apiTokenRandomCutoff is the largest multiple of the alphabet size that
	// still fits in a byte; see GenerateAPIToken for why it matters.
	apiTokenRandomCutoff = byte(256 - 256%len(apiTokenRandomChars))
)

// tokenColumns lists every column of a token row, in the order APITokenRow
// declares them.
//
// token_plain is folded to an empty string here rather than carried as a NULL:
// a row created before plaintext was stored has no recoverable value, and the
// console reads the empty string as "cannot be copied".
const tokenColumns = `t.id, t.name, t.description, t.token_preview,
    COALESCE(t.token_plain, ''), t.enabled,
    t.expires_at, t.created_at, t.updated_at,
    COALESCE(t.group_id, 1),
    COALESCE((SELECT g.name FROM groups g WHERE g.id = t.group_id), 'default'),
    COALESCE(t.used_tokens, 0), t.limit_tokens, t.rate_limit,
    COALESCE(t.allowed_models, '[]')`

// tokenFrom is the FROM clause matching tokenColumns.
const tokenFrom = " FROM api_tokens AS t"

// GenerateAPIToken mints a fresh downstream token.
//
// The random half is drawn by rejection sampling rather than by folding each
// byte with a plain modulo: 256 is not a multiple of the 62-character alphabet,
// so a modulo would hand the first eight characters extra weight and shave
// entropy off every token. Bytes landing above the last whole multiple are
// discarded instead, which costs a reroll on roughly 3% of draws.
func GenerateAPIToken() (string, error) {
	random := make([]byte, 0, apiTokenRandomLen)
	buffer := make([]byte, apiTokenRandomLen)
	for len(random) < apiTokenRandomLen {
		if _, err := rand.Read(buffer); err != nil {
			return "", apperr.Internal("could not generate an API token")
		}
		for _, b := range buffer {
			if b >= apiTokenRandomCutoff {
				continue
			}
			random = append(random, apiTokenRandomChars[int(b)%len(apiTokenRandomChars)])
			if len(random) == apiTokenRandomLen {
				break
			}
		}
	}
	return apiTokenPrefix + string(random), nil
}

// TokenDigest is the form authentication matches against, and the only form
// every token row is guaranteed to carry. Rows issued since the console gained
// a copy button also keep the plaintext in `token_plain`, but nothing on the
// request path reads it.
func TokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// TokenPreview renders the console hint, never revealing a short token in full.
func TokenPreview(token string) string {
	runes := []rune(token)
	visible := len(runes) / 2
	if len(runes) > tokenPreviewChars {
		visible = tokenPreviewChars
	}
	// Half of a short token is most of it: the previous rule showed eight of a
	// nine-character value. A preview exists to tell two credentials apart in a
	// list, which a few characters do, so it never shows more than a quarter of
	// a short one.
	if quarter := len(runes) / 4; visible > quarter {
		visible = quarter
	}
	return string(runes[:visible]) + "…"
}

func scanTokenRow(row interface{ Scan(...any) error }) (models.APITokenRow, string, error) {
	var token models.APITokenRow
	var expiresAt sql.NullString
	var groupName string
	var limitTokens sql.NullInt64
	var rateLimit sql.NullString
	err := row.Scan(&token.ID, &token.Name, &token.Description, &token.TokenPreview,
		&token.Token, &token.Enabled, &expiresAt, &token.CreatedAt, &token.UpdatedAt,
		&token.GroupID, &groupName, &token.UsedTokens, &limitTokens, &rateLimit,
		&token.AllowedModels)
	if err != nil {
		return token, "", err
	}
	if expiresAt.Valid {
		token.ExpiresAt = &expiresAt.String
	}
	if limitTokens.Valid && limitTokens.Int64 > 0 {
		token.LimitTokens = &limitTokens.Int64
	}
	if rateLimit.Valid && rateLimit.String != "" {
		token.RateLimit = &rateLimit.String
	}
	return token, groupName, nil
}

func tokenOut(row models.APITokenRow, groupName string) models.APITokenOut {
	return models.APITokenOut{
		ID:            row.ID,
		Name:          row.Name,
		Description:   row.Description,
		TokenPreview:  row.TokenPreview,
		Token:         row.Token,
		Enabled:       row.Enabled == 1,
		ExpiresAt:     row.ExpiresAt,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
		GroupID:       row.GroupID,
		GroupName:     groupName,
		Quota:         models.NewQuotaState(row.UsedTokens, row.LimitTokens),
		RateLimit:     row.RateLimit,
		AllowedModels: decodeAllowedModels(row.AllowedModels),
	}
}

// decodeAllowedModels reads the stored array. A malformed value, only possible
// through an out-of-band edit, reads as unrestricted — the same verdict the
// auth middleware reaches — so the console shows what the proxy enforces.
func decodeAllowedModels(raw string) []string {
	var allowed []string
	if err := json.Unmarshal([]byte(raw), &allowed); err != nil || allowed == nil {
		return []string{}
	}
	return allowed
}

// encodeAllowedModels renders a normalized list for storage.
func encodeAllowedModels(allowed []string) (string, error) {
	if allowed == nil {
		allowed = []string{}
	}
	encoded, err := json.Marshal(allowed)
	if err != nil {
		return "", apperr.Internal("could not encode allowed models")
	}
	return string(encoded), nil
}

// rejectPastExpiry refuses an expiry that has already passed.
//
// Compared as text rather than as parsed instants: expires_at and SQLite's
// datetime('now') share one fixed-width UTC shape, so this reaches the same
// verdict as the authentication SQL in the auth middleware. Parsing here instead
// would open a window where the console accepts an expiry the proxy already
// treats as dead.
func rejectPastExpiry(expiresAt *string) error {
	if expiresAt == nil {
		return nil
	}
	if *expiresAt <= models.UTCNowTimestamp() {
		return apperr.BadRequest(
			"token expiry must be in the future; disable or delete the token to revoke it now")
	}
	return nil
}

// MigrateLegacyTokenStorage brings a token table up to the current column set
// in one transaction.
//
// The legacy `token` column is retained because its NOT NULL/UNIQUE constraints
// are part of deployed databases. Its values are overwritten with the same
// SHA-256 digest stored in `token_hash`, so nothing readable survives the commit
// in that column — which is exactly why the plaintext the console copies lives
// in `token_plain` instead. Reusing `token` for it would work until the next
// startup, when the cleanup below would overwrite it with the digest again.
func MigrateLegacyTokenStorage(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	columns, err := tableColumns(ctx, tx, "api_tokens")
	if err != nil {
		return err
	}
	hasLegacyToken := columns["token"]
	hasTokenHash := columns["token_hash"]
	hasTokenPreview := columns["token_preview"]
	hasTokenPlain := columns["token_plain"]

	if !hasLegacyToken {
		return errors.New("api_tokens is missing its compatibility token column")
	}
	if !hasTokenHash {
		if _, err := tx.ExecContext(ctx, "ALTER TABLE api_tokens ADD COLUMN token_hash TEXT"); err != nil {
			return err
		}
	}
	if !hasTokenPreview {
		if _, err := tx.ExecContext(ctx,
			"ALTER TABLE api_tokens ADD COLUMN token_preview TEXT NOT NULL DEFAULT ''"); err != nil {
			return err
		}
	}
	// Nullable and undefaulted: existing rows have no plaintext to backfill, and
	// NULL says that honestly where '' would read as an empty credential.
	if !hasTokenPlain {
		if _, err := tx.ExecContext(ctx,
			"ALTER TABLE api_tokens ADD COLUMN token_plain TEXT"); err != nil {
			return err
		}
	}

	// Driven by the rows that actually need repair rather than by whether the
	// column had to be added. The two agree only on a first migration: a
	// database whose column already exists but whose rows were left without a
	// digest — added by hand, restored from a partial copy — never reached the
	// repair and failed the check below on every start, with no way out.
	missingHashes, err := countMissingTokenHashes(ctx, tx)
	if err != nil {
		return err
	}
	if missingHashes != 0 {
		if err := hashLegacyPlaintextTokens(ctx, tx); err != nil {
			return err
		}
		if missingHashes, err = countMissingTokenHashes(ctx, tx); err != nil {
			return err
		}
	}
	if missingHashes != 0 {
		return errors.New("api_tokens contains rows without a token digest")
	}

	// Clear compatibility-column plaintext after every startup. This is also a
	// repair guard for databases whose legacy column was modified out of band.
	if _, err := tx.ExecContext(ctx,
		"UPDATE api_tokens SET token = token_hash WHERE token <> token_hash"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash)"); err != nil {
		return err
	}

	return tx.Commit()
}

func tableColumns(ctx context.Context, tx *sql.Tx, table string) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx,
		fmt.Sprintf("SELECT name FROM pragma_table_info('%s') ORDER BY cid", table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}

// countMissingTokenHashes reports how many rows still lack a digest.
func countMissingTokenHashes(ctx context.Context, tx *sql.Tx) (int64, error) {
	var missing int64
	err := tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM api_tokens WHERE token_hash IS NULL").Scan(&missing)
	return missing, err
}

// hashLegacyPlaintextTokens replaces every plaintext value with its digest,
// using a collision-free marker for the legacy UNIQUE column.
func hashLegacyPlaintextTokens(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SELECT id, token FROM api_tokens ORDER BY id")
	if err != nil {
		return err
	}
	type legacyToken struct {
		id        int64
		plaintext string
	}
	var legacy []legacyToken
	for rows.Next() {
		var entry legacyToken
		if err := rows.Scan(&entry.id, &entry.plaintext); err != nil {
			rows.Close()
			return err
		}
		legacy = append(legacy, entry)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	markerPrefix, err := uniqueMarkerPrefix()
	if err != nil {
		return err
	}

	for _, entry := range legacy {
		_, err := tx.ExecContext(ctx,
			"UPDATE api_tokens SET token = ?, token_hash = ?, token_preview = ? WHERE id = ?",
			fmt.Sprintf("%s%d", markerPrefix, entry.id),
			TokenDigest(entry.plaintext), TokenPreview(entry.plaintext), entry.id)
		if err != nil {
			return err
		}
	}
	return nil
}

func uniqueMarkerPrefix() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return fmt.Sprintf("__wildtoken_token_migration_%s__",
		base64.RawURLEncoding.EncodeToString(bytes)), nil
}

func ListTokens(ctx context.Context, db *sql.DB) ([]models.APITokenOut, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT "+tokenColumns+tokenFrom+" ORDER BY t.id ASC")
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	tokens := []models.APITokenOut{}
	for rows.Next() {
		row, groupName, err := scanTokenRow(rows)
		if err != nil {
			return nil, apperr.Database(err)
		}
		tokens = append(tokens, tokenOut(row, groupName))
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return tokens, nil
}

// GetToken returns ok=false when no row carries the id. It takes a Queryer so an
// edit can read the row it is about to rewrite from inside its own transaction.
func GetToken(ctx context.Context, db Queryer, id int64) (models.APITokenOut, bool, error) {
	row := db.QueryRowContext(ctx, "SELECT "+tokenColumns+tokenFrom+" WHERE t.id = ?", id)
	entry, groupName, err := scanTokenRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return models.APITokenOut{}, false, nil
	}
	if err != nil {
		return models.APITokenOut{}, false, apperr.Database(err)
	}
	return tokenOut(entry, groupName), true, nil
}

func CreateToken(ctx context.Context, db *sql.DB, input *models.APITokenIn) (models.APITokenCreatedOut, error) {
	if err := input.Validate(); err != nil {
		return models.APITokenCreatedOut{}, apperr.BadRequest(err.Error())
	}
	expiresAt, err := input.NormalizedExpiresAt()
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.BadRequest(err.Error())
	}
	if err := rejectPastExpiry(expiresAt); err != nil {
		return models.APITokenCreatedOut{}, err
	}

	tokenValue := ""
	if input.Token != nil {
		tokenValue = *input.Token
	} else {
		if tokenValue, err = GenerateAPIToken(); err != nil {
			return models.APITokenCreatedOut{}, err
		}
	}
	digest := TokenDigest(tokenValue)
	preview := TokenPreview(tokenValue)

	limitTokens, err := input.ParsedLimit()
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.BadRequest(err.Error())
	}
	rateLimit, err := input.NormalizedRateLimit()
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.BadRequest(err.Error())
	}
	allowed, err := models.NormalizeAllowedModels(input.AllowedModels)
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.BadRequest(err.Error())
	}
	allowedModels, err := encodeAllowedModels(allowed)
	if err != nil {
		return models.APITokenCreatedOut{}, err
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.Database(err)
	}
	defer tx.Rollback()

	// The group is checked inside the transaction that writes the reference to
	// it. api_tokens.group_id carries no foreign key, so nothing but this
	// ordering stops a group deleted between the check and the insert from
	// leaving a token pointing at one that no longer exists — a token that then
	// authenticates but reaches no channel at all, with nothing in the console
	// to say why. UpdateToken already reads it this way.
	groupID, err := resolveTokenGroup(ctx, tx, input.GroupID)
	if err != nil {
		return models.APITokenCreatedOut{}, err
	}

	result, err := tx.ExecContext(ctx, `INSERT INTO api_tokens
        (name, description, token, token_hash, token_preview, token_plain, enabled, expires_at, group_id, limit_tokens, rate_limit, allowed_models, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		trimSpace(input.Name), trimSpace(input.Description), digest, digest, preview,
		tokenValue, boolToInt64(input.Enabled), expiresAt, groupID, limitTokens, rateLimit,
		allowedModels)
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.Database(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.Database(err)
	}

	// Read back inside the transaction: it describes the row this insert made,
	// where a read after the commit could pick up a later edit and report it as
	// this one's result.
	created, ok, err := GetToken(ctx, tx, id)
	if err != nil {
		return models.APITokenCreatedOut{}, err
	}
	if !ok {
		return models.APITokenCreatedOut{}, apperr.Internal("token was not persisted")
	}

	if err := tx.Commit(); err != nil {
		return models.APITokenCreatedOut{}, apperr.Database(err)
	}

	return models.APITokenCreatedOut{
		ID:            created.ID,
		Name:          created.Name,
		Description:   created.Description,
		Token:         tokenValue,
		TokenPreview:  created.TokenPreview,
		Enabled:       created.Enabled,
		ExpiresAt:     created.ExpiresAt,
		CreatedAt:     created.CreatedAt,
		UpdatedAt:     created.UpdatedAt,
		GroupID:       created.GroupID,
		GroupName:     created.GroupName,
		Quota:         created.Quota,
		RateLimit:     created.RateLimit,
		AllowedModels: created.AllowedModels,
	}, nil
}

// resolveTokenGroup validates a requested group, defaulting when absent.
//
// A token must always name a group that exists: with no group it would reach no
// channel, which reads as a routing bug rather than a configuration choice.
func resolveTokenGroup(ctx context.Context, db Queryer, requested *int64) (int64, error) {
	groupID := models.DefaultGroupID
	if requested != nil && *requested > 0 {
		groupID = *requested
	}
	exists, err := GroupExists(ctx, db, groupID)
	if err != nil {
		return 0, err
	}
	if !exists {
		return 0, apperr.BadRequest("group does not exist")
	}
	return groupID, nil
}

// UpdateToken applies a console edit, replacing the credential itself when the
// payload carries a new one.
//
// Everything from reading the row to reading it back runs in one transaction.
// The token value is the reason: deciding whether a requested value is free and
// then claiming it are only sound as one step, and outside a transaction another
// edit could take the value in between. The write lock is held from BEGIN (see
// db.SQLiteTxLock), so a concurrent edit waits and then observes the committed
// state rather than racing this one.
func UpdateToken(ctx context.Context, db *sql.DB, id int64, input *models.APITokenUpdateIn) (models.APITokenOut, error) {
	if err := input.Validate(); err != nil {
		return models.APITokenOut{}, apperr.BadRequest(err.Error())
	}
	expiresAt, err := input.NormalizedExpiresAt()
	if err != nil {
		return models.APITokenOut{}, apperr.BadRequest(err.Error())
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.APITokenOut{}, apperr.Database(err)
	}
	defer tx.Rollback()

	existing, ok, err := GetToken(ctx, tx, id)
	if err != nil {
		return models.APITokenOut{}, err
	}
	if !ok {
		return models.APITokenOut{}, apperr.NotFound("token not found")
	}

	// Only a changed expiry has to be in the future. Editing a token that has
	// already lapsed sends its own past expiry back unchanged, and rejecting
	// that would make renaming an expired token impossible without renewing it.
	if !equalOptionalString(expiresAt, existing.ExpiresAt) {
		if err := rejectPastExpiry(expiresAt); err != nil {
			return models.APITokenOut{}, err
		}
	}

	groupID, err := resolveTokenGroup(ctx, tx, input.GroupID)
	if err != nil {
		return models.APITokenOut{}, err
	}

	limitTokens, err := input.ParsedLimit()
	if err != nil {
		return models.APITokenOut{}, apperr.BadRequest(err.Error())
	}

	replacement, err := plannedTokenReplacement(ctx, tx, id, existing, input)
	if err != nil {
		return models.APITokenOut{}, err
	}

	rateLimit, err := input.NormalizedRateLimit()
	if err != nil {
		return models.APITokenOut{}, apperr.BadRequest(err.Error())
	}
	allowed, err := models.NormalizeAllowedModels(input.AllowedModels)
	if err != nil {
		return models.APITokenOut{}, apperr.BadRequest(err.Error())
	}
	allowedModels, err := encodeAllowedModels(allowed)
	if err != nil {
		return models.APITokenOut{}, err
	}

	query := `UPDATE api_tokens SET name = ?, description = ?, expires_at = ?,
        group_id = ?, limit_tokens = ?, rate_limit = ?, allowed_models = ?,
        updated_at = datetime('now')`
	args := []any{trimSpace(input.Name), trimSpace(input.Description),
		expiresAt, groupID, limitTokens, rateLimit, allowedModels}
	if replacement != "" {
		// The same four columns CreateToken writes, kept in step: the legacy
		// `token` column takes the digest because the startup migration
		// overwrites it from token_hash anyway.
		digest := TokenDigest(replacement)
		query += ", token = ?, token_hash = ?, token_preview = ?, token_plain = ?"
		args = append(args, digest, digest, TokenPreview(replacement), replacement)
	}
	query += " WHERE id = ?"
	args = append(args, id)

	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		// The transaction closes the window against another edit, but the table's
		// UNIQUE constraints remain the authority: they also cover the name, and
		// they are what a value inserted by a path this store does not see would
		// collide with.
		if IsUniqueViolation(err) {
			return models.APITokenOut{}, apperr.BadRequest("token name or value already exists")
		}
		return models.APITokenOut{}, apperr.Database(err)
	}

	// Read back inside the transaction: it describes the row this edit produced,
	// where a read after the commit could pick up the next edit's work and report
	// it as this one's result.
	updated, err := reloadToken(ctx, tx, id)
	if err != nil {
		return models.APITokenOut{}, err
	}
	if err := tx.Commit(); err != nil {
		return models.APITokenOut{}, apperr.Database(err)
	}
	return updated, nil
}

// plannedTokenReplacement returns the credential this edit should store, or ""
// when the current one stays.
//
// The console sends the token back on every save, so "unchanged" is the normal
// case and must not be treated as an edit: rewriting the row would churn the
// digest and make a token collide with its own unique index. A real change needs
// no invalidation beyond the write — authentication resolves token_hash on every
// request with nothing cached in front of it (see the lookup in the auth
// middleware), so the old value stops working the moment this commits.
//
// It takes a Queryer because the occupancy check below is only meaningful in the
// same transaction as the write that acts on it.
func plannedTokenReplacement(ctx context.Context, db Queryer, id int64,
	existing models.APITokenOut, input *models.APITokenUpdateIn) (string, error) {
	// The value itself was already judged by input.Validate above, under the
	// same rules creation applies.
	requested := input.RequestedToken()
	if requested == "" || requested == existing.Token {
		return "", nil
	}

	// Rows are matched by digest rather than by plaintext: a row that predates
	// plaintext storage has none, and it still owns the value. Excluding this
	// row keeps a re-submitted value from colliding with itself.
	var taken int64
	err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM api_tokens WHERE token_hash = ? AND id <> ?",
		TokenDigest(requested), id).Scan(&taken)
	if err != nil {
		return "", apperr.Database(err)
	}
	if taken != 0 {
		return "", apperr.BadRequest("token value is already used by another token")
	}
	return requested, nil
}

func SetTokenEnabled(ctx context.Context, db *sql.DB, id int64, enabled bool) (models.APITokenOut, error) {
	_, err := db.ExecContext(ctx,
		"UPDATE api_tokens SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
		boolToInt64(enabled), id)
	if err != nil {
		return models.APITokenOut{}, apperr.Database(err)
	}
	return reloadToken(ctx, db, id)
}

func reloadToken(ctx context.Context, db Queryer, id int64) (models.APITokenOut, error) {
	token, ok, err := GetToken(ctx, db, id)
	if err != nil {
		return models.APITokenOut{}, err
	}
	if !ok {
		return models.APITokenOut{}, apperr.NotFound("token not found")
	}
	return token, nil
}

func DeleteToken(ctx context.Context, db *sql.DB, id int64) (bool, error) {
	return execAffectsAny(ctx, db, "DELETE FROM api_tokens WHERE id = ?", id)
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// ResetTokenUsage clears a token's running total, so an operator can hand the
// same credential a fresh budget without reissuing it.
func ResetTokenUsage(ctx context.Context, db *sql.DB, id int64) (models.APITokenOut, error) {
	result, err := db.ExecContext(ctx,
		"UPDATE api_tokens SET used_tokens = 0, updated_at = datetime('now') WHERE id = ?", id)
	if err != nil {
		return models.APITokenOut{}, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return models.APITokenOut{}, apperr.Database(err)
	}
	if affected == 0 {
		return models.APITokenOut{}, apperr.NotFound("token not found")
	}
	return reloadToken(ctx, db, id)
}
