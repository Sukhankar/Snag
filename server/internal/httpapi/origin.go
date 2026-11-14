package httpapi

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/snag/server/internal/store"
)

// ---- origin normalisation & matching ----

// normalizeOrigin returns "scheme://host[:port]" in lower case with default ports removed.
func normalizeOrigin(s string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if strings.Contains(host, ":") { // IPv6 literal
		host = "[" + host + "]"
	}
	out := u.Scheme + "://" + host
	if port != "" {
		out += ":" + port
	}
	return out, true
}

// originRule is either an exact origin or a subdomain wildcard such as
// "https://*.example.com" (which matches a.example.com and a.b.example.com, but not the
// apex example.com — list the apex separately if it is needed).
type originRule struct {
	exact      string
	wildScheme string
	wildSuffix string // ".example.com" or ".example.com:8443"
}

func parseOriginRule(s string) (originRule, bool) {
	s = strings.ToLower(strings.TrimRight(strings.TrimSpace(s), "/"))
	if scheme, rest, ok := strings.Cut(s, "://*."); ok {
		if scheme != "http" && scheme != "https" {
			return originRule{}, false
		}
		norm, ok := normalizeOrigin(scheme + "://wildcard." + rest)
		if !ok {
			return originRule{}, false
		}
		suffix := strings.TrimPrefix(norm, scheme+"://wildcard")
		if !strings.Contains(strings.TrimPrefix(suffix, "."), ".") && !strings.HasPrefix(suffix, ".localhost") {
			return originRule{}, false // refuse "*.com"-style rules
		}
		return originRule{wildScheme: scheme, wildSuffix: suffix}, true
	}
	norm, ok := normalizeOrigin(s)
	if !ok {
		return originRule{}, false
	}
	return originRule{exact: norm}, true
}

func (r originRule) matches(origin string) bool {
	if r.exact != "" {
		return r.exact == origin
	}
	prefix := r.wildScheme + "://"
	if !strings.HasPrefix(origin, prefix) || !strings.HasSuffix(origin, r.wildSuffix) {
		return false
	}
	label := strings.TrimSuffix(strings.TrimPrefix(origin, prefix), r.wildSuffix)
	return label != "" && !strings.ContainsAny(label, ":/[]")
}

// ValidateOrigins is used by the admin API when projects are created/updated.
func ValidateOrigins(in []string) ([]string, bool) {
	out := make([]string, 0, len(in))
	for _, o := range in {
		rule, ok := parseOriginRule(o)
		if !ok {
			return nil, false
		}
		if rule.exact != "" {
			out = append(out, rule.exact)
		} else {
			out = append(out, rule.wildScheme+"://*"+rule.wildSuffix)
		}
	}
	return out, true
}

// requestOrigin derives the caller's origin from Origin, falling back to Referer.
func requestOrigin(r *http.Request) (string, bool) {
	if o := r.Header.Get("Origin"); o != "" && o != "null" {
		return normalizeOrigin(o)
	}
	if ref := r.Header.Get("Referer"); ref != "" {
		return normalizeOrigin(ref)
	}
	return "", false
}

// ---- project cache ----

type cachedProject struct {
	store.Project
	rules []originRule
}

func (p *cachedProject) allows(origin string) bool {
	for _, r := range p.rules {
		if r.matches(origin) {
			return true
		}
	}
	return false
}

// ProjectCache keeps active projects in memory so the origin check costs no DB round-trip.
// It reloads every 30s, on Invalidate (admin mutations), and on a key miss (at most every
// 3s, so random keys cannot be used to hammer the database).
type ProjectCache struct {
	repo *store.ProjectRepo

	mu       sync.RWMutex
	byKey    map[string]*cachedProject
	loadedAt time.Time

	reloadMu sync.Mutex
}

func NewProjectCache(repo *store.ProjectRepo) *ProjectCache {
	return &ProjectCache{repo: repo, byKey: map[string]*cachedProject{}}
}

const (
	cacheTTL         = 30 * time.Second
	cacheMissBackoff = 3 * time.Second
)

