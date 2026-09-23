package models

import (
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

const (
	APITokenNameMaxChars        = 80
	APITokenDescriptionMaxChars = 200
	// APITokenMinBytes no longer floors a custom token at 16 bytes. The warning
	// and second confirmation below that threshold belong to the console rather
	// than here, and the current console does not implement them: a
	// stateless request cannot distinguish an operator who was warned and
	// accepted from one who never saw the warning, so enforcing it server-side
	// would either refuse the confirmed case or need a "yes I mean it" flag that
	// any client could set. What is left here is what is structurally invalid —
	// empty, or too long.
	APITokenMinBytes = 1
	APITokenMaxBytes = 256

	// Bounds on a token's model allowlist.
	APITokenAllowedModelsMax     = 500
	APITokenAllowedModelMaxChars = 200
)

// TimestampFormat is the shape SQLite's `datetime('now')` produces, and the only
// shape `expires_at` is ever stored in. Fixed width and zero padded, so lexical
// order is chronological order — which is what lets the authentication SQL in
// middleware and the checks in the token store compare expiries as plain strings
// and always reach the same verdict.
const TimestampFormat = "2006-01-02 15:04:05"

const expiryFormatError = ErrString(
	"token expiry must be an RFC 3339 timestamp or 'YYYY-MM-DD HH:MM:SS' in UTC")

// UTCNowTimestamp renders now in the stored timestamp shape, for comparison
// against an expiry.
func UTCNowTimestamp() string {
	return time.Now().UTC().Format(TimestampFormat)
}

// NormalizeExpiresAt converts a caller-supplied expiry into the stored UTC shape.
//
// A blank value means "never expires" and is reported as nil, so clearing the
// console's expiry field behaves the same whether the client sends `null` or
// `""`. Whether the result lies in the past is not decided here — that depends
// on the row being written, and lives in the token store.
func NormalizeExpiresAt(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	value := strings.TrimSpace(*raw)
	if value == "" {
		return nil, nil
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		normalized := parsed.UTC().Format(TimestampFormat)
		return &normalized, nil
	}
	if parsed, err := time.Parse(TimestampFormat, value); err == nil {
		normalized := parsed.UTC().Format(TimestampFormat)
		return &normalized, nil
	}
	return nil, expiryFormatError
}

// APITokenRow mirrors a row of the `api_tokens` table.
type APITokenRow struct {
	ID           int64
	Name         string
	Description  string
	TokenPreview string
	// Token is the stored plaintext, empty for rows written before it was kept.
	Token       string
	Enabled     int64
	ExpiresAt   *string
	CreatedAt   string
	UpdatedAt   string
	GroupID     int64
	UsedTokens  int64
	LimitTokens *int64
	RateLimit   *string
	// AllowedModels is the JSON array string, "[]" when unrestricted.
	AllowedModels string
}

// APITokenIn is the create payload. A nil Token means "generate one".
type APITokenIn struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Token       *string `json:"token"`
	Enabled     bool    `json:"enabled"`
	// ExpiresAt absent, null or blank means the token never expires.
	ExpiresAt *string `json:"expires_at"`
	// GroupID scopes which channels this token may reach. Absent means the
	// default group.
	GroupID *int64 `json:"group_id"`
	// LimitExpression is a token limit such as 100M or 1B. Blank means no limit.
	LimitExpression string `json:"limit_expression"`
	// RateLimit is a rate limit expression such as "100/m" or "1000/h". Blank means no limit.
	RateLimit *string `json:"rate_limit"`
	// AllowedModels restricts which models this token may request. Empty means
	// any. A trailing "*" matches by prefix: "gpt-4*" covers "gpt-4o".
	AllowedModels []string `json:"allowed_models"`
}

// APITokenUpdateIn is a full replacement, so an absent `expires_at` clears the
// expiry rather than leaving it alone. The console always sends the field.
type APITokenUpdateIn struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	ExpiresAt   *string `json:"expires_at"`
	GroupID     *int64  `json:"group_id"`
	// Token replaces the credential itself. Unlike ExpiresAt this is not a full
	// replacement: absent, null and blank all leave the current value alone. The
	// console echoes the token back on every save, and reading a blank field as
	// "erase it" would leave a row nobody can authenticate with.
	Token *string `json:"token"`
	// LimitExpression is a token limit such as 100M or 1B. Blank means no limit.
	LimitExpression string `json:"limit_expression"`
	// RateLimit is a rate limit expression such as "100/m" or "1000/h". Blank means no limit.
	RateLimit *string `json:"rate_limit"`
	// AllowedModels restricts which models this token may request. Empty means
	// any. A trailing "*" matches by prefix: "gpt-4*" covers "gpt-4o".
	AllowedModels []string `json:"allowed_models"`
}

