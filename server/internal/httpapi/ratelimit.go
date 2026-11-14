package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter is a keyed token-bucket limiter with idle-entry eviction.
type Limiter struct {
	mu    sync.Mutex
	m     map[string]*limiterEntry
	every rate.Limit
	burst int
}

type limiterEntry struct {
	l    *rate.Limiter
	seen time.Time
}

func NewLimiter(ctx context.Context, perMinute, burst int) *Limiter {
	l := &Limiter{
		m:     map[string]*limiterEntry{},
		every: rate.Limit(float64(perMinute) / 60),
		burst: burst,
	}
	go l.janitor(ctx)
	return l
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	e, ok := l.m[key]
	if !ok {
		e = &limiterEntry{l: rate.NewLimiter(l.every, l.burst)}
		l.m[key] = e
	}
	e.seen = time.Now()
	l.mu.Unlock()
	return e.l.Allow()
}

func (l *Limiter) janitor(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			l.mu.Lock()
			for k, e := range l.m {
				if now.Sub(e.seen) > 10*time.Minute {
					delete(l.m, k)
				}
			}
			l.mu.Unlock()
		}
	}
}

// Middleware limits per key; keyFn returns the bucket key for a request.
func (l *Limiter) Middleware(keyFn func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.Allow(keyFn(r)) {
				w.Header().Set("Retry-After", strconv.Itoa(int(1/float64(l.every))+1))
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
