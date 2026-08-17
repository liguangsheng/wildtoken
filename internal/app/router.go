package app

import (
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/handlers"
	"github.com/liguangsheng/wildtoken/internal/middleware"
)

// noStoreCacheControl keeps the console and its assets from being cached, so an
// upgraded build is picked up on the next request rather than after a hard
// reload.
const noStoreCacheControl = "no-store, no-cache, must-revalidate, max-age=0"

// NewRouter builds the complete HTTP surface.
func NewRouter(state *appstate.State) http.Handler {
	router := chi.NewRouter()

	router.Get("/health", handlers.HealthCheck(state))
	router.Get("/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin", http.StatusSeeOther)
	})
	router.Get("/admin", serveAdminHTML)
	router.Get("/api/themes", handlers.ListPublicThemePacks(state))

	router.Mount("/static", noStore(http.StripPrefix("/static",
		noDirectoryListing(http.FileServer(http.Dir("static"))))))
	router.Mount("/theme-packs", noStore(http.StripPrefix("/theme-packs",
		serveThemePackCSS(state.Settings.Themes.Dir))))

	router.Group(func(admin chi.Router) {
		admin.Use(middleware.RequireAdmin(state.Credentials, state.Settings.Admin.ClientIPHeader))
		mountAdminRoutes(admin, state)
	})

	// Only the downstream compatibility API is intentionally cross-origin. The
	// browser admin console is same-origin, so exposing its credentialed
	// endpoints through permissive CORS would needlessly widen the attack
	// surface.
	router.Group(func(proxyRoutes chi.Router) {
		proxyRoutes.Use(allowAnyOrigin)
		proxyRoutes.Use(middleware.RequireDownstream(state.DB, state.TokenRateLimiter, state.Quotas))
		proxyRoutes.Get("/v1/models", handlers.ListModelsHandler(state))
		proxyRoutes.Handle("/v1/*", handlers.ProxyHandler(state))
	})

	return router
}

func mountAdminRoutes(router chi.Router, state *appstate.State) {
	router.Route("/api/admin", func(admin chi.Router) {
		admin.Route("/settings", func(settings chi.Router) {
			settings.Get("/", handlers.AdminGetRuntimeSettings(state))
			settings.Put("/", handlers.AdminUpdateRuntimeSettings(state))
			settings.Post("/admin-token/rotate", handlers.AdminRotateAdminToken(state))

			settings.Get("/model-test-prompts", handlers.AdminListModelTestPromptTemplates(state))
			settings.Post("/model-test-prompts", handlers.AdminCreateModelTestPromptTemplate(state))
			settings.Patch("/model-test-prompts/{id}", handlers.AdminUpdateModelTestPromptTemplate(state))
			settings.Delete("/model-test-prompts/{id}", handlers.AdminDeleteModelTestPromptTemplate(state))
		})

		admin.Get("/system", handlers.AdminSystemInfo(state))
		admin.Get("/system/metrics", handlers.AdminRuntimeMetrics(state))

		admin.Route("/upstreams", func(upstreams chi.Router) {
			upstreams.Post("/fetch-models", handlers.AdminFetchModelsPreview(state))
			upstreams.Post("/export", handlers.AdminExportUpstreams(state))
			upstreams.Post("/import", handlers.AdminImportUpstreams(state))
			upstreams.Get("/", handlers.AdminListUpstreams(state))
			upstreams.Post("/", handlers.AdminCreateUpstream(state))
			upstreams.Get("/{id}", handlers.AdminGetUpstream(state))
			upstreams.Put("/{id}", handlers.AdminUpdateUpstream(state))
			upstreams.Delete("/{id}", handlers.AdminDeleteUpstream(state))
			upstreams.Patch("/{id}/enabled", handlers.AdminSetUpstreamEnabled(state))
			upstreams.Patch("/{id}/priority", handlers.AdminSetUpstreamPriority(state))
			upstreams.Post("/{id}/test", handlers.AdminTestUpstream(state))
			upstreams.Post("/{id}/test-model", handlers.AdminTestUpstreamModel(state))
			upstreams.Post("/{id}/models", handlers.AdminFetchUpstreamModels(state))
			upstreams.Post("/{id}/balance", handlers.AdminFetchUpstreamBalance(state))
			upstreams.Post("/{id}/balance/sub2api", handlers.AdminFetchUpstreamSub2APIBalance(state))
			upstreams.Get("/stats", handlers.AdminGetUpstreamsStats(state))
			upstreams.Get("/health", handlers.AdminUpstreamHealthHistory(state))
		})

		admin.Route("/groups", func(groups chi.Router) {
			groups.Get("/", handlers.AdminListGroups(state))
			groups.Post("/", handlers.AdminCreateGroup(state))
			groups.Get("/{id}", handlers.AdminGetGroup(state))
			groups.Put("/{id}", handlers.AdminUpdateGroup(state))
			groups.Delete("/{id}", handlers.AdminDeleteGroup(state))
		})

		admin.Route("/tokens", func(tokens chi.Router) {
			tokens.Get("/", handlers.AdminListTokens(state))
			tokens.Post("/", handlers.AdminCreateToken(state))
			tokens.Get("/{id}", handlers.AdminGetToken(state))
			tokens.Put("/{id}", handlers.AdminUpdateToken(state))
			tokens.Delete("/{id}", handlers.AdminDeleteToken(state))
			tokens.Patch("/{id}/enabled", handlers.AdminSetTokenEnabled(state))
			tokens.Post("/{id}/usage/reset", handlers.AdminResetTokenUsage(state))
		})

		admin.Route("/logs", func(logs chi.Router) {
			logs.Get("/", handlers.AdminListLogs(state))
			logs.Get("/stream", handlers.AdminStreamLogs(state))
			logs.Get("/token-usage", handlers.AdminTokenUsageStats(state))
			logs.Get("/top", handlers.AdminTopLogStats(state))
			logs.Get("/overview", handlers.AdminLogOverview(state))
			logs.Get("/{id}", handlers.AdminGetLogDetail(state))
		})
	})
}

