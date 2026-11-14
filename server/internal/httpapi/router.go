// Package httpapi wires HTTP routes, middleware and handlers.
package httpapi

import (
	"context"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/snag/server/internal/broker"
	"github.com/snag/server/internal/config"
	"github.com/snag/server/internal/store"
)

type Server struct {
	cfg      config.Config
	pool     *pgxpool.Pool
	widget   *store.WidgetRepo
	admin    *store.AdminRepo
	projects *store.ProjectRepo
	users    *store.UserRepo
	cache    *ProjectCache
	broker   *broker.Broker
}

func New(cfg config.Config, pool *pgxpool.Pool, b *broker.Broker) *Server {
	projects := store.NewProjectRepo(pool)
	return &Server{
		cfg:      cfg,
		pool:     pool,
		widget:   store.NewWidgetRepo(pool),
		admin:    store.NewAdminRepo(pool),
		projects: projects,
		users:    store.NewUserRepo(pool),
		cache:    NewProjectCache(projects),
		broker:   b,
	}
}

func (s *Server) Routes(ctx context.Context) http.Handler {
	r := chi.NewRouter()
	r.Use(recoverer, accessLog, securityHeaders)

	r.Get("/healthz", s.healthz)
	if s.cfg.WidgetFile != "" {
		r.Get("/widget.min.js", s.serveWidget)
	}

	ipKey := func(r *http.Request) string { return clientIP(r, s.cfg.TrustProxy) }
	projectIPKey := func(r *http.Request) string { return projectFrom(r).ID + "|" + ipKey(r) }
	createLimit := NewLimiter(ctx, s.cfg.CreatePerMinute, max(5, s.cfg.CreatePerMinute/2)) // ticket submissions per project+IP
	widgetLimit := NewLimiter(ctx, 240, 60)                                                // everything else per project+IP

	r.Route("/api/v1/widget", func(r chi.Router) {
		r.Use(OriginGuard(s.cache))
		r.With(createLimit.Middleware(projectIPKey)).Post("/tickets", s.widgetCreateTicket)
		r.Group(func(r chi.Router) {
			r.Use(widgetLimit.Middleware(projectIPKey))
			r.Get("/tickets", s.widgetListTickets)
			r.Get("/tickets/{code}", s.widgetGetTicket)
			r.Post("/tickets/{code}/messages", s.widgetPostMessage)
			r.Get("/stream", s.widgetStream)
		})
	})

	// Logins arrive via the dashboard server, so the IP limit is generous; the real
	// brute-force guard is per account (see login).
	loginIPLimit := NewLimiter(ctx, 120, 30)
	loginAccountLimit := NewLimiter(ctx, 10, 5)
	r.Route("/api/v1/auth", func(r chi.Router) {
		r.With(loginIPLimit.Middleware(ipKey)).Post("/login", s.login(loginAccountLimit))
		r.Post("/logout", s.logout)
	})

	// Every admin route needs a session; each one also declares the permission it requires.
	// Handlers add finer checks where one endpoint covers several permissions (ticket PATCH,
	// public reply vs internal note).
	r.Route("/api/v1/admin", func(r chi.Router) {
		r.Use(s.authenticate)
		r.Get("/me", s.getMe)
		r.Post("/me/password", s.changeMyPassword)
		r.Get("/permissions", s.listPermissions)

		view := need("tickets.view")
		r.With(view).Get("/tickets", s.adminListTickets)
		r.With(view).Get("/tickets/{id}", s.adminGetTicket)
		r.With(view).Patch("/tickets/{id}", s.adminPatchTicket)
		r.With(view).Post("/tickets/{id}/messages", s.adminPostMessage)
		r.With(need("tickets.broadcast")).Post("/tickets/{id}/broadcast", s.adminBroadcast)
		r.With(view).Get("/attachments/{id}", s.adminGetAttachment)
		r.With(view).Get("/stream", s.adminStream)
		r.With(view).Get("/teams", s.adminListTeams)
		r.With(view).Get("/users/directory", s.adminUserDirectory)

		r.With(need("projects.view")).Get("/projects", s.adminListProjects)
		r.With(need("projects.manage")).Post("/projects", s.adminCreateProject)
		r.With(need("projects.manage")).Patch("/projects/{id}", s.adminPatchProject)
		r.With(need("teams.manage")).Post("/teams", s.adminCreateTeam)
		r.With(need("teams.manage")).Patch("/teams/{id}", s.adminPatchTeam)
		r.With(need("teams.manage")).Delete("/teams/{id}", s.adminDeleteTeam)
		r.With(view).Get("/reports/amc", s.adminAMCReport)

		r.With(need("users.manage")).Get("/users", s.adminListUsers)
		r.With(need("users.manage")).Post("/users", s.adminCreateUser)
		r.With(need("users.manage")).Patch("/users/{id}", s.adminPatchUser)
		r.With(need("users.manage", "roles.manage")).Get("/roles", s.adminListRoles)
		r.With(need("roles.manage")).Post("/roles", s.adminCreateRole)
		r.With(need("roles.manage")).Patch("/roles/{id}", s.adminPatchRole)
		r.With(need("roles.manage")).Delete("/roles/{id}", s.adminDeleteRole)
	})
	return r
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if err := s.pool.Ping(r.Context()); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "db_unavailable", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) serveWidget(w http.ResponseWriter, r *http.Request) {
	f, err := os.Open(s.cfg.WidgetFile)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	http.ServeContent(w, r, "widget.min.js", st.ModTime(), f)
}

// EnsureDemoProject creates the optional demo tenant from env configuration.
func (s *Server) EnsureDemoProject(ctx context.Context) (*store.Project, error) {
	if s.cfg.DemoProjectKey == "" {
		return nil, nil
	}
	origins, ok := ValidateOrigins(s.cfg.DemoProjectOrigins)
	if !ok || len(origins) == 0 {
		origins = []string{"http://localhost:5173"}
	}
	p, err := s.projects.EnsureByKey(ctx, "Demo Project", s.cfg.DemoProjectKey, origins)
	if err != nil {
		return nil, err
	}
	return &p, nil
}
