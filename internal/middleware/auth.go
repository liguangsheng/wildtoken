// Package middleware authenticates admin and downstream API callers.
package middleware

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/quota"
	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

type contextKey int

const (
	adminAuthKey contextKey = iota
	downstreamAuthKey
)

// AdminAuth records the credential snapshot a request authenticated against.
type AdminAuth struct {
	// CredentialVersion is the generation this request proved itself against.
	// Handlers that mutate the credential use it as their CAS precondition.
	CredentialVersion int64
}

// AdminAuthFrom returns the admin authentication attached to an authorized
// request.
func AdminAuthFrom(ctx context.Context) (AdminAuth, bool) {
	auth, ok := ctx.Value(adminAuthKey).(AdminAuth)
	return auth, ok
}

// DownstreamAuth identifies the API token a proxied request presented.
type DownstreamAuth struct {
	TokenID    int64
	TokenName  string
	ClientType string
	// GroupID scopes which channels this token may reach.
	GroupID int64
	// UsedTokens and LimitTokens carry the quota state this request was admitted
	// under. LimitTokens is nil when the token is unlimited.
	UsedTokens  int64
	LimitTokens *int64
	// AllowedModels restricts requestable models; empty means any.
	AllowedModels []string
}

// DownstreamAuthFrom returns the downstream authentication attached to an
// authorized request.
func DownstreamAuthFrom(ctx context.Context) (DownstreamAuth, bool) {
	auth, ok := ctx.Value(downstreamAuthKey).(DownstreamAuth)
	return auth, ok
}