// serveThemePackCSS serves the stylesheets under the configured theme directory.
//
// A plain FileServer over that directory answered any path ending in a slash
// with a listing of it, and this route is deliberately outside the admin
// credential. The directory is whatever the operator configured — the
// WILDTOKEN_THEME_DIR override accepts any path at all — so the listing named
// every file under it to anyone who asked.
//
// What remains reachable is any .css file anywhere below that directory,
// including through a symlink pointing out of it. That is wider than the
// manifests describe; it is bounded to a file type the console actually loads,
// which is what closes the enumeration. Pointing the theme directory at
// something that is not a theme directory is still the operator's to get right.
func serveThemePackCSS(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, ".css") {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

// noDirectoryListing refuses the trailing-slash paths a FileServer answers with
// a listing of the directory.
//
// The console needs the files under /static by name; nothing needs an index of
// them, and this route is outside the admin credential like the theme one.
func noDirectoryListing(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("cache-control", noStoreCacheControl)
		next.ServeHTTP(w, r)
	})
}

func allowAnyOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("access-control-allow-origin", "*")
		header.Set("access-control-allow-methods", "*")
		header.Set("access-control-allow-headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// serveAdminHTML serves the admin console from static/.
func serveAdminHTML(w http.ResponseWriter, r *http.Request) {
	html, err := os.ReadFile(filepath.Join("static", "admin.html"))
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("Admin page not found"))
		return
	}
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", noStoreCacheControl)
	w.Write(html)
}

// AdminURLFromSettings builds the browser-facing admin URL.
//
// When the server binds on all interfaces (0.0.0.0 or ::), loopback is opened
// instead, because a wildcard address is not something a browser can visit.
func AdminURLFromSettings(host string, port uint16) string {
	switch host {
	case "0.0.0.0", "::", "[::]":
		host = "127.0.0.1"
	}
	return "http://" + host + ":" + strconv.Itoa(int(port)) + "/admin"
}

// IsLoopbackBindHost reports whether a configured bind host only accepts local
// connections.
func IsLoopbackBindHost(host string) bool {
	trimmed := strings.TrimSpace(host)
	if inner, found := strings.CutPrefix(trimmed, "["); found {
		if closed, hasSuffix := strings.CutSuffix(inner, "]"); hasSuffix {
			trimmed = closed
		}
	}
	if strings.EqualFold(trimmed, "localhost") {
		return true
	}
	address, err := netip.ParseAddr(trimmed)
	if err != nil {
		return false
	}
	return address.IsLoopback()
}
