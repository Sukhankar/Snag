// Package store is the PostgreSQL repository layer.
//
// Two repositories deliberately share no query code:
//   - AdminRepo  — used only behind admin authentication; sees everything.
//   - WidgetRepo — used by client-facing endpoints. Every query is scoped to
//     (project_id, reporter_token) and hard-codes `is_internal = FALSE`, so internal
//     developer notes cannot reach a widget even if a handler is written carelessly.
package store

import (
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

// ValidationError is returned for requests that are well-formed but semantically invalid.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

var (
	Categories   = []string{"bug", "feature", "query", "amc_request"}
	Priorities   = []string{"P0_Critical", "P1_High", "P2_Normal", "P3_Low"}
	Statuses     = []string{"new", "triaged", "in_progress", "resolved", "closed"}
	ScopeClasses = []string{"unclassified", "bug", "change_request"}
)

func OneOf(v string, set []string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

type Project struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	ProjectKey     string    `json:"project_key"`
	AllowedOrigins []string  `json:"allowed_origins"`
	IsActive       bool      `json:"is_active"`
	CreatedAt      time.Time `json:"created_at"`
}

type Team struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

// TicketSummary is the lightweight inbox row: no description, telemetry or attachments.
type TicketSummary struct {
	ID             string    `json:"id"`
	Code           string    `json:"ticket_code"`
	ProjectID      string    `json:"project_id"`
	ProjectName    string    `json:"project_name"`
	TeamID         *string   `json:"team_id"`
	AssigneeID     *string   `json:"assignee_id"`
	ParentTicketID *string   `json:"parent_ticket_id"`
	Title          string    `json:"title"`
	Category       string    `json:"category"`
	Priority       string    `json:"priority"`
	Status         string    `json:"status"`
	ScopeClass     string    `json:"scope_class"`
	ReporterName   *string   `json:"reporter_name"`
	ReporterEmail  *string   `json:"reporter_email"`
	AppVersion     *string   `json:"app_version"`
	HasAttachments bool      `json:"has_attachments"`
	DuplicateCount int       `json:"duplicate_count"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type TicketRef struct {
	ID     string `json:"id"`
	Code   string `json:"ticket_code"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

type TicketDetail struct {
	TicketSummary
	Description *string          `json:"description"`
	Telemetry   json.RawMessage  `json:"telemetry"`
	Messages    []Message        `json:"messages"`
	Attachments []AttachmentMeta `json:"attachments"`
	Parent      *TicketRef       `json:"parent"`
	Duplicates  []TicketRef      `json:"duplicates"`
}

type Message struct {
	ID         string    `json:"id"`
	TicketID   string    `json:"ticket_id"`
	AuthorType string    `json:"author_type"`
	AuthorID   *string   `json:"author_id"`
	Body       string    `json:"body"`
	IsInternal bool      `json:"is_internal"`
	CreatedAt  time.Time `json:"created_at"`
}

type AttachmentMeta struct {
	ID              string    `json:"id"`
	TicketID        string    `json:"ticket_id"`
	MessageID       *string   `json:"message_id"`
	FileName        string    `json:"file_name"`
	MimeType        string    `json:"mime_type"`
	CompressionType string    `json:"compression_type"`
	ThumbnailB64    *string   `json:"thumbnail_b64"`
	CompressedSize  *int32    `json:"compressed_size"`
	CreatedAt       time.Time `json:"created_at"`
}

type AttachmentPayload struct {
	AttachmentMeta
	PayloadB64 string `json:"payload_b64"`
}

// NewAttachment is a validated, still-encoded attachment ready for insertion.
type NewAttachment struct {
	FileName        string
	MimeType        string
	CompressionType string
	ThumbnailB64    *string
	PayloadB64      string
	CompressedSize  int
}

type NewTicket struct {
	Title         string
	Description   string
	Category      string
	Priority      string
	ReporterName  *string
	ReporterEmail *string
	ReporterToken string
	AppVersion    *string
	Telemetry     json.RawMessage // nil → NULL
	Attachments   []NewAttachment
}

type CreatedTicket struct {
	ID        string    `json:"id"`
	Code      string    `json:"ticket_code"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

// Audience identifies who may receive client-facing realtime events for a ticket.
type Audience struct {
	TicketID      string
	Code          string
	ProjectID     string
	ReporterToken *string
}

// WidgetTicket is the client-safe projection of a ticket: no team, assignee, scope, or
// duplicate linkage.
type WidgetTicket struct {
	Code      string    `json:"ticket_code"`
	Title     string    `json:"title"`
	Category  string    `json:"category"`
	Priority  string    `json:"priority"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type WidgetMessage struct {
	ID         string    `json:"id"`
	AuthorType string    `json:"author_type"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"created_at"`
}

type WidgetAttachment struct {
	ID           string  `json:"id"`
	MessageID    *string `json:"message_id"`
	FileName     string  `json:"file_name"`
	MimeType     string  `json:"mime_type"`
	ThumbnailB64 *string `json:"thumbnail_b64"`
}

type WidgetTicketDetail struct {
	WidgetTicket
	Description *string            `json:"description"`
	Messages    []WidgetMessage    `json:"messages"`
	Attachments []WidgetAttachment `json:"attachments"`
}
