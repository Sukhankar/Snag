package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/snag/server/internal/broker"
	"github.com/snag/server/internal/store"
)

// actor is the display name recorded on messages and audit notes.
func actor(r *http.Request) string { return me(r).Name }

func uuidParam(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	id := chi.URLParam(r, name)
	if !isUUID(id) {
		writeErr(w, http.StatusNotFound, "not_found", "")
		return "", false
	}
	return id, true
}

// GET /api/v1/admin/tickets?cursor=&limit=&project_id=&team_id=&assignee_id=(uuid|me|none)&status=a,b&category=&priority=&scope_class=&q=&top_level=1
func (s *Server) adminListTickets(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.ListFilter{
		ProjectID:    q.Get("project_id"),
		TeamID:       q.Get("team_id"),
		Category:     q.Get("category"),
		Priority:     q.Get("priority"),
		ScopeClass:   q.Get("scope_class"),
		Query:        q.Get("q"),
		TopLevelOnly: q.Get("top_level") == "1",
		AssigneeID:   q.Get("assignee_id"),
	}
	switch f.AssigneeID {
	case "", "none":
	case "me":
		if me(r).ID == "" {
			writeErr(w, http.StatusBadRequest, "invalid_filter", "assignee_id=me needs a user session")
			return
		}
		f.AssigneeID = me(r).ID
	default:
		if !isUUID(f.AssigneeID) {
			writeErr(w, http.StatusBadRequest, "invalid_filter", "assignee_id must be a user id, me or none")
			return
		}
	}
	if c := q.Get("cursor"); c != "" {
		cur, err := store.DecodeCursor(c)
		if err != nil || !isUUID(cur.ID) {
			writeErr(w, http.StatusBadRequest, "invalid_cursor", "")
			return
		}
		f.Cursor = cur
	}
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > 200 {
			writeErr(w, http.StatusBadRequest, "invalid_limit", "limit must be 1-200")
			return
		}
		f.Limit = n
	}
	if st := q.Get("status"); st != "" {
		for _, v := range strings.Split(st, ",") {
			if !store.OneOf(v, store.Statuses) {
				writeErr(w, http.StatusBadRequest, "invalid_status", v)
				return
			}
			f.Statuses = append(f.Statuses, v)
		}
	}
	if (f.ProjectID != "" && !isUUID(f.ProjectID)) || (f.TeamID != "" && !isUUID(f.TeamID)) ||
		(f.Category != "" && !store.OneOf(f.Category, store.Categories)) ||
		(f.Priority != "" && !store.OneOf(f.Priority, store.Priorities)) ||
		(f.ScopeClass != "" && !store.OneOf(f.ScopeClass, store.ScopeClasses)) {
		writeErr(w, http.StatusBadRequest, "invalid_filter", "")
		return
	}
	page, err := s.admin.ListTickets(r.Context(), f)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) adminGetTicket(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	d, err := s.admin.GetTicket(r.Context(), id)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if !me(r).can("tickets.note") { // internal notes are part of the tickets.note permission
		public := d.Messages[:0]
		for _, m := range d.Messages {
			if !m.IsInternal {
				public = append(public, m)
			}
		}
		d.Messages = public
	}
	writeJSON(w, http.StatusOK, d)
}