// RequestedToken is the replacement value, or "" when this edit keeps the
// current one.
func (t *APITokenUpdateIn) RequestedToken() string {
	if t.Token == nil {
		return ""
	}
	return *t.Token
}

// NormalizeRateLimit validates and trims a rate limit expression.
//
// A nil or blank value means "no rate limit" and is reported as nil, matching
// how the expiry field treats absence. The parsed form is discarded here — the
// stored shape is the expression itself, so the console can echo back exactly
// what the operator wrote.
func NormalizeRateLimit(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	value := strings.TrimSpace(*raw)
	if value == "" {
		return nil, nil
	}
	if _, err := ratelimit.ParseRateLimit(value); err != nil {
		return nil, ErrString("rate limit must look like 100/m, 1000/h or 50/10s")
	}
	return &value, nil
}

// NormalizeAllowedModels trims, drops blanks and case-insensitive duplicates.
//
// "*" is only meaningful at the end; one anywhere else reads like a glob the
// matcher does not implement, so it is refused rather than silently matching
// nothing.
func NormalizeAllowedModels(raw []string) ([]string, error) {
	seen := map[string]bool{}
	out := []string{}
	for _, entry := range raw {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			continue
		}
		if utf8.RuneCountInString(trimmed) > APITokenAllowedModelMaxChars {
			return nil, ErrString("allowed model names must be at most 200 characters")
		}
		if strings.ContainsFunc(trimmed, unicode.IsControl) {
			return nil, ErrString("allowed model names must not contain control characters")
		}
		if strings.Contains(strings.TrimSuffix(trimmed, "*"), "*") || trimmed == "*" {
			return nil, ErrString("\"*\" is only allowed at the end of a model name, after a prefix")
		}

		key := strings.ToLower(trimmed)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, trimmed)
	}
	if len(out) > APITokenAllowedModelsMax {
		return nil, ErrString("a token may list at most 500 allowed models")
	}
	return out, nil
}

// ModelAllowed reports whether model passes an allowlist. An empty list allows
// everything. Matching is case-insensitive, like channel routing.
//
//	["gpt-4o", "claude-*"]: "GPT-4o" yes, "claude-sonnet-5" yes, "o3" no
func ModelAllowed(allowed []string, model string) bool {
	if len(allowed) == 0 {
		return true
	}
	target := strings.ToLower(strings.TrimSpace(model))
	for _, entry := range allowed {
		pattern := strings.ToLower(entry)
		if prefix, ok := strings.CutSuffix(pattern, "*"); ok {
			if strings.HasPrefix(target, prefix) {
				return true
			}
			continue
		}
		if target == pattern {
			return true
		}
	}
	return false
}

// validateTokenMetadata judges the name and description that will be stored, and
// writes the trimmed values back through the pointers it is given.
//
// The stores trim before writing, so the check has to be against the trimmed
// value or it answers about a different string than the one that lands in the
// database: a name padded past the limit with spaces was refused for a length it
// would not have had, and the emptiness check was already trimming while the
// length check beside it was not.
func validateTokenMetadata(name, description *string) error {
	trimmedName := strings.TrimSpace(*name)
	if trimmedName == "" || utf8.RuneCountInString(trimmedName) > APITokenNameMaxChars {
		return ErrString("token name must be between 1 and 80 characters")
	}
	if strings.ContainsFunc(trimmedName, unicode.IsControl) {
		return ErrString("token name must not contain control characters")
	}

	trimmedDescription := strings.TrimSpace(*description)
	if utf8.RuneCountInString(trimmedDescription) > APITokenDescriptionMaxChars {
		return ErrString("token description must be at most 200 characters")
	}
	if strings.ContainsFunc(trimmedDescription, unicode.IsControl) {
		return ErrString("token description must not contain control characters")
	}

	*name = trimmedName
	*description = trimmedDescription
	return nil
}

func isASCIIGraphic(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] <= 0x20 || value[i] >= 0x7f {
			return false
		}
	}
	return true
}

// validateTokenValue judges an operator-supplied credential. Creation and
// editing share it so a value the create endpoint refuses cannot be smuggled in
// through an update.
func validateTokenValue(token string) error {
	if len(token) < APITokenMinBytes || len(token) > APITokenMaxBytes {
		return ErrString("custom token must be between 1 and 256 bytes")
	}
	if !isASCIIGraphic(token) {
		return ErrString("custom token must contain only printable ASCII characters without spaces")
	}
	return nil
}

