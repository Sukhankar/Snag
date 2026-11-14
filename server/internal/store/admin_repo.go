package store

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AdminRepo backs the operations dashboard. It is only reachable behind admin auth.
type AdminRepo struct{ pool *pgxpool.Pool }

func NewAdminRepo(pool *pgxpool.Pool) *AdminRepo { return &AdminRepo{pool: pool} }

// Inbox rows: metadata only. The EXISTS probe hits ticket_attachments_ticket_idx and never
// touches the TOASTed payload column.
const summaryCols = `
	t.id, t.ticket_code, t.project_id, p.name, t.team_id, t.assignee_id, t.parent_ticket_id,
	t.title, t.category, t.priority, t.status, t.scope_class,
	t.reporter_name, t.reporter_email, t.app_version,
	EXISTS (SELECT 1 FROM ticket_attachments a WHERE a.ticket_id = t.id),
	(SELECT count(*) FROM tickets c WHERE c.parent_ticket_id = t.id)::int,
	t.created_at, t.updated_at`

func scanSummary(row pgx.Row, extra ...any) (TicketSummary, error) {
	var s TicketSummary
	dest := []any{
		&s.ID, &s.Code, &s.ProjectID, &s.ProjectName, &s.TeamID, &s.AssigneeID, &s.ParentTicketID,
		&s.Title, &s.Category, &s.Priority, &s.Status, &s.ScopeClass,
		&s.ReporterName, &s.ReporterEmail, &s.AppVersion,
		&s.HasAttachments, &s.DuplicateCount, &s.CreatedAt, &s.UpdatedAt,
	}
	err := row.Scan(append(dest, extra...)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, ErrNotFound
	}
	return s, err
}

// ---- keyset cursor ----

type Cursor struct {
	CreatedAt time.Time
	ID        string
}

func (c Cursor) Encode() string {
	raw := c.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + c.ID
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func DecodeCursor(s string) (*Cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, &ValidationError{"invalid cursor"}
	}
	ts, id, ok := strings.Cut(string(raw), "|")
	if !ok {
		return nil, &ValidationError{"invalid cursor"}
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return nil, &ValidationError{"invalid cursor"}
	}
	return &Cursor{CreatedAt: t, ID: id}, nil
}

type ListFilter struct {
	Cursor     *Cursor
	Limit      int
	ProjectID  string
	TeamID     string
	Statuses   []string
	Category   string
	Priority   string
	ScopeClass string
	Query      string
	// AssigneeID filters by assignee: a user id, or "none" for unassigned tickets.
	AssigneeID string
	// TopLevelOnly hides tickets that are linked as duplicates of another ticket.
	TopLevelOnly bool
}

type TicketPage struct {
	Items      []TicketSummary `json:"items"`
	NextCursor *string         `json:"next_cursor"`
}

func (r *AdminRepo) ListTickets(ctx context.Context, f ListFilter) (TicketPage, error) {
	var (
		where []string
		args  []any
	)
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	if f.Cursor != nil {
		where = append(where, fmt.Sprintf("(t.created_at, t.id) < (%s, %s::uuid)", arg(f.Cursor.CreatedAt), arg(f.Cursor.ID)))
	}
	if f.ProjectID != "" {
		where = append(where, "t.project_id = "+arg(f.ProjectID)+"::uuid")
	}
	if f.TeamID != "" {
		where = append(where, "t.team_id = "+arg(f.TeamID)+"::uuid")
	}
	if len(f.Statuses) > 0 {
		where = append(where, "t.status = ANY("+arg(f.Statuses)+"::text[])")
	}
	if f.Category != "" {
		where = append(where, "t.category = "+arg(f.Category))
	}
	if f.Priority != "" {
		where = append(where, "t.priority = "+arg(f.Priority))
	}
	if f.ScopeClass != "" {
		where = append(where, "t.scope_class = "+arg(f.ScopeClass))
	}
	if f.TopLevelOnly {
		where = append(where, "t.parent_ticket_id IS NULL")
	}
	switch f.AssigneeID {
	case "":
	case "none":
		where = append(where, "t.assignee_id IS NULL")
	default:
		where = append(where, "t.assignee_id = "+arg(f.AssigneeID)+"::uuid")
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		p := arg("%" + escapeLike(q) + "%")
		where = append(where, fmt.Sprintf("(t.title ILIKE %s OR t.ticket_code ILIKE %s OR t.reporter_email ILIKE %s OR t.reporter_name ILIKE %s)", p, p, p, p))
	}
	limit := f.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	sql := `SELECT ` + summaryCols + ` FROM tickets t JOIN projects p ON p.id = t.project_id`
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY t.created_at DESC, t.id DESC LIMIT " + arg(limit+1)

	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return TicketPage{}, err
	}
	defer rows.Close()
	page := TicketPage{Items: make([]TicketSummary, 0, limit)}
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, s)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		next := Cursor{CreatedAt: last.CreatedAt, ID: last.ID}.Encode()
		page.NextCursor = &next
	}
	return page, nil
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