// RequireAdmin verifies the `x-admin-token` header against the current Argon2id
// credential snapshot. All authentication failures are deliberately
// indistinguishable to callers.
//
// clientIPHeader names the forwarded header to trust, and is empty when no
// proxy sits in front of the service.
func RequireAdmin(credentials *authstate.Credentials, clientIPHeader string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := r.Header.Get("x-admin-token")
			if token == "" {
				writeUnauthorized(w)
				return
			}

			client := adminClient(r, clientIPHeader)
			credentialVersion, ok := credentials.Authenticate(token, client)
			if !ok {
				writeUnauthorized(w)
				return
			}

			ctx := context.WithValue(r.Context(), adminAuthKey,
				AdminAuth{CredentialVersion: credentialVersion})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeUnauthorized(w http.ResponseWriter) {
	apperr.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

// adminClient identifies the caller for throttling purposes.
//
// A forwarded header is only consulted when the operator has named one and the
// connection came from somewhere that proxy could be: a reverse proxy reaches
// the gateway over loopback or a private network. Honouring the header from any
// peer at all would let a caller that can reach the port directly invent a fresh
// address per request and never accumulate a failure streak to be blocked for.
//
// An address learned that way is always treated as remote — otherwise anyone
// could claim 127.0.0.1 and count against the operator's own gate.
func adminClient(r *http.Request, clientIPHeader string) authstate.Client {
	peer := peerAddr(r)

	if clientIPHeader != "" && couldBeProxy(peer) {
		forwarded := r.Header.Get(clientIPHeader)
		if forwarded != "" {
			first, _, _ := strings.Cut(forwarded, ",")
			if addr, ok := parseForwardedAddr(first); ok {
				return authstate.Client{Kind: authstate.ClientRemote, Addr: addr}
			}
		}
	}

	if !peer.IsValid() {
		return authstate.UnknownClient()
	}
	return authstate.ClientFromAddr(peer)
}

// peerAddr is the address of the machine that opened the connection, which is
// the one piece of the request a caller cannot choose.
func peerAddr(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return addr.Unmap()
}

// carrierGradeNAT is 100.64.0.0/10, which is not covered by Addr.IsPrivate but
// is where a mesh VPN such as Tailscale puts its nodes — a reverse proxy there
// is a real deployment, and ignoring its forwarded header would collapse every
// operator onto one throttle entry.
var carrierGradeNAT = netip.MustParsePrefix("100.64.0.0/10")

// couldBeProxy reports whether a connection plausibly came from the operator's
// own reverse proxy rather than straight off the internet.
//
// A proxy on a public address cannot be recognised from the connection alone,
// so its forwarded header is ignored and its callers are tracked by the proxy's
// own address. That is the safe direction — a forged header cannot shed a
// failure streak — but it is worth knowing before putting one there.
func couldBeProxy(addr netip.Addr) bool {
	return addr.IsValid() &&
		(addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
			carrierGradeNAT.Contains(addr))
}

// parseForwardedAddr accepts the bare address, `host:port` and `[v6]:port`
// forms proxies sometimes emit.
func parseForwardedAddr(value string) (netip.Addr, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return netip.Addr{}, false
	}
	if addr, err := netip.ParseAddr(value); err == nil {
		return addr.Unmap(), true
	}
	if addrPort, err := netip.ParseAddrPort(value); err == nil {
		return addrPort.Addr().Unmap(), true
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		if addr, err := netip.ParseAddr(host); err == nil {
			return addr.Unmap(), true
		}
	}
	// A bracketed literal without a port is not valid for either parser above.
	if trimmed := strings.TrimSuffix(strings.TrimPrefix(value, "["), "]"); trimmed != value {
		if addr, err := netip.ParseAddr(trimmed); err == nil {
			return addr.Unmap(), true
		}
	}
	return netip.Addr{}, false
}

// RequireDownstream validates the caller's API token against the api_tokens
// table, accepting only enabled and unexpired rows.
func RequireDownstream(database *sql.DB, limiter *ratelimit.Limiter,
	quotas *quota.Tracker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Anthropic clients authenticate with x-api-key and expect their own
			// error shape.
			// Derived the same way the handler and the header builder derive
			// it. Comparing the raw path meant /v1//messages authenticated as
			// OpenAI here while being forwarded as Anthropic, so a caller using
			// x-api-key was refused on a route that would have accepted it.
			anthropic := models.IsAnthropicMessages(models.ProxyPath(r.URL.Path))

			token, ok := extractDownstreamToken(r, anthropic)
			if !ok {
				writeDownstreamRejection(w, anthropic, http.StatusUnauthorized,
					"Incorrect API key provided")
				return
			}

			credential, found, err := LookupEnabledDownstreamToken(r.Context(), database, token)
			if err != nil {
				writeDownstreamRejection(w, anthropic, http.StatusInternalServerError,
					"database error")
				return
			}
			if !found {
				writeDownstreamRejection(w, anthropic, http.StatusUnauthorized,
					"Incorrect API key provided")
				return
			}

			/* An exhausted quota is refused before the request reaches an
			   upstream. The stored total is not the whole of what is spent:
			   requests still running have a cost nobody knows yet, and requests
			   that just finished have one the batched writer has not committed.
			   Both are weighed here, because on the stored total alone every
			   request of a burst read the same figure, each found the same room,
			   and each was admitted — overshooting the limit by as much as
			   happened to arrive at once.

			   The request that crosses the limit is still allowed to finish: its
			   cost is only known once the response completes. */
			reservation, admitted := quotas.Admit(credential.TokenID,
				credential.UsedTokens, credential.LimitTokens)
			defer reservation.Release()
			if !admitted {
				// The message reports the stored total, not what admission
				// weighed. The weighed figure counts a provisional charge for
				// requests still running, so reporting it as "used" would name a
				// quantity that matches no record the operator can look at and
				// that changes with the concurrency of the moment.
				writeDownstreamQuotaRejection(w, anthropic,
					models.QuotaExceededMessage(credential.UsedTokens, *credential.LimitTokens))
				return
			}

			/* The rate limit is enforced after the quota so an exhausted token
			   reports its quota, not its rate: the quota message tells the caller
			   the credential itself is out of budget, which is the more permanent
			   condition. The expression is parsed on every request — it survived
			   validation at write time, so a parse failure here means the row was
			   edited out of band, and the request is admitted rather than refused
			   on a config error the caller cannot fix. */
			if credential.RateLimit != nil {
				if parsed, err := ratelimit.ParseRateLimit(*credential.RateLimit); err == nil {
					if !limiter.Check(credential.TokenID, parsed) {
						writeDownstreamRateLimitRejection(w, anthropic, *credential.RateLimit)
						return
					}
				}
			}

			ctx := context.WithValue(r.Context(), downstreamAuthKey, DownstreamAuth{
				TokenID:       credential.TokenID,
				TokenName:     credential.TokenName,
				ClientType:    DetectClientType(r, anthropic),
				GroupID:       credential.GroupID,
				UsedTokens:    credential.UsedTokens,
				LimitTokens:   credential.LimitTokens,
				AllowedModels: credential.AllowedModels,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeDownstreamRejection(w http.ResponseWriter, anthropic bool, status int, message string) {
	writeDownstreamError(w, anthropic, status, message, "invalid_api_key", "authentication_error")
}

// QuotaExhaustedCode identifies an exhausted token quota at the top level of the
// refusal, where a caller that does not speak either vendor's error shape can
// branch on it.
const QuotaExhaustedCode = "API_KEY_QUOTA_EXHAUSTED"

// QuotaExhaustedMessage is the operator-facing summary carried alongside the
// code. The detailed figures stay in the nested error a vendor SDK reads.
const QuotaExhaustedMessage = "API key 额度已用完"

// writeDownstreamQuotaRejection reports an exhausted quota.
//
// The error type deliberately differs from a bad credential: a client that reads
// invalid_api_key is expected to stop and have its key replaced, whereas a quota
// refusal is resolved by raising the limit or resetting usage. Both vendors have
// a rate-limit shape for exactly this, so it is reused.
//
// The body carries the refusal twice. A vendor SDK only looks inside `error`, so
// that shape has to stay; a caller written against this proxy reads the top-level
// code instead, without having to know which vendor dialect the route speaks.
func writeDownstreamQuotaRejection(w http.ResponseWriter, anthropic bool, detail string) {
	body := map[string]any{
		"code":    QuotaExhaustedCode,
		"message": QuotaExhaustedMessage,
	}
	if anthropic {
		body["type"] = "error"
		body["error"] = map[string]string{"type": "rate_limit_error", "message": detail}
	} else {
		body["error"] = map[string]string{
			"message": detail,
			"type":    "insufficient_quota",
			"code":    "insufficient_quota",
		}
	}
	apperr.WriteJSON(w, http.StatusTooManyRequests, body)
}

// RateLimitedCode identifies a rate-limited request at the top level of the
// refusal, mirroring QuotaExhaustedCode: a caller that does not speak either
// vendor's error shape can branch on it.
const RateLimitedCode = "API_KEY_RATE_LIMITED"

// RateLimitedMessage is the operator-facing summary carried alongside the code.
const RateLimitedMessage = "API key 请求频率超限"

// writeDownstreamRateLimitRejection reports a request refused for exceeding the
// token's configured rate.
//
// Unlike a quota refusal this one heals itself: the caller only has to wait for
// the window to slide. The nested message names the configured rate so a client
// can decide how long that is likely to be. Both vendor dialects use their
// rate-limit shape, which is exactly what SDK retry logic keys on.
func writeDownstreamRateLimitRejection(w http.ResponseWriter, anthropic bool, rateLimit string) {
	detail := fmt.Sprintf("请求频率超过限制（%s），请稍后重试", rateLimit)
	body := map[string]any{
		"code":    RateLimitedCode,
		"message": RateLimitedMessage,
	}
	if anthropic {
		body["type"] = "error"
		body["error"] = map[string]string{"type": "rate_limit_error", "message": detail}
	} else {
		body["error"] = map[string]string{
			"message": detail,
			"type":    "rate_limit_exceeded",
			"code":    "rate_limit_exceeded",
		}
	}
	apperr.WriteJSON(w, http.StatusTooManyRequests, body)
}

func writeDownstreamError(w http.ResponseWriter, anthropic bool, status int,
	message, openAIType, anthropicType string) {
	if anthropic {
		apperr.WriteJSON(w, status, map[string]any{
			"type":  "error",
			"error": map[string]string{"type": anthropicType, "message": message},
		})
		return
	}
	apperr.WriteJSON(w, status, map[string]any{
		"error": map[string]string{
			"message": message,
			"type":    openAIType,
			"code":    openAIType,
		},
	})
}

// isPiUserAgent reports the pi coding agent from its user-agent.
//
// Matched on a prefix rather than a substring, which every other client here
// can afford but this one cannot: "pi" is two letters that sit inside copilot,
// rapidapi, and any number of agents yet to be written. The observed shape is
// "pi (linux 6.1.0; x64)"; the slash and bare forms are accepted so a future
// version suffix does not silently stop being recognized.
func isPiUserAgent(userAgent string) bool {
	return userAgent == "pi" ||
		strings.HasPrefix(userAgent, "pi ") ||
		strings.HasPrefix(userAgent, "pi/") ||
		strings.HasPrefix(userAgent, "pi-coding-agent")
}

// DetectClientType labels the caller from its originator and user-agent headers.
func DetectClientType(r *http.Request, anthropic bool) string {
	originator := strings.ToLower(r.Header.Get("originator"))
	userAgent := strings.ToLower(r.Header.Get("user-agent"))

	switch {
	case strings.Contains(originator, "codex desktop"):
		return "codex-desktop"
	case strings.Contains(originator, "codex-tui"):
		return "codex-tui"
	case strings.Contains(userAgent, "codex desktop"):
		return "codex-desktop"
	case strings.Contains(userAgent, "codex-tui"):
		return "codex-tui"
	case strings.Contains(userAgent, "opencode"):
		return "opencode"
	// Ahead of the Anthropic branch, which keys on the path and the
	// anthropic-version header rather than on who sent the request: pi speaking
	// the Messages API is still pi, and was being filed as claude.
	//
	// A request pi sends while impersonating another client — the claude-cli
	// user-agent its Anthropic OAuth channel requires — is deliberately left to
	// that client's branch. The upstream is being told it is talking to
	// claude-cli, and a log that says otherwise describes a request nobody sent.
	case isPiUserAgent(userAgent):
		return "pi"
	case strings.Contains(originator, "codex") || strings.Contains(userAgent, "codex"):
		return "codex"
	case anthropic || strings.Contains(userAgent, "claude") || r.Header.Get("anthropic-version") != "":
		return "claude"
	default:
		return "unknown"
	}
}

// extractDownstreamToken reads a bearer token, falling back to x-api-key for
// Anthropic-style requests.
func extractDownstreamToken(r *http.Request, anthropic bool) (string, bool) {
	authorization := r.Header.Get("authorization")
	if scheme, credentials, found := strings.Cut(authorization, " "); found &&
		strings.EqualFold(scheme, "bearer") {
		if token := strings.TrimSpace(credentials); token != "" {
			return token, true
		}
	}
	if !anthropic {
		return "", false
	}
	if token := strings.TrimSpace(r.Header.Get("x-api-key")); token != "" {
		return token, true
	}
	return "", false
}

// DownstreamCredential is the authenticated token's routing and quota state.
type DownstreamCredential struct {
	TokenID     int64
	TokenName   string
	GroupID     int64
	UsedTokens  int64
	LimitTokens *int64
	// RateLimit is the stored rate expression ("100/m"), nil when unlimited.
	RateLimit *string
	// AllowedModels is empty when the token may request any model.
	AllowedModels []string
}

// LookupEnabledDownstreamToken resolves a token to its row.
//
// A lapsed expiry filters the row out here rather than being reported
// separately, so an expired token is indistinguishable from a disabled or
// nonexistent one. Anything else would turn the error body into an oracle for
// which tokens once existed.
//
// An exhausted quota is deliberately not filtered here: the caller reports it
// separately, because a credential that is merely out of budget should say so
// rather than look like a wrong key.
//
// The digest is resolved on every request with nothing cached in front of it,
// which is what lets the console rewrite a token's value with no invalidation
// step: the previous value stops authenticating as soon as the write commits.
func LookupEnabledDownstreamToken(ctx context.Context, database *sql.DB,
	token string) (DownstreamCredential, bool, error) {
	if token == "" {
		return DownstreamCredential{}, false, nil
	}

	// A row predating groups, or one whose group was removed out of band, reads
	// as the default group rather than as no group: a token that reaches nothing
	// would look like a routing bug rather than a configuration choice.
	var credential DownstreamCredential
	var storedGroupID, storedLimit sql.NullInt64
	var storedRateLimit sql.NullString
	var storedAllowedModels string
	err := database.QueryRowContext(ctx,
		`SELECT id, name, group_id, COALESCE(used_tokens, 0), limit_tokens, rate_limit,
		COALESCE(allowed_models, '[]')
		FROM api_tokens
        WHERE token_hash = ? AND enabled = 1
          AND (expires_at IS NULL OR expires_at > datetime('now'))`,
		db.TokenDigest(token)).
		Scan(&credential.TokenID, &credential.TokenName, &storedGroupID,
			&credential.UsedTokens, &storedLimit, &storedRateLimit, &storedAllowedModels)
	if errors.Is(err, sql.ErrNoRows) {
		return DownstreamCredential{}, false, nil
	}
	if err != nil {
		return DownstreamCredential{}, false, err
	}

	credential.GroupID = models.DefaultGroupID
	if storedGroupID.Valid && storedGroupID.Int64 > 0 {
		credential.GroupID = storedGroupID.Int64
	}
	if storedLimit.Valid && storedLimit.Int64 > 0 {
		credential.LimitTokens = &storedLimit.Int64
	}
	if storedRateLimit.Valid && storedRateLimit.String != "" {
		credential.RateLimit = &storedRateLimit.String
	}
	// A malformed list, only possible through an out-of-band edit, reads as
	// unrestricted, matching how a malformed rate limit is admitted.
	var allowed []string
	if err := json.Unmarshal([]byte(storedAllowedModels), &allowed); err == nil {
		credential.AllowedModels = allowed
	}
	return credential, true, nil
}
