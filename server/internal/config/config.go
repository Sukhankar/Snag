// Package config loads runtime configuration from the environment.
package config

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Addr        string
	DatabaseURL string
	// AdminToken is an optional full-access service token for scripts/automation
	// (Authorization: Bearer ...). People sign in as users instead. Leave unset if unused.
	AdminToken string
	// Owner ("ultimate user") bootstrap: created on start-up if no owner exists yet.
	OwnerEmail    string
	OwnerPassword string
	OwnerName     string
	// TrustProxy makes the rate limiter key on X-Forwarded-For / X-Real-IP. Only enable
	// behind a reverse proxy that overwrites those headers.
	TrustProxy bool
	// WidgetFile, if set, is served at GET /widget.min.js.
	WidgetFile string
	// MaxTicketBytes caps the JSON body of a ticket submission (attachments included).
	MaxTicketBytes int64
	// CreatePerMinute limits ticket submissions per project+IP (burst = half, min 5).
	CreatePerMinute int

	// Optional demo tenant, created on start-up when DemoProjectKey is set.
	DemoProjectKey     string
	DemoProjectOrigins []string
}

func Load() (Config, error) {
	c := Config{
		Addr:               env("SNAG_ADDR", ":8080"),
		DatabaseURL:        os.Getenv("DATABASE_URL"),
		AdminToken:         os.Getenv("SNAG_ADMIN_TOKEN"),
		OwnerEmail:         strings.TrimSpace(os.Getenv("SNAG_OWNER_EMAIL")),
		OwnerPassword:      os.Getenv("SNAG_OWNER_PASSWORD"),
		OwnerName:          strings.TrimSpace(os.Getenv("SNAG_OWNER_NAME")),
		TrustProxy:         env("SNAG_TRUST_PROXY", "false") == "true",
		WidgetFile:         os.Getenv("SNAG_WIDGET_FILE"),
		MaxTicketBytes:     20 << 20,
		CreatePerMinute:    10,
		DemoProjectKey:     os.Getenv("SNAG_DEMO_PROJECT_KEY"),
		DemoProjectOrigins: splitList(os.Getenv("SNAG_DEMO_ORIGINS")),
	}
	if v := os.Getenv("SNAG_MAX_TICKET_MB"); v != "" {
		mb, err := strconv.Atoi(v)
		if err != nil || mb < 1 || mb > 200 {
			return c, errors.New("SNAG_MAX_TICKET_MB must be an integer between 1 and 200")
		}
		c.MaxTicketBytes = int64(mb) << 20
	}
	if v := os.Getenv("SNAG_CREATE_PER_MINUTE"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return c, errors.New("SNAG_CREATE_PER_MINUTE must be a positive integer")
		}
		c.CreatePerMinute = n
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	if c.AdminToken != "" && len(c.AdminToken) < 24 {
		return c, errors.New("SNAG_ADMIN_TOKEN must be at least 24 characters (or unset)")
	}
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