func (r *AdminRepo) GetSummary(ctx context.Context, id string) (TicketSummary, error) {
	return scanSummary(r.pool.QueryRow(ctx,
		`SELECT `+summaryCols+` FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, id))
}

func (r *AdminRepo) GetTicket(ctx context.Context, id string) (TicketDetail, error) {
	var d TicketDetail
	var telemetry []byte
	s, err := scanSummary(r.pool.QueryRow(ctx, `
		SELECT `+summaryCols+`, t.description, t.telemetry_json
		FROM tickets t JOIN projects p ON p.id = t.project_id
		WHERE t.id = $1`, id), &d.Description, &telemetry)
	if err != nil {
		return d, err
	}
	d.TicketSummary = s
	if len(telemetry) > 0 {
		d.Telemetry = telemetry
	}

	rows, err := r.pool.Query(ctx, `
		SELECT id, ticket_id, author_type, author_id, body, is_internal, created_at
		FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at, id`, id)
	if err != nil {
		return d, err
	}
	d.Messages, err = collectMessages(rows)
	if err != nil {
		return d, err
	}

	rows, err = r.pool.Query(ctx, `
		SELECT id, ticket_id, message_id, file_name, mime_type, compression_type,
		       thumbnail_b64, compressed_size, created_at
		FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at, id`, id)
	if err != nil {
		return d, err
	}
	d.Attachments = []AttachmentMeta{}
	for rows.Next() {
		var a AttachmentMeta
		if err := rows.Scan(&a.ID, &a.TicketID, &a.MessageID, &a.FileName, &a.MimeType, &a.CompressionType,
			&a.ThumbnailB64, &a.CompressedSize, &a.CreatedAt); err != nil {
			rows.Close()
			return d, err
		}
		d.Attachments = append(d.Attachments, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return d, err
	}

	if d.ParentTicketID != nil {
		var p TicketRef
		err := r.pool.QueryRow(ctx, `SELECT id, ticket_code, title, status FROM tickets WHERE id = $1`,
			*d.ParentTicketID).Scan(&p.ID, &p.Code, &p.Title, &p.Status)
		if err == nil {
			d.Parent = &p
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return d, err
		}
	}

	rows, err = r.pool.Query(ctx, `
		SELECT id, ticket_code, title, status FROM tickets
		WHERE parent_ticket_id = $1 ORDER BY created_at`, id)
	if err != nil {
		return d, err
	}
	defer rows.Close()
	d.Duplicates = []TicketRef{}
	for rows.Next() {
		var c TicketRef
		if err := rows.Scan(&c.ID, &c.Code, &c.Title, &c.Status); err != nil {
			return d, err
		}
		d.Duplicates = append(d.Duplicates, c)
	}
	if err := rows.Err(); err != nil {
		return d, err
	}
	d.Events, err = r.events(ctx, id)
	return d, err
}

func collectMessages(rows pgx.Rows) ([]Message, error) {
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.TicketID, &m.AuthorType, &m.AuthorID, &m.Body, &m.IsInternal, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (r *AdminRepo) GetAttachment(ctx context.Context, id string) (AttachmentPayload, error) {
	var a AttachmentPayload
	err := r.pool.QueryRow(ctx, `
		SELECT id, ticket_id, message_id, file_name, mime_type, compression_type,
		       thumbnail_b64, compressed_size, created_at, payload_b64
		FROM ticket_attachments WHERE id = $1`, id,
	).Scan(&a.ID, &a.TicketID, &a.MessageID, &a.FileName, &a.MimeType, &a.CompressionType,
		&a.ThumbnailB64, &a.CompressedSize, &a.CreatedAt, &a.PayloadB64)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

func (r *AdminRepo) Audience(ctx context.Context, ticketID string) (Audience, error) {
	a := Audience{TicketID: ticketID}
	err := r.pool.QueryRow(ctx, `SELECT ticket_code, project_id, reporter_token FROM tickets WHERE id = $1`,
		ticketID).Scan(&a.Code, &a.ProjectID, &a.ReporterToken)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

// ---- triage mutations ----

// TicketPatch fields are applied only when non-nil. The *Set flags distinguish "set to
// NULL" from "leave unchanged" for nullable references.
type TicketPatch struct {
	Status      *string
	Priority    *string
	Category    *string
	ScopeClass  *string
	TeamSet     bool
	TeamID      *string
	AssigneeSet bool
	AssigneeID  *string
	ParentSet   bool
	ParentID    *string
	ActorID     string
}

// Notice is a client-visible side effect (a system message on a linked duplicate) that the
// caller must publish after commit.
type Notice struct {
	Audience Audience
	Status   string
	Message  Message
}

type UpdateResult struct {
	Ticket   TicketSummary
	Internal []Message // internal system notes created on the ticket itself
	Notices  []Notice
}

var finalStatuses = map[string]bool{"resolved": true, "closed": true}

// UpdateTicket applies a triage patch in one transaction. Linking to a parent flattens the
// hierarchy (duplicates always point at a root ticket and the ticket's own duplicates are
// re-homed). Resolving/closing a root cascades to its open duplicates and posts a public
// system message on each so their reporters are notified.
func (r *AdminRepo) UpdateTicket(ctx context.Context, id string, p TicketPatch) (UpdateResult, error) {
	var res UpdateResult
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer rollback(ctx, tx)

	var (
		code, oldStatus, oldPriority, oldCategory, oldScope string
		oldTeam, oldAssignee, oldParent                     *string
	)
	err = tx.QueryRow(ctx, `
		SELECT ticket_code, status, priority, category, scope_class, team_id, assignee_id, parent_ticket_id
		FROM tickets WHERE id = $1 FOR UPDATE`, id,
	).Scan(&code, &oldStatus, &oldPriority, &oldCategory, &oldScope, &oldTeam, &oldAssignee, &oldParent)
	if errors.Is(err, pgx.ErrNoRows) {
		return res, ErrNotFound
	}
	if err != nil {
		return res, err
	}

	var (
		sets []string
		args = []any{id}
	)
	set := func(col string, v any) {
		args = append(args, v)
		sets = append(sets, col+" = $"+strconv.Itoa(len(args)))
	}
	if p.Status != nil {
		set("status", *p.Status)
	}
	if p.Priority != nil {
		set("priority", *p.Priority)
	}
	if p.Category != nil {
		set("category", *p.Category)
	}
	if p.ScopeClass != nil {
		set("scope_class", *p.ScopeClass)
	}
	if p.TeamSet {
		set("team_id", p.TeamID)
	}
	if p.AssigneeSet {
		set("assignee_id", p.AssigneeID)
	}

	if p.ParentSet {
		if p.ParentID == nil {
			set("parent_ticket_id", nil)
			note, err := addMessage(ctx, tx, id, "system", p.ActorID, "Unlinked from parent ticket.", true)
			if err != nil {
				return res, err
			}
			res.Internal = append(res.Internal, note)
		} else {
			rootID, rootCode, err := resolveRoot(ctx, tx, *p.ParentID)
			if err != nil {
				return res, err
			}
			if rootID == id {
				return res, &ValidationError{"cannot link a ticket to itself or to one of its own duplicates"}
			}
			set("parent_ticket_id", rootID)
			// Re-home this ticket's own duplicates so the hierarchy stays one level deep.
			if _, err := tx.Exec(ctx, `UPDATE tickets SET parent_ticket_id = $2 WHERE parent_ticket_id = $1`, id, rootID); err != nil {
				return res, err
			}
			note, err := addMessage(ctx, tx, id, "system", p.ActorID, "Linked as duplicate of "+rootCode+".", true)
			if err != nil {
				return res, err
			}
			res.Internal = append(res.Internal, note)
		}
	}

	if len(sets) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE tickets SET `+strings.Join(sets, ", ")+` WHERE id = $1`, args...); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				return res, &ValidationError{"team or assignee not found"}
			}
			return res, err
		}
	}

	// Activity log: one row per field that actually changed.
	ev := eventLog{ctx: ctx, tx: tx, ticketID: id, actor: p.ActorID}
	ev.change("status", &oldStatus, p.Status)
	ev.change("priority", &oldPriority, p.Priority)
	ev.change("category", &oldCategory, p.Category)
	ev.change("scope_class", &oldScope, p.ScopeClass)
	if p.TeamSet && !sameRef(oldTeam, p.TeamID) {
		ev.add("team", ev.name(ctx, `SELECT name FROM teams WHERE id = $1`, oldTeam), ev.name(ctx, `SELECT name FROM teams WHERE id = $1`, p.TeamID), nil)
	}
	if p.AssigneeSet && !sameRef(oldAssignee, p.AssigneeID) {
		ev.add("assignee", ev.name(ctx, `SELECT name FROM users WHERE id = $1`, oldAssignee), ev.name(ctx, `SELECT name FROM users WHERE id = $1`, p.AssigneeID), nil)
	}
	if p.ParentSet {
		var newParent *string
		if len(sets) > 0 {
			_ = tx.QueryRow(ctx, `SELECT parent_ticket_id FROM tickets WHERE id = $1`, id).Scan(&newParent)
		}
		if !sameRef(oldParent, newParent) {
			ev.add("parent", ev.name(ctx, `SELECT ticket_code FROM tickets WHERE id = $1`, oldParent), ev.name(ctx, `SELECT ticket_code FROM tickets WHERE id = $1`, newParent), nil)
		}
	}
	if ev.err != nil {
		return res, ev.err
	}

	if p.Status != nil && *p.Status != oldStatus && finalStatuses[*p.Status] {
		rows, err := tx.Query(ctx, `
			UPDATE tickets SET status = $2
			WHERE parent_ticket_id = $1 AND status NOT IN ('resolved', 'closed')
			RETURNING id, ticket_code, project_id, reporter_token`, id, *p.Status)
		if err != nil {
			return res, err
		}
		var children []Audience
		for rows.Next() {
			var a Audience
			if err := rows.Scan(&a.TicketID, &a.Code, &a.ProjectID, &a.ReporterToken); err != nil {
				rows.Close()
				return res, err
			}
			children = append(children, a)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return res, err
		}
		verb := "resolved"
		if *p.Status == "closed" {
			verb = "closed"
		}
		for _, c := range children {
			body := fmt.Sprintf("This issue has been %s. It was tracked together with %s, reported by other users as well.", verb, code)
			m, err := addMessage(ctx, tx, c.TicketID, "system", "", body, false)
			if err != nil {
				return res, err
			}
			note := "Follows " + code
			if err := insertEvent(ctx, tx, c.TicketID, p.ActorID, "status", nil, p.Status, &note); err != nil {
				return res, err
			}
			res.Notices = append(res.Notices, Notice{Audience: c, Status: *p.Status, Message: m})
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return res, err
	}
	res.Ticket, err = r.GetSummary(ctx, id)
	return res, err
}