// PATCH /api/v1/admin/tickets/{id}
// Body: any of status, priority, category, scope_class, team_id, assignee_id, parent_ticket_id.
// Nullable references accept JSON null to clear them.
func (s *Server) adminPatchTicket(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var raw map[string]json.RawMessage
	if !decodeJSON(w, r, 64<<10, &raw) {
		return
	}
	p := store.TicketPatch{ActorID: actor(r)}

	enum := func(field string, set []string) (*string, bool) {
		v, present := raw[field]
		if !present {
			return nil, true
		}
		var s string
		if json.Unmarshal(v, &s) != nil || !store.OneOf(s, set) {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid "+field)
			return nil, false
		}
		return &s, true
	}
	ref := func(field string) (bool, *string, bool) {
		v, present := raw[field]
		if !present {
			return false, nil, true
		}
		if string(v) == "null" {
			return true, nil, true
		}
		var s string
		if json.Unmarshal(v, &s) != nil || !isUUID(s) {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", field+" must be a UUID or null")
			return false, nil, false
		}
		return true, &s, true
	}

	if p.Status, ok = enum("status", store.Statuses); !ok {
		return
	}
	if p.Priority, ok = enum("priority", store.Priorities); !ok {
		return
	}
	if p.Category, ok = enum("category", store.Categories); !ok {
		return
	}
	if p.ScopeClass, ok = enum("scope_class", store.ScopeClasses); !ok {
		return
	}
	if p.TeamSet, p.TeamID, ok = ref("team_id"); !ok {
		return
	}
	if p.AssigneeSet, p.AssigneeID, ok = ref("assignee_id"); !ok {
		return
	}
	if p.ParentSet, p.ParentID, ok = ref("parent_ticket_id"); !ok {
		return
	}
	// Field-level permissions: one PATCH endpoint, several capabilities.
	caller := me(r)
	for perm, touched := range map[string]bool{
		"tickets.update":   p.Status != nil || p.Priority != nil || p.Category != nil || p.TeamSet,
		"tickets.assign":   p.AssigneeSet,
		"tickets.classify": p.ScopeClass != nil,
		"tickets.link":     p.ParentSet,
	} {
		if touched && !caller.can(perm) {
			forbidden(w, perm)
			return
		}
	}
	if p.ParentID != nil && *p.ParentID == id {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "a ticket cannot be its own parent")
		return
	}

	var prevParent *string
	if p.ParentSet {
		if before, err := s.admin.GetSummary(r.Context(), id); err == nil {
			prevParent = before.ParentTicketID
		}
	}

	res, err := s.admin.UpdateTicket(r.Context(), id, p)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res.Ticket)

	s.broker.Publish(broker.AdminTopic, "ticket.updated", res.Ticket)
	aud := store.Audience{TicketID: id, Code: res.Ticket.Code, ProjectID: res.Ticket.ProjectID}
	for _, m := range res.Internal {
		s.publishAdminMessage(r, aud, m)
	}
	if p.Status != nil {
		if full, err := s.admin.Audience(r.Context(), id); err == nil {
			s.publishClientStatus(full, res.Ticket.Status)
		}
	}
	// duplicate_count changed on the old/new parent rows.
	if p.ParentSet {
		if prevParent != nil {
			s.publishAdminTicket(r, *prevParent)
		}
		if res.Ticket.ParentTicketID != nil && (prevParent == nil || *prevParent != *res.Ticket.ParentTicketID) {
			s.publishAdminTicket(r, *res.Ticket.ParentTicketID)
		}
	}
	s.publishNotices(r, res.Notices)
}

func (s *Server) publishNotices(r *http.Request, notices []store.Notice) {
	for _, n := range notices {
		s.publishAdminTicket(r, n.Audience.TicketID)
		s.publishAdminMessage(r, n.Audience, n.Message)
		s.publishClientMessage(n.Audience, n.Message)
		s.publishClientStatus(n.Audience, n.Status)
	}
}

type adminMessageReq struct {
	Body       string `json:"body"`
	IsInternal bool   `json:"is_internal"`
}

// POST /api/v1/admin/tickets/{id}/messages
func (s *Server) adminPostMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req adminMessageReq
	if !decodeJSON(w, r, 256<<10, &req) {
		return
	}
	if req.IsInternal && !me(r).can("tickets.note") {
		forbidden(w, "tickets.note")
		return
	}
	if !req.IsInternal && !me(r).can("tickets.reply") {
		forbidden(w, "tickets.reply")
		return
	}
	body := clean(req.Body)
	if body == "" || runeLen(body) > maxMessageRunes {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "body is required (max 20000 characters)")
		return
	}
	m, err := s.admin.AddDeveloperMessage(r.Context(), id, actor(r), body, req.IsInternal)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)

	aud, err := s.admin.Audience(r.Context(), id)
	if err != nil {
		return
	}
	s.publishAdminMessage(r, aud, m)
	s.publishAdminTicket(r, id)
	if !m.IsInternal {
		s.publishClientMessage(aud, m)
		if summary, err := s.admin.GetSummary(r.Context(), id); err == nil {
			s.publishClientStatus(aud, summary.Status)
		}
	}
}

// POST /api/v1/admin/tickets/{id}/broadcast — public reply to a root ticket and all of its
// linked duplicates in one transaction.
func (s *Server) adminBroadcast(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	if !decodeJSON(w, r, 256<<10, &req) {
		return
	}
	body := clean(req.Body)
	if body == "" || runeLen(body) > maxMessageRunes {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "body is required (max 20000 characters)")
		return
	}
	notices, err := s.admin.Broadcast(r.Context(), id, actor(r), body)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int{"delivered": len(notices)})
	s.publishNotices(r, notices)
}

