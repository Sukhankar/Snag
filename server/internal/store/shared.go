package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// insertAttachments queues all attachment inserts as one pipelined batch inside tx.
func insertAttachments(ctx context.Context, tx pgx.Tx, ticketID, messageID string, atts []NewAttachment) error {
	if len(atts) == 0 {
		return nil
	}
	b := &pgx.Batch{}
	for _, a := range atts {
		b.Queue(`INSERT INTO ticket_attachments
			(ticket_id, message_id, file_name, mime_type, compression_type, thumbnail_b64, payload_b64, compressed_size)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			ticketID, messageID, a.FileName, a.MimeType, a.CompressionType, a.ThumbnailB64, a.PayloadB64, a.CompressedSize)
	}
	return tx.SendBatch(ctx, b).Close()
}

func rollback(ctx context.Context, tx pgx.Tx) { _ = tx.Rollback(context.WithoutCancel(ctx)) }