func resolveRoot(ctx context.Context, tx pgx.Tx, parentID string) (string, string, error) {
	var (
		pid, pcode string
		pparent    *string
	)
	err := tx.QueryRow(ctx, `SELECT id, ticket_code, parent_ticket_id FROM tickets WHERE id = $1 FOR UPDATE`,
		parentID).Scan(&pid, &pcode, &pparent)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", &ValidationError{"parent ticket not found"}
	}
	if err != nil {
		return "", "", err
	}
	if pparent == nil {
		return pid, pcode, nil
	}
	err = tx.QueryRow(ctx, `SELECT id, ticket_code FROM tickets WHERE id = $1`, *pparent).Scan(&pid, &pcode)
	return pid, pcode, err
}

func addMessage(ctx context.Context, tx pgx.Tx, ticketID, authorType, authorID, body string, internal bool) (Message, error) {
	var m Message
	var aid *string
	if authorID != "" {
		aid = &authorID
	}
	err := tx.QueryRow(ctx, `
		INSERT INTO ticket_messages (ticket_id, author_type, author_id, body, is_internal)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, ticket_id, author_type, author_id, body, is_internal, created_at`,
		ticketID, authorType, aid, body, internal,
	).Scan(&m.ID, &m.TicketID, &m.AuthorType, &m.AuthorID, &m.Body, &m.IsInternal, &m.CreatedAt)
	return m, err
}

