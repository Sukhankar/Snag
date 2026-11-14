package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/snag/server/internal/broker"
	"github.com/snag/server/internal/store"
)

// reporterToken reads the anonymous per-browser token that scopes "My Tickets".
func reporterToken(r *http.Request) (string, bool) {
	t := r.Header.Get("X-Reporter-Token")
	return t, reporterTokenRe.MatchString(t)
}

type createTicketReq struct {
	Title         string          `json:"title"`
	Description   string          `json:"description"`
	Category      string          `json:"category"`
	Priority      string          `json:"priority"`
	ReporterName  string          `json:"reporter_name"`
	ReporterEmail string          `json:"reporter_email"`
	AppVersion    string          `json:"app_version"`
	Telemetry     json.RawMessage `json:"telemetry"`
	Attachments   []attachmentIn  `json:"attachments"`
}

// POST /api/v1/widget/tickets
func (s *Server) widgetCreateTicket(w http.ResponseWriter, r *http.Request) {
	project := projectFrom(r)
	token, ok := reporterToken(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "reporter_token_required", "X-Reporter-Token must be 16-64 URL-safe characters")
		return
	}
	var req createTicketReq
	if !decodeJSON(w, r, s.cfg.MaxTicketBytes, &req) {
		return
	}

	in := store.NewTicket{
		Title:         clean(req.Title),
		Description:   clean(req.Description),
		Category:      strings.TrimSpace(req.Category),
		Priority:      strings.TrimSpace(req.Priority),
		ReporterName:  optional(req.ReporterName, 150),
		ReporterEmail: optional(req.ReporterEmail, 150),
		ReporterToken: token,
		AppVersion:    optional(req.AppVersion, 50),
	}
	if in.Category == "" {
		in.Category = "bug"
	}
	if in.Priority == "" {
		in.Priority = "P2_Normal"
	}
	switch {
	case in.Title == "" || runeLen(in.Title) > maxTitleRunes:
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "title is required (max 255 characters)")
		return
	case runeLen(in.Description) > maxDescriptionRunes:
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "description is too long")
		return
	case !store.OneOf(in.Category, store.Categories):
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid category")
		return
	case !store.OneOf(in.Priority, store.Priorities):
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid priority")
		return
	case in.ReporterEmail != nil && !emailRe.MatchString(*in.ReporterEmail):
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid reporter_email")
		return
	}

	var err error
	if in.Telemetry, err = sanitizeTelemetry(req.Telemetry); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if in.Attachments, err = validateAttachments(req.Attachments); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}

	created, err := s.widget.CreateTicket(r.Context(), project.ID, in)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ticket_code": created.Code,
		"status":      created.Status,
		"created_at":  created.CreatedAt,
	})

	if summary, err := s.admin.GetSummary(r.Context(), created.ID); err == nil {
		s.broker.Publish(broker.AdminTopic, "ticket.created", summary)
	}
	s.broker.Publish(broker.ReporterTopic(project.ID, token), "ticket.created", store.WidgetTicket{
		Code: created.Code, Title: in.Title, Category: in.Category, Priority: in.Priority,
		Status: created.Status, CreatedAt: created.CreatedAt, UpdatedAt: created.CreatedAt,
	})
}

// GET /api/v1/widget/tickets
func (s *Server) widgetListTickets(w http.ResponseWriter, r *http.Request) {
	token, ok := reporterToken(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "reporter_token_required", "")
		return
	}
	items, err := s.widget.ListTickets(r.Context(), projectFrom(r).ID, token)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// GET /api/v1/widget/tickets/{code}
func (s *Server) widgetGetTicket(w http.ResponseWriter, r *http.Request) {
	token, ok := reporterToken(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "reporter_token_required", "")
		return
	}
	d, err := s.widget.GetTicket(r.Context(), projectFrom(r).ID, token, chi.URLParam(r, "code"))
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

type widgetMessageReq struct {
	Body        string         `json:"body"`
	Attachments []attachmentIn `json:"attachments"`
}

// POST /api/v1/widget/tickets/{code}/messages
func (s *Server) widgetPostMessage(w http.ResponseWriter, r *http.Request) {
	project := projectFrom(r)
	token, ok := reporterToken(r)
	if !ok {
		writeErr(w, http.StatusBadRequest, "reporter_token_required", "")
		return
	}
	var req widgetMessageReq
	if !decodeJSON(w, r, s.cfg.MaxTicketBytes, &req) {
		return
	}
	body := clean(req.Body)
	if body == "" || runeLen(body) > maxMessageRunes {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "body is required (max 20000 characters)")
		return
	}
	atts, err := validateAttachments(req.Attachments)
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	aud, msg, err := s.widget.AddClientMessage(r.Context(), project.ID, token, chi.URLParam(r, "code"), body, atts)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, msg)

	s.broker.Publish(broker.ReporterTopic(project.ID, token), "message.created",
		map[string]any{"ticket_code": aud.Code, "message": msg})
	s.publishAdminMessage(r, aud, store.Message{
		ID: msg.ID, TicketID: aud.TicketID, AuthorType: msg.AuthorType, Body: msg.Body, CreatedAt: msg.CreatedAt,
	})
	s.publishAdminTicket(r, aud.TicketID)
}

// GET /api/v1/widget/stream?key=<project key>&token=<reporter token>
func (s *Server) widgetStream(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if !reporterTokenRe.MatchString(token) {
		writeErr(w, http.StatusBadRequest, "reporter_token_required", "")
		return
	}
	s.serveSSE(w, r, broker.ReporterTopic(projectFrom(r).ID, token), false)
}
