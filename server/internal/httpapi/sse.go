package httpapi

import (
	"bufio"
	"net/http"
	"time"

	"github.com/snag/server/internal/auth"
	"github.com/snag/server/internal/broker"
	"github.com/snag/server/internal/store"
)

const sseHeartbeat = 20 * time.Second

// serveSSE streams broker frames for topic until the client disconnects or the broker closes.
func (s *Server) serveSSE(w http.ResponseWriter, r *http.Request, topic string, allowRestricted bool) {
	checkAccess := func() bool {
		if topic != broker.AdminTopic || me(r).Service {
			return true
		}
		u, err := s.users.SessionUser(r.Context(), auth.TokenDigest(bearer(r)))
		if err != nil {
			return false
		}
		p := toPrincipal(u)
		allowRestricted = p.can("tickets.note")
		return !p.MustChangePassword && p.can("tickets.view")
	}
	if !checkAccess() {
		return
	}
	rc := http.NewResponseController(w)
	// Long-lived stream: lift the server-wide write deadline for this response only.
	if err := rc.SetWriteDeadline(time.Time{}); err != nil {
		writeErr(w, http.StatusInternalServerError, "streaming_unsupported", "")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no") // disable proxy buffering (nginx)
	w.WriteHeader(http.StatusOK)

	sub := s.broker.Subscribe(topic)
	defer s.broker.Unsubscribe(sub)

	bw := bufio.NewWriter(w)
	flush := func() bool {
		return bw.Flush() == nil && rc.Flush() == nil
	}
	bw.WriteString("retry: 3000\nevent: ready\ndata: {}\n\n")
	if !flush() {
		return
	}

	tick := time.NewTicker(sseHeartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case f, ok := <-sub.C:
			if !ok { // dropped as a slow consumer, or server shutting down
				return
			}
			if !checkAccess() {
				return
			}
			if f.Restricted && !allowRestricted {
				continue
			}
			bw.WriteString("event: ")
			bw.WriteString(f.Event)
			bw.WriteString("\ndata: ")
			bw.Write(f.Data) // json.Marshal output never contains raw newlines
			bw.WriteString("\n\n")
			// Coalesce bursts (e.g. a cascade resolution) into one flush.
			for drained := false; !drained; {
				select {
				case f, ok := <-sub.C:
					if !ok {
						flush()
						return
					}
					if !checkAccess() {
						return
					}
					if f.Restricted && !allowRestricted {
						continue
					}
					bw.WriteString("event: " + f.Event + "\ndata: ")
					bw.Write(f.Data)
					bw.WriteString("\n\n")
				default:
					drained = true
				}
			}
			if !flush() {
				return
			}
		case <-tick.C:
			if !checkAccess() {
				return
			}
			bw.WriteString(": ping\n\n")
			if !flush() {
				return
			}
		}
	}
}

// ---- publishing helpers (called after a successful commit) ----

func (s *Server) publishAdminTicket(r *http.Request, ticketID string) {
	if summary, err := s.admin.GetSummary(r.Context(), ticketID); err == nil {
		s.broker.Publish(broker.AdminTopic, "ticket.updated", summary)
	}
}

func (s *Server) publishAdminMessage(r *http.Request, aud store.Audience, m store.Message) {
	publish := s.broker.Publish
	if m.IsInternal {
		publish = s.broker.PublishRestricted // only for viewers with tickets.note
	}
	publish(broker.AdminTopic, "message.created", map[string]any{
		"ticket_id": aud.TicketID, "ticket_code": aud.Code, "message": m,
	})
}

// publishClient sends client-safe events to the ticket's reporter. Internal messages are
// never passed here; the guard below is defence in depth.
func (s *Server) publishClientMessage(aud store.Audience, m store.Message) {
	if m.IsInternal || aud.ReporterToken == nil {
		return
	}
	s.broker.Publish(broker.ReporterTopic(aud.ProjectID, *aud.ReporterToken), "message.created", map[string]any{
		"ticket_code": aud.Code,
		"message": store.WidgetMessage{
			ID: m.ID, AuthorType: m.AuthorType, Body: m.Body, CreatedAt: m.CreatedAt,
		},
	})
}

func (s *Server) publishClientStatus(aud store.Audience, status string) {
	if aud.ReporterToken == nil {
		return
	}
	s.broker.Publish(broker.ReporterTopic(aud.ProjectID, *aud.ReporterToken), "ticket.updated", map[string]any{
		"ticket_code": aud.Code, "status": status,
	})
}

func (s *Server) adminStream(w http.ResponseWriter, r *http.Request) {
	s.serveSSE(w, r, broker.AdminTopic, me(r).can("tickets.note"))
}