// AddDeveloperMessage posts a public reply or private internal note. A public reply on a
// 'new' ticket moves it to 'triaged'.
func (r *AdminRepo) AddDeveloperMessage(ctx context.Context, ticketID, authorID, body string, internal bool) (Message, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer rollback(ctx, tx)
	tag, err := tx.Exec(ctx, `
		UPDATE tickets SET status = CASE WHEN status = 'new' AND NOT $2 THEN 'triaged' ELSE status END
		WHERE id = $1`, ticketID, internal)
	if err != nil {
		return Message{}, err
	}
	if tag.RowsAffected() == 0 {
		return Message{}, ErrNotFound
	}
	m, err := addMessage(ctx, tx, ticketID, "developer", authorID, body, internal)
	if err != nil {
		return m, err
	}
	return m, tx.Commit(ctx)
}

// Broadcast posts the same public developer message on a root ticket and every ticket
// linked to it as a duplicate.
func (r *AdminRepo) Broadcast(ctx context.Context, rootID, authorID, body string) ([]Notice, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)
	rows, err := tx.Query(ctx, `
		SELECT id, ticket_code, project_id, reporter_token, status FROM tickets
		WHERE id = $1 OR parent_ticket_id = $1`, rootID)
	if err != nil {
		return nil, err
	}
	type target struct {
		aud    Audience
		status string
	}
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.aud.TicketID, &t.aud.Code, &t.aud.ProjectID, &t.aud.ReporterToken, &t.status); err != nil {
			rows.Close()
			return nil, err
		}
		targets = append(targets, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		return nil, ErrNotFound
	}
	notices := make([]Notice, 0, len(targets))
	for _, t := range targets {
		m, err := addMessage(ctx, tx, t.aud.TicketID, "developer", authorID, body, false)
		if err != nil {
			return nil, err
		}
		notices = append(notices, Notice{Audience: t.aud, Status: t.status, Message: m})
	}
	return notices, tx.Commit(ctx)
}

