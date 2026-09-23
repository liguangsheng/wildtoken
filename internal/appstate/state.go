// Package app wires the HTTP server, its shared state, and background tasks.
package appstate

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/imagestore"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
	"github.com/liguangsheng/wildtoken/internal/quota"
	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

// SettingsStore holds the operator-editable runtime policy.
//
// It is read on every proxied request and written only by the admin console, so
// reads take a shared lock and the value is copied out rather than shared.
type SettingsStore struct {
	mu      sync.RWMutex
	current models.RuntimeSettings
}

func NewSettingsStore(initial models.RuntimeSettings) *SettingsStore {
	return &SettingsStore{current: initial}
}

func (s *SettingsStore) Get() models.RuntimeSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current
}

func (s *SettingsStore) Set(settings models.RuntimeSettings) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = settings
}

// ModelsListCache caches the aggregated GET /v1/models response per group.
//
// The response is keyed by group because a token only reaches its own group's
// channels: one shared entry would advertise models a caller cannot route to.
//
// It is invalidated explicitly on upstream and group write operations.
// Concurrent misses may reload the same value, which is intentional and harmless.
type ModelsListCache struct {
	mu      sync.RWMutex
	byGroup map[int64]json.RawMessage
}

func NewModelsListCache() *ModelsListCache {
	return &ModelsListCache{byGroup: map[int64]json.RawMessage{}}
}

func (c *ModelsListCache) Get(groupID int64) json.RawMessage {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.byGroup[groupID]
}

func (c *ModelsListCache) Set(groupID int64, value json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byGroup[groupID] = value
}

// Invalidate drops every group's entry, because one channel edit can change
// what several groups advertise.
func (c *ModelsListCache) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	clear(c.byGroup)
}

// State is the shared application state every handler receives.
type State struct {
	DB          *sql.DB
	HTTPClient  *http.Client
	Settings    config.Settings
	AutoWeight  *proxy.AutoWeightManager
	Runtime     *SettingsStore
	Credentials *authstate.Credentials
	Throttle    *authstate.Throttle
	Metrics     *metrics.Runtime
	LogWriter   *proxy.LogWriter
	LogStats    *db.LogStatsCache
	ModelsCache *ModelsListCache
	Routing     *proxy.RoutingCache
	// ActiveRequests holds what is being proxied right now, which no log row
	// covers: a row only exists once the request is over.
	ActiveRequests *proxy.ActiveRegistry
	// TokenRateLimiter and UpstreamRateLimiter enforce the per-token and
	// per-channel rate expressions. They must stay separate instances: both key
	// their windows by an int64 id, so sharing one would let a token and a
	// channel with the same id count against each other.
	TokenRateLimiter    *ratelimit.Limiter
	UpstreamRateLimiter *ratelimit.Limiter
	// Quotas holds the usage that a token has committed to but that its stored
	// total does not show yet, so admission weighs requests still in flight.
	Quotas *quota.Tracker
	// Images saves generated images out of logged responses. Nil when no
	// directory is configured; every method treats nil as "off".
	Images    *imagestore.Store
	StartedAt time.Time
}

// EffectiveUpstreamTimeoutSeconds is the fallback timeout for channels that
// leave theirs unset: the operator-edited runtime value when one is set,
// otherwise the startup config.
func (s *State) EffectiveUpstreamTimeoutSeconds() float64 {
	if runtime := s.Runtime.Get(); runtime.DefaultUpstreamTimeoutSeconds > 0 {
		return float64(runtime.DefaultUpstreamTimeoutSeconds)
	}
	return s.Settings.Upstream.DefaultTimeoutSeconds
}

// ProxyDeps assembles the dependencies one forwarded request needs.
func (s *State) ProxyDeps() proxy.Deps {
	return proxy.Deps{
		HTTPClient:     s.HTTPClient,
		AutoWeight:     s.AutoWeight,
		Metrics:        s.Metrics,
		LogWriter:      s.LogWriter,
		Images:         s.Images,
		DefaultTimeout: time.Duration(s.EffectiveUpstreamTimeoutSeconds() * float64(time.Second)),
	}
}

// AutoWeightPolicy reads the current health policy.
func (s *State) AutoWeightPolicy() proxy.AutoWeightPolicy {
	settings := s.Runtime.Get()
	return proxy.NewAutoWeightPolicy(&settings)
}

// LoadRuntimeSettings reads the persisted policy, falling back to safe startup
// defaults if it is absent or invalid.
func LoadRuntimeSettings(ctx context.Context, database *sql.DB) models.RuntimeSettings {
	settings, ok, err := db.LoadRuntimeSettings(ctx, database)
	switch {
	case err != nil:
		slog.Warn("could not load runtime_settings; using startup defaults", "error", err)
		return models.DefaultRuntimeSettings()
	case !ok:
		slog.Warn("runtime_settings row is missing; using startup defaults")
		return models.DefaultRuntimeSettings()
	}
	if err := settings.Validate(); err != nil {
		slog.Warn("runtime_settings contains invalid values; using startup defaults", "error", err)
		return models.DefaultRuntimeSettings()
	}
	settings.DatabaseOverride = true
	return settings
}
