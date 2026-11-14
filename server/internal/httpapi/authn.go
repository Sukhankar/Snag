package httpapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/snag/server/internal/auth"
	"github.com/snag/server/internal/store"
)

const sessionTTL = 12 * time.Hour

// principal is the authenticated caller of an admin endpoint.
type principal struct {
	ID      string
	Name    string
	Email   string
	Owner   bool
	Service bool // SNAG_ADMIN_TOKEN automation token
	perms   map[string]bool
}

func (p *principal) can(perm string) bool { return p.Owner || p.Service || p.perms[perm] }

// canGrant reports whether every permission in perms is one the caller holds. Users can
// never hand out (or take away) more than they have themselves.
func (p *principal) canGrant(perms []string) bool {
	for _, k := range perms {
		if !p.can(k) {
			return false
		}
	}
	return true
}

func (p *principal) permissionList() []string {
	if p.Owner || p.Service {
		return auth.AllKeys()
	}
	out := []string{}
	for _, k := range auth.AllKeys() {
		if p.perms[k] {
			out = append(out, k)
		}
	}
	return out
}

const principalCtxKey ctxKey = 2

func me(r *http.Request) *principal { return r.Context().Value(principalCtxKey).(*principal) }

func toPrincipal(u store.User) *principal {
	p := &principal{ID: u.ID, Name: u.Name, Email: u.Email, Owner: u.IsOwner, perms: map[string]bool{}}
	for _, k := range u.Permissions {
		p.perms[k] = true
	}
	return p
}

func bearer(r *http.Request) string {
	t, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return t
}

// authenticate resolves the bearer token to a user session (or the optional service token).
func (s *Server) authenticate(next http.Handler) http.Handler {
	service := []byte(s.cfg.AdminToken)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := bearer(r)
		if tok == "" {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "")
			return
		}
		var p *principal
		if len(service) > 0 && subtle.ConstantTimeCompare([]byte(tok), service) == 1 {
			p = &principal{Name: "service", Service: true}
		} else {
			u, err := s.users.SessionUser(r.Context(), auth.TokenDigest(tok))
			if errors.Is(err, store.ErrNotFound) {
				writeErr(w, http.StatusUnauthorized, "unauthorized", "session expired or revoked")
				return
			}
			if err != nil {
				writeStoreErr(w, r, err)
				return
			}
			p = toPrincipal(u)
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalCtxKey, p)))
	})
}

// need allows the request when the caller holds at least one of perms.
func need(perms ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := me(r)
			for _, k := range perms {
				if p.can(k) {
					next.ServeHTTP(w, r)
					return
				}
			}
			writeErr(w, http.StatusForbidden, "forbidden", "requires permission: "+strings.Join(perms, " or "))
		})
	}
}

func forbidden(w http.ResponseWriter, perm string) {
	writeErr(w, http.StatusForbidden, "forbidden", "requires permission: "+perm)
}

// ---- /api/v1/auth ----

type meResponse struct {
	store.User
	Permissions []string `json:"permissions"`
}

func (s *Server) meFor(p *principal, u store.User) meResponse {
	return meResponse{User: u, Permissions: p.permissionList()}
}

// POST /api/v1/auth/login  {email, password} → {token, expires_at, user}
func (s *Server) login(perAccount *Limiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { s.doLogin(w, r, perAccount) }
}

func (s *Server) doLogin(w http.ResponseWriter, r *http.Request, perAccount *Limiter) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, 8<<10, &req) {
		return
	}
	if !perAccount.Allow(strings.ToLower(strings.TrimSpace(req.Email))) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many sign-in attempts. Try again in a minute.")
		return
	}
	u, hash, err := s.users.UserForLogin(r.Context(), req.Email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeStoreErr(w, r, err)
		return
	}
	if err != nil {
		hash = auth.DummyHash // equalise timing for unknown emails
	}
	if !auth.VerifyPassword(req.Password, hash) || err != nil || !u.IsActive {
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "Incorrect email or password.")
		return
	}
	token, digest, err := auth.NewSessionToken()
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	exp, err := s.users.CreateSession(r.Context(), u.ID, digest, sessionTTL, clientIP(r, s.cfg.TrustProxy), r.UserAgent())
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "expires_at": exp, "user": s.meFor(toPrincipal(u), u)})
}

// POST /api/v1/auth/logout (Bearer) — revokes the current session.
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if tok := bearer(r); tok != "" {
		_ = s.users.DeleteSession(r.Context(), auth.TokenDigest(tok))
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/v1/admin/me
func (s *Server) getMe(w http.ResponseWriter, r *http.Request) {
	p := me(r)
	if p.Service {
		writeJSON(w, http.StatusOK, meResponse{User: store.User{Name: "service", IsOwner: true, IsActive: true}, Permissions: auth.AllKeys()})
		return
	}
	u, err := s.users.GetUser(r.Context(), p.ID)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.meFor(p, u))
}

// POST /api/v1/admin/me/password {current_password, new_password} — signs out other devices.
func (s *Server) changeMyPassword(w http.ResponseWriter, r *http.Request) {
	p := me(r)
	if p.Service {
		forbidden(w, "a user session")
		return
	}
	var req struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if !decodeJSON(w, r, 8<<10, &req) {
		return
	}
	hash, err := s.users.PasswordHash(r.Context(), p.ID)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if !auth.VerifyPassword(req.Current, hash) {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "Current password is incorrect.")
		return
	}
	if err := auth.ValidatePassword(req.New); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	newHash, err := auth.HashPassword(req.New)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if _, err := s.users.UpdateUser(r.Context(), p.ID, store.UserPatch{PasswordHash: &newHash}, auth.TokenDigest(bearer(r))); err != nil {
		writeStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/v1/admin/permissions — the catalog the dashboard renders its role grid from.
func (s *Server) listPermissions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"items": auth.Catalog})
}

// EnsureOwner creates the ultimate user from env on first start.
func (s *Server) EnsureOwner(ctx context.Context) (created bool, err error) {
	exists, err := s.users.OwnerExists(ctx)
	if err != nil || exists {
		return false, err
	}
	if s.cfg.OwnerEmail == "" || s.cfg.OwnerPassword == "" {
		return false, nil
	}
	if !emailRe.MatchString(s.cfg.OwnerEmail) {
		return false, errors.New("SNAG_OWNER_EMAIL is not a valid email")
	}
	if err := auth.ValidatePassword(s.cfg.OwnerPassword); err != nil {
		return false, errors.New("SNAG_OWNER_PASSWORD: " + err.Error())
	}
	hash, err := auth.HashPassword(s.cfg.OwnerPassword)
	if err != nil {
		return false, err
	}
	name := s.cfg.OwnerName
	if name == "" {
		name = "Owner"
	}
	_, err = s.users.CreateOwner(ctx, s.cfg.OwnerEmail, name, hash)
	return err == nil, err
}