// ---- activity log ----

func sameRef(a, b *string) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

func insertEvent(ctx context.Context, tx pgx.Tx, ticketID, actor, field string, oldValue, newValue, note *string) error {
	var a *string
	if actor != "" {
		a = &actor
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO ticket_events (ticket_id, actor, field, old_value, new_value, note)
		VALUES ($1, $2, $3, $4, $5, $6)`, ticketID, a, field, oldValue, newValue, note)
	return err
}

// eventLog collects activity rows inside an UpdateTicket transaction; the first error sticks.
type eventLog struct {
	ctx      context.Context
	tx       pgx.Tx
	ticketID string
	actor    string
	err      error
}

func (e *eventLog) add(field string, oldValue, newValue *string, note *string) {
	if e.err == nil {
		e.err = insertEvent(e.ctx, e.tx, e.ticketID, e.actor, field, oldValue, newValue, note)
	}
}

func (e *eventLog) change(field string, oldValue, newValue *string) {
	if newValue != nil && *newValue != *oldValue {
		e.add(field, oldValue, newValue, nil)
	}
}

// name resolves a reference to its display text (team name, user name, ticket code).
func (e *eventLog) name(ctx context.Context, query string, id *string) *string {
	if id == nil || e.err != nil {
		return nil
	}
	var v string
	if err := e.tx.QueryRow(ctx, query, *id).Scan(&v); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			e.err = err
		}
		return nil
	}
	return &v
}

// recordReopen logs a reporter reply that reopened a resolved ticket.
func recordReopen(ctx context.Context, tx pgx.Tx, ticketID string) error {
	old, now, note := "resolved", "triaged", "Reopened by the reporter's reply"
	return insertEvent(ctx, tx, ticketID, "Reporter", "status", &old, &now, &note)
}

func (r *AdminRepo) events(ctx context.Context, ticketID string) ([]TicketEvent, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, actor, field, old_value, new_value, note, created_at
		FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at, id`, ticketID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TicketEvent{}
	for rows.Next() {
		var e TicketEvent
		if err := rows.Scan(&e.ID, &e.Actor, &e.Field, &e.OldValue, &e.NewValue, &e.Note, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
