package store

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// WidgetRepo serves client-facing widget endpoints only.
//
// INVARIANTS — every method:
//  1. scopes tickets by BOTH project_id AND reporter_token, and
//  2. reads messages/attachments only through `is_internal = FALSE`.
//
// Do not add a method here that takes a raw ticket UUID from the client, and do not reuse
// AdminRepo queries in widget handlers.
type WidgetRepo struct{ pool *pgxpool.Pool }

func NewWidgetRepo(pool *pgxpool.Pool) *WidgetRepo { return &WidgetRepo{pool: pool} }

// CreateTicket atomically inserts the ticket, its initial client message and all
// compressed attachments. Either everything is committed or nothing is.
func (r *WidgetRepo) CreateTicket(ctx context.Context, projectID string, in NewTicket) (CreatedTicket, error) {
	var out CreatedTicket
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer rollback(ctx, tx)

	var telemetry any // untyped nil → SQL NULL
	if len(in.Telemetry) > 0 {
		telemetry = string(in.Telemetry)
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO tickets
			(project_id, reporter_name, reporter_email, reporter_token, title, description,
			 category, priority, app_version, telemetry_json)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7, $8, $9, $10::jsonb)
		RETURNING id, ticket_code, status, created_at`,
		projectID, in.ReporterName, in.ReporterEmail, in.ReporterToken, in.Title, in.Description,
		in.Category, in.Priority, in.AppVersion, telemetry,
	).Scan(&out.ID, &out.Code, &out.Status, &out.CreatedAt)
	if err != nil {
		return out, err
	}

	body := strings.TrimSpace(in.Description)
	if body == "" {
		body = in.Title
	}
	var messageID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO ticket_messages (ticket_id, author_type, author_id, body, is_internal)
		VALUES ($1, 'client', $2, $3, FALSE) RETURNING id`,
		out.ID, in.ReporterEmail, body,
	).Scan(&messageID); err != nil {
		return out, err
	}

	if err := insertAttachments(ctx, tx, out.ID, messageID, in.Attachments); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func (r *WidgetRepo) ListTickets(ctx context.Context, projectID, token string) ([]WidgetTicket, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT ticket_code, title, category, priority, status, created_at, updated_at
		FROM tickets
		WHERE project_id = $1 AND reporter_token = $2
		ORDER BY created_at DESC
		LIMIT 100`, projectID, token)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WidgetTicket{}
	for rows.Next() {
		var t WidgetTicket
		if err := rows.Scan(&t.Code, &t.Title, &t.Category, &t.Priority, &t.Status, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *WidgetRepo) GetTicket(ctx context.Context, projectID, token, code string) (WidgetTicketDetail, error) {
	var d WidgetTicketDetail
	var ticketID string
	err := r.pool.QueryRow(ctx, `
		SELECT id, ticket_code, title, category, priority, status, created_at, updated_at, description
		FROM tickets
		WHERE project_id = $1 AND reporter_token = $2 AND ticket_code = $3`,
		projectID, token, code,
	).Scan(&ticketID, &d.Code, &d.Title, &d.Category, &d.Priority, &d.Status, &d.CreatedAt, &d.UpdatedAt, &d.Description)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, ErrNotFound
	}
	if err != nil {
		return d, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT id, author_type, body, created_at
		FROM ticket_messages
		WHERE ticket_id = $1 AND is_internal = FALSE
		ORDER BY created_at, id`, ticketID)
	if err != nil {
		return d, err
	}
	d.Messages = []WidgetMessage{}
	for rows.Next() {
		var m WidgetMessage
		if err := rows.Scan(&m.ID, &m.AuthorType, &m.Body, &m.CreatedAt); err != nil {
			rows.Close()
			return d, err
		}
		d.Messages = append(d.Messages, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return d, err
	}

	// Attachments are visible only when they hang off a public message.
	rows, err = r.pool.Query(ctx, `
		SELECT a.id, a.message_id, a.file_name, a.mime_type, a.thumbnail_b64
		FROM ticket_attachments a
		JOIN ticket_messages m ON m.id = a.message_id AND m.is_internal = FALSE
		WHERE a.ticket_id = $1
		ORDER BY a.created_at, a.id`, ticketID)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	d.Attachments = []WidgetAttachment{}
	for rows.Next() {
		var a WidgetAttachment
		if err := rows.Scan(&a.ID, &a.MessageID, &a.FileName, &a.MimeType, &a.ThumbnailB64); err != nil {
			return d, err
		}
		d.Attachments = append(d.Attachments, a)
	}
	return d, rows.Err()
}

// AddClientMessage appends a reporter follow-up. A reply on a resolved ticket reopens it
// (status back to triaged) and is recorded in the activity log; reopened reports that.
func (r *WidgetRepo) AddClientMessage(ctx context.Context, projectID, token, code, body string, atts []NewAttachment) (aud Audience, m WidgetMessage, reopened bool, err error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return aud, m, false, err
	}
	defer rollback(ctx, tx)

	var status string
	var email *string
	err = tx.QueryRow(ctx, `
		SELECT id, ticket_code, project_id, reporter_token, status, reporter_email
		FROM tickets
		WHERE project_id = $1 AND reporter_token = $2 AND ticket_code = $3
		FOR UPDATE`, projectID, token, code,
	).Scan(&aud.TicketID, &aud.Code, &aud.ProjectID, &aud.ReporterToken, &status, &email)
	if errors.Is(err, pgx.ErrNoRows) {
		return aud, m, false, ErrNotFound
	}
	if err != nil {
		return aud, m, false, err
	}
	if status == "closed" {
		return aud, m, false, ErrConflict
	}

	if err := tx.QueryRow(ctx, `
		INSERT INTO ticket_messages (ticket_id, author_type, author_id, body, is_internal)
		VALUES ($1, 'client', $2, $3, FALSE)
		RETURNING id, author_type, body, created_at`, aud.TicketID, email, body,
	).Scan(&m.ID, &m.AuthorType, &m.Body, &m.CreatedAt); err != nil {
		return aud, m, false, err
	}
	if err := insertAttachments(ctx, tx, aud.TicketID, m.ID, atts); err != nil {
		return aud, m, false, err
	}
	reopened = status == "resolved"
	// Always touch the row so updated_at reflects the new activity.
	if _, err := tx.Exec(ctx, `
		UPDATE tickets SET status = CASE WHEN status = 'resolved' THEN 'triaged' ELSE status END
		WHERE id = $1`, aud.TicketID); err != nil {
		return aud, m, false, err
	}
	if reopened {
		if err := recordReopen(ctx, tx, aud.TicketID); err != nil {
			return aud, m, false, err
		}
	}
	return aud, m, reopened, tx.Commit(ctx)
}
