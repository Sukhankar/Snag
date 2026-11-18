package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/snag/server/internal/broker"
	"github.com/snag/server/internal/store"
)

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
	rep, ok := s.reporterFrom(w, r)
	if !ok {
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
		ReporterToken: rep.key,
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
	s.broker.Publish(broker.ReporterTopic(project.ID, rep.key), "ticket.created", store.WidgetTicket{
		Code: created.Code, Title: in.Title, Category: in.Category, Priority: in.Priority,
		Status: created.Status, CreatedAt: created.CreatedAt, UpdatedAt: created.CreatedAt,
	})
}

// GET /api/v1/widget/tickets
func (s *Server) widgetListTickets(w http.ResponseWriter, r *http.Request) {
	rep, ok := s.reporterFrom(w, r)
	if !ok {
		return
	}
	items, err := s.widget.ListTickets(r.Context(), projectFrom(r).ID, rep.key)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// GET /api/v1/widget/tickets/{code}
func (s *Server) widgetGetTicket(w http.ResponseWriter, r *http.Request) {
	rep, ok := s.reporterFrom(w, r)
	if !ok {
		return
	}
	d, err := s.widget.GetTicket(r.Context(), projectFrom(r).ID, rep.key, chi.URLParam(r, "code"))
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
	rep, ok := s.reporterFrom(w, r)
	if !ok {
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
	aud, msg, reopened, err := s.widget.AddClientMessage(r.Context(), project.ID, rep.key, chi.URLParam(r, "code"), body, atts)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, msg)

	s.broker.Publish(broker.ReporterTopic(project.ID, rep.key), "message.created",
		map[string]any{"ticket_code": aud.Code, "message": msg})
	s.publishAdminMessage(r, aud, store.Message{
		ID: msg.ID, TicketID: aud.TicketID, AuthorType: msg.AuthorType, Body: msg.Body, CreatedAt: msg.CreatedAt,
	})
	s.publishAdminTicket(r, aud.TicketID)
	if reopened {
		s.publishClientStatus(aud, "triaged")
	}
}

// POST /api/v1/widget/stream-ticket — exchanges the reporter headers for a single-use ticket.
func (s *Server) widgetStreamTicket(w http.ResponseWriter, r *http.Request) {
	rep, ok := s.reporterFrom(w, r)
	if !ok {
		return
	}
	id, ok := s.streams.issue(projectFrom(r).ID, rep)
	if !ok {
		writeErr(w, http.StatusServiceUnavailable, "busy", "try again shortly")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ticket": id, "expires_in": int(streamTicketTTL.Seconds())})
}

// GET /api/v1/widget/stream?key=<project key>&ticket=<stream ticket>
// A stream opened with a signed identity ends when that identity expires; the widget then
// needs a fresh token from the host application to reconnect.
func (s *Server) widgetStream(w http.ResponseWriter, r *http.Request) {
	project := projectFrom(r)
	rep, ok := s.streams.take(r.URL.Query().Get("ticket"), project.ID)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "stream_ticket_invalid", "request a new ticket from POST /stream-ticket")
		return
	}
	if rep.signed {
		ctx, cancel := context.WithDeadline(r.Context(), rep.expires)
		defer cancel()
		r = r.WithContext(ctx)
	}
	s.serveSSE(w, r, broker.ReporterTopic(project.ID, rep.key), false)
}