func (t *APITokenIn) Validate() error {
	if err := validateTokenMetadata(&t.Name, &t.Description); err != nil {
		return err
	}
	if _, err := t.NormalizedExpiresAt(); err != nil {
		return err
	}
	if _, err := t.ParsedLimit(); err != nil {
		return err
	}
	if _, err := t.NormalizedRateLimit(); err != nil {
		return err
	}
	if _, err := NormalizeAllowedModels(t.AllowedModels); err != nil {
		return err
	}
	if t.Token == nil {
		return nil
	}
	return validateTokenValue(*t.Token)
}

func (t *APITokenIn) NormalizedExpiresAt() (*string, error) {
	return NormalizeExpiresAt(t.ExpiresAt)
}

// ParsedLimit resolves the limit expression into a stored token count.
func (t *APITokenIn) ParsedLimit() (*int64, error) {
	return ParseQuotaExpression(t.LimitExpression)
}

// NormalizedRateLimit validates the rate limit expression for storage.
func (t *APITokenIn) NormalizedRateLimit() (*string, error) {
	return NormalizeRateLimit(t.RateLimit)
}

func (t *APITokenUpdateIn) Validate() error {
	if err := validateTokenMetadata(&t.Name, &t.Description); err != nil {
		return err
	}
	if _, err := t.NormalizedExpiresAt(); err != nil {
		return err
	}
	if _, err := t.ParsedLimit(); err != nil {
		return err
	}
	if _, err := t.NormalizedRateLimit(); err != nil {
		return err
	}
	if _, err := NormalizeAllowedModels(t.AllowedModels); err != nil {
		return err
	}
	// A blank token means "leave it alone", so it never reaches the value rules.
	if requested := t.RequestedToken(); requested != "" {
		return validateTokenValue(requested)
	}
	return nil
}

func (t *APITokenUpdateIn) NormalizedExpiresAt() (*string, error) {
	return NormalizeExpiresAt(t.ExpiresAt)
}

// ParsedLimit resolves the limit expression into a stored token count.
func (t *APITokenUpdateIn) ParsedLimit() (*int64, error) {
	return ParseQuotaExpression(t.LimitExpression)
}

// NormalizedRateLimit validates the rate limit expression for storage.
func (t *APITokenUpdateIn) NormalizedRateLimit() (*string, error) {
	return NormalizeRateLimit(t.RateLimit)
}

// APITokenOut carries the full token value so the console can hand a credential
// back to the operator who owns it.
type APITokenOut struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Token is the plaintext, or "" for a row issued before plaintext was
	// stored — those cannot be recovered. Always serialized, never null, so a
	// client can test one field instead of distinguishing absent from empty.
	Token        string     `json:"token"`
	TokenPreview string     `json:"token_preview"`
	Enabled      bool       `json:"enabled"`
	ExpiresAt    *string    `json:"expires_at"`
	CreatedAt    string     `json:"created_at"`
	UpdatedAt    string     `json:"updated_at"`
	GroupID      int64      `json:"group_id"`
	GroupName    string     `json:"group_name"`
	Quota        QuotaState `json:"quota"`
	RateLimit    *string    `json:"rate_limit"`
	// AllowedModels is never null; empty means any model.
	AllowedModels []string `json:"allowed_models"`
}

// APITokenCreatedOut is what the creation endpoint answers with.
//
// It carries the full token, but so does APITokenOut: the console lets an
// operator copy a credential back out at any time, so token_plain is stored and
// the list and detail endpoints return it too. This is not a one-time reveal,
// and reading it as one understates where plaintext tokens are exposed.
type APITokenCreatedOut struct {
	ID           int64      `json:"id"`
	Name         string     `json:"name"`
	Description  string     `json:"description"`
	Token        string     `json:"token"`
	TokenPreview string     `json:"token_preview"`
	Enabled      bool       `json:"enabled"`
	ExpiresAt    *string    `json:"expires_at"`
	CreatedAt    string     `json:"created_at"`
	UpdatedAt    string     `json:"updated_at"`
	GroupID      int64      `json:"group_id"`
	GroupName    string     `json:"group_name"`
	Quota        QuotaState `json:"quota"`
	RateLimit    *string    `json:"rate_limit"`
	// AllowedModels is never null; empty means any model.
	AllowedModels []string `json:"allowed_models"`
}

// TokenEnabledIn toggles a token.
//
// It mirrors UpstreamEnabledIn rather than reusing it, so the endpoint's
// contract names what it operates on, and it is a pointer for the same reason:
// a body of {} must not read as "disable this credential".
type TokenEnabledIn struct {
	Enabled *bool `json:"enabled"`
}

// Value returns the requested state, or an error when the body named none.
func (t *TokenEnabledIn) Value() (bool, error) {
	if t.Enabled == nil {
		return false, ErrString("enabled is required")
	}
	return *t.Enabled, nil
}