func (c *ProjectCache) Invalidate() {
	c.mu.Lock()
	c.loadedAt = time.Time{}
	c.mu.Unlock()
}

func (c *ProjectCache) age() time.Duration {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return time.Since(c.loadedAt)
}

func (c *ProjectCache) reload(ctx context.Context, minAge time.Duration) {
	c.reloadMu.Lock()
	defer c.reloadMu.Unlock()
	if c.age() < minAge { // someone else just reloaded
		return
	}
	projects, err := c.repo.ListActive(ctx)
	if err != nil {
		slog.Error("project cache reload failed", "err", err)
		return
	}
	next := make(map[string]*cachedProject, len(projects))
	for _, p := range projects {
		cp := &cachedProject{Project: p}
		for _, o := range p.AllowedOrigins {
			if rule, ok := parseOriginRule(o); ok {
				cp.rules = append(cp.rules, rule)
			}
		}
		next[p.ProjectKey] = cp
	}
	c.mu.Lock()
	c.byKey = next
	c.loadedAt = time.Now()
	c.mu.Unlock()
}

func (c *ProjectCache) Get(ctx context.Context, key string) (*cachedProject, bool) {
	if c.age() > cacheTTL {
		c.reload(ctx, cacheTTL)
	}
	c.mu.RLock()
	p, ok := c.byKey[key]
	c.mu.RUnlock()
	if ok {
		return p, true
	}
	if c.age() > cacheMissBackoff {
		c.reload(ctx, cacheMissBackoff)
		c.mu.RLock()
		p, ok = c.byKey[key]
		c.mu.RUnlock()
	}
	return p, ok
}

// OriginKnown reports whether any active project whitelists origin (used for preflights,
// which never carry the X-Project-Key value).
func (c *ProjectCache) OriginKnown(ctx context.Context, origin string) bool {
	if c.age() > cacheTTL {
		c.reload(ctx, cacheTTL)
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, p := range c.byKey {
		if p.allows(origin) {
			return true
		}
	}
	return false
}

// ---- middleware ----

type ctxKey int

const projectCtxKey ctxKey = 1

func projectFrom(r *http.Request) *cachedProject {
	return r.Context().Value(projectCtxKey).(*cachedProject)
}

const (
	widgetAllowMethods = "GET, POST, OPTIONS"
	widgetAllowHeaders = "Content-Type, X-Project-Key, X-Reporter-Token"
)

// OriginGuard authenticates widget traffic: X-Project-Key must name an active project and
// the request's Origin (or Referer) must be whitelisted for it; otherwise 403.
//
// Note this is a browser-side control: it stops other websites from using a leaked key,
// not a non-browser client that forges headers. Rate limiting covers the latter.
func OriginGuard(cache *ProjectCache) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin, ok := requestOrigin(r)
			if !ok {
				writeErr(w, http.StatusForbidden, "origin_required", "request has no valid Origin or Referer")
				return
			}

			if r.Method == http.MethodOptions {
				if !cache.OriginKnown(r.Context(), origin) {
					writeErr(w, http.StatusForbidden, "origin_not_allowed", "")
					return
				}
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Methods", widgetAllowMethods)
				h.Set("Access-Control-Allow-Headers", widgetAllowHeaders)
				h.Set("Access-Control-Max-Age", "600")
				h.Add("Vary", "Origin")
				w.WriteHeader(http.StatusNoContent)
				return
			}

			key := r.Header.Get("X-Project-Key")
			// EventSource cannot send custom headers, so the stream endpoint alone accepts
			// the key (and reporter token) as query parameters.
			if key == "" && r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/stream") {
				key = r.URL.Query().Get("key")
			}
			if key == "" {
				writeErr(w, http.StatusUnauthorized, "project_key_required", "")
				return
			}
			p, ok := cache.Get(r.Context(), key)
			if !ok {
				writeErr(w, http.StatusForbidden, "invalid_project_key", "")
				return
			}
			if !p.allows(origin) {
				writeErr(w, http.StatusForbidden, "origin_not_allowed", "")
				return
			}

			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), projectCtxKey, p)))
		})
	}
}

// clientIP returns the address used for rate limiting.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
			return ip
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