func (s *Server) adminGetAttachment(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	a, err := s.admin.GetAttachment(r.Context(), id)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600, immutable")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(a)
}

// ---- projects & teams ----

func (s *Server) adminListProjects(w http.ResponseWriter, r *http.Request) {
	ps, err := s.projects.List(r.Context())
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": ps})
}

type projectReq struct {
	Name           *string  `json:"name"`
	AllowedOrigins []string `json:"allowed_origins"`
	IsActive       *bool    `json:"is_active"`
	RotateKey      bool     `json:"rotate_key"`
	// IdentityRequired: reject anonymous reporters (only while signed identities are enabled).
	IdentityRequired *bool `json:"identity_required"`
}

func (s *Server) adminCreateProject(w http.ResponseWriter, r *http.Request) {
	var req projectReq
	if !decodeJSON(w, r, 64<<10, &req) {
		return
	}
	if req.Name == nil || clean(*req.Name) == "" || runeLen(*req.Name) > 255 {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "name is required")
		return
	}
	origins, ok := ValidateOrigins(req.AllowedOrigins)
	if !ok || len(origins) == 0 {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed",
			"allowed_origins must be a non-empty list like https://app.example.com or https://*.example.com")
		return
	}
	p, err := s.projects.Create(r.Context(), clean(*req.Name), origins, "")
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	s.cache.Invalidate()
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) adminPatchProject(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req projectReq
	if !decodeJSON(w, r, 64<<10, &req) {
		return
	}
	patch := store.ProjectPatch{IsActive: req.IsActive, RotateKey: req.RotateKey, IdentityRequired: req.IdentityRequired}
	if req.Name != nil {
		n := clean(*req.Name)
		if n == "" || runeLen(n) > 255 {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid name")
			return
		}
		patch.Name = &n
	}
	if req.AllowedOrigins != nil {
		origins, ok := ValidateOrigins(req.AllowedOrigins)
		if !ok || len(origins) == 0 {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid allowed_origins")
			return
		}
		patch.AllowedOrigins = origins
	}
	p, err := s.projects.Update(r.Context(), id, patch)
	if errors.Is(err, store.ErrConflict) && req.IdentityRequired != nil {
		writeErr(w, http.StatusConflict, "identity_not_enabled", "generate an identity secret before requiring signed-in reporters")
		return
	}
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	s.cache.Invalidate()
	writeJSON(w, http.StatusOK, p)
}

// POST /api/v1/admin/projects/{id}/identity-secret — enable or rotate signed reporter
// identities. The new secret is returned once, in this response only; the previous secret
// stops working immediately.
func (s *Server) adminRotateIdentity(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	if s.cfg.IdentityKey == "" {
		writeErr(w, http.StatusConflict, "identity_key_missing",
			"set SNAG_IDENTITY_KEY (at least 32 random characters) on the Snag server to enable signed reporters")
		return
	}
	p, err := s.projects.RotateIdentity(r.Context(), id)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	s.cache.Invalidate()
	slog.Info("project identity secret rotated", "project_id", p.ID, "version", p.IdentityVersion, "by", me(r).ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"project": p,
		"secret":  deriveIdentitySecret(s.cfg.IdentityKey, p.ID, p.IdentityVersion),
	})
}

// DELETE /api/v1/admin/projects/{id}/identity-secret — turn signed identities off. Signed-in
// reporters fall back to anonymous browser tokens; the old secret can never be revived.
func (s *Server) adminDisableIdentity(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	p, err := s.projects.DisableIdentity(r.Context(), id)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	s.cache.Invalidate()
	slog.Info("project identity disabled", "project_id", p.ID, "by", me(r).ID)
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) adminListTeams(w http.ResponseWriter, r *http.Request) {
	ts, err := s.projects.ListTeams(r.Context())
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": ts})
}

func (s *Server) adminCreateTeam(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		MemberIDs   []string `json:"member_ids"`
	}
	if !decodeJSON(w, r, 64<<10, &req) {
		return
	}
	name := clean(req.Name)
	if name == "" || runeLen(name) > 100 {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "name is required (max 100 characters)")
		return
	}
	members, ok := idList(w, req.MemberIDs, "member_ids")
	if !ok {
		return
	}
	t, err := s.projects.CreateTeam(r.Context(), name, optional(req.Description, 2000), members)
	if errors.Is(err, store.ErrConflict) {
		writeErr(w, http.StatusConflict, "team_exists", "a team with this name already exists")
		return
	}
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

// idList validates a list of UUIDs (deduplicated, at most 1000).
func idList(w http.ResponseWriter, ids []string, field string) ([]string, bool) {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.ToLower(strings.TrimSpace(id))
		if !isUUID(id) {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", field+" must contain ids")
			return nil, false
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if len(out) > 1000 {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "too many "+field)
		return nil, false
	}
	return out, true
}

// PUT /api/v1/admin/teams/{id}/members {user_ids} — replaces the team's members.
func (s *Server) adminSetTeamMembers(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		UserIDs []string `json:"user_ids"`
	}
	if !decodeJSON(w, r, 64<<10, &req) {
		return
	}
	users, ok := idList(w, req.UserIDs, "user_ids")
	if !ok {
		return
	}
	t, err := s.projects.SetTeamMembers(r.Context(), id, users)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// PUT /api/v1/admin/users/{id}/teams {team_ids} — replaces the teams a user belongs to.
func (s *Server) adminSetUserTeams(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		TeamIDs []string `json:"team_ids"`
	}
	if !decodeJSON(w, r, 64<<10, &req) {
		return
	}
	teams, ok := idList(w, req.TeamIDs, "team_ids")
	if !ok {
		return
	}
	out, err := s.projects.SetUserTeams(r.Context(), id, teams)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"team_ids": out})
}

// PATCH /api/v1/admin/teams/{id} {name?, description?}
func (s *Server) adminPatchTeam(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if !decodeJSON(w, r, 16<<10, &req) {
		return
	}
	var name, desc *string
	if req.Name != nil {
		n := clean(*req.Name)
		if n == "" || runeLen(n) > 100 {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "name is required (max 100 characters)")
			return
		}
		name = &n
	}
	if req.Description != nil {
		d := clean(*req.Description)
		if runeLen(d) > 2000 {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "description is too long")
			return
		}
		desc = &d
	}
	t, err := s.projects.UpdateTeam(r.Context(), id, name, desc)
	if errors.Is(err, store.ErrConflict) {
		writeErr(w, http.StatusConflict, "team_exists", "a team with this name already exists")
		return
	}
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// DELETE /api/v1/admin/teams/{id} — tickets of the team keep existing without a team.
func (s *Server) adminDeleteTeam(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	if err := s.projects.DeleteTeam(r.Context(), id); err != nil {
		writeStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /api/v1/admin/reports/amc?from=YYYY-MM-DD&to=YYYY-MM-DD&project_id=
// Tickets created from `from` through `to` (inclusive, UTC). Defaults to the current month.
func (s *Server) adminAMCReport(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	now := time.Now().UTC()
	from := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 1, 0)
	parse := func(v string) (time.Time, bool) {
		t, err := time.Parse(time.DateOnly, v)
		return t, err == nil
	}
	if v := q.Get("from"); v != "" {
		t, ok := parse(v)
		if !ok {
			writeErr(w, http.StatusBadRequest, "invalid_filter", "from must be YYYY-MM-DD")
			return
		}
		from = t
	}
	if v := q.Get("to"); v != "" {
		t, ok := parse(v)
		if !ok {
			writeErr(w, http.StatusBadRequest, "invalid_filter", "to must be YYYY-MM-DD")
			return
		}
		to = t.AddDate(0, 0, 1) // inclusive end date
	}
	if !to.After(from) || to.Sub(from) > 3*366*24*time.Hour {
		writeErr(w, http.StatusBadRequest, "invalid_filter", "the period must be between 1 day and 3 years")
		return
	}
	projectID := q.Get("project_id")
	if projectID != "" && !isUUID(projectID) {
		writeErr(w, http.StatusBadRequest, "invalid_filter", "invalid project_id")
		return
	}
	rows, err := s.admin.AMCReport(r.Context(), from, to, projectID)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from":  from.Format(time.DateOnly),
		"to":    to.AddDate(0, 0, -1).Format(time.DateOnly),
		"items": rows,
	})
}
