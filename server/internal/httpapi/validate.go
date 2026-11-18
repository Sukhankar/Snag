package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/snag/server/internal/store"
)

const (
	maxAttachments      = 10
	maxAttachmentBytes  = 8 << 20  // decoded size per attachment
	maxThumbnailB64     = 48 << 10 // ~36KB decoded; widget targets ~4KB
	maxTelemetryBytes   = 256 << 10
	maxTitleRunes       = 255
	maxDescriptionRunes = 20000
	maxMessageRunes     = 20000
)

type attachmentIn struct {
	FileName        string  `json:"file_name"`
	MimeType        string  `json:"mime_type"`
	CompressionType string  `json:"compression_type"`
	ThumbnailB64    *string `json:"thumbnail_b64"`
	PayloadB64      string  `json:"payload_b64"`
}

// Accepted MIME types and the compression types valid for each.
var allowedAttachments = map[string][]string{
	"image/webp":       {"webp_canvas", "none"},
	"image/jpeg":       {"jpeg_canvas", "none"},
	"image/png":        {"png_canvas", "none"},
	"text/plain":       {"gzip", "none"},
	"text/csv":         {"gzip", "none"},
	"application/json": {"gzip", "none"},
	"application/xml":  {"gzip", "none"},
	"text/xml":         {"gzip", "none"},
	"application/pdf":  {"none"},
}

var (
	magicGzip = []byte{0x1f, 0x8b}
	magicJPEG = []byte{0xff, 0xd8, 0xff}
	magicPNG  = []byte{0x89, 'P', 'N', 'G'}
	magicPDF  = []byte("%PDF")
)

func isWebP(b []byte) bool {
	return len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP"))
}

func isImage(b []byte) bool {
	return isWebP(b) || bytes.HasPrefix(b, magicJPEG) || bytes.HasPrefix(b, magicPNG)
}

// checkMagic verifies decoded bytes match the declared type, so a payload labelled as an
// image really is one when the dashboard renders it.
func checkMagic(mime, compression string, b []byte) bool {
	if compression == "gzip" {
		return bytes.HasPrefix(b, magicGzip)
	}
	switch mime {
	case "image/webp":
		return isWebP(b)
	case "image/jpeg":
		return bytes.HasPrefix(b, magicJPEG)
	case "image/png":
		return bytes.HasPrefix(b, magicPNG)
	case "application/pdf":
		return bytes.HasPrefix(b, magicPDF)
	default: // uncompressed text: must be valid UTF-8 without NULs
		return utf8.Valid(b) && !bytes.ContainsRune(b, 0)
	}
}

func validateAttachments(in []attachmentIn) ([]store.NewAttachment, error) {
	if len(in) > maxAttachments {
		return nil, fmt.Errorf("at most %d attachments are allowed", maxAttachments)
	}
	out := make([]store.NewAttachment, 0, len(in))
	for i, a := range in {
		mime := strings.ToLower(strings.TrimSpace(a.MimeType))
		comp := strings.ToLower(strings.TrimSpace(a.CompressionType))
		allowedComp, ok := allowedAttachments[mime]
		if !ok {
			return nil, fmt.Errorf("attachment %d: unsupported mime_type %q", i, a.MimeType)
		}
		if !store.OneOf(comp, allowedComp) {
			return nil, fmt.Errorf("attachment %d: compression_type %q is not valid for %s", i, a.CompressionType, mime)
		}
		name := path.Base(strings.ReplaceAll(clean(a.FileName), `\`, "/"))
		if name == "" || name == "." || name == "/" {
			name = fmt.Sprintf("attachment-%d", i+1)
		}
		if runeLen(name) > 255 {
			name = string([]rune(name)[:255])
		}

		raw, err := base64.StdEncoding.DecodeString(a.PayloadB64)
		if err != nil || len(raw) == 0 {
			return nil, fmt.Errorf("attachment %d: payload_b64 is not valid base64", i)
		}
		if len(raw) > maxAttachmentBytes {
			return nil, fmt.Errorf("attachment %d: exceeds %d MB after compression", i, maxAttachmentBytes>>20)
		}
		if !checkMagic(mime, comp, raw) {
			return nil, fmt.Errorf("attachment %d: content does not match %s/%s", i, mime, comp)
		}

		var thumb *string
		if a.ThumbnailB64 != nil && *a.ThumbnailB64 != "" {
			if len(*a.ThumbnailB64) > maxThumbnailB64 {
				return nil, fmt.Errorf("attachment %d: thumbnail too large", i)
			}
			tb, err := base64.StdEncoding.DecodeString(*a.ThumbnailB64)
			if err != nil || !isImage(tb) {
				return nil, fmt.Errorf("attachment %d: thumbnail_b64 must be a base64 WebP/JPEG/PNG image", i)
			}
			thumb = a.ThumbnailB64
		}

		out = append(out, store.NewAttachment{
			FileName:        name,
			MimeType:        mime,
			CompressionType: comp,
			ThumbnailB64:    thumb,
			PayloadB64:      a.PayloadB64,
			CompressedSize:  len(raw),
		})
	}
	return out, nil
}

// sanitizeTelemetry checks the ring-buffer payload is a JSON object/array within size limits
// and strips NUL characters, which JSONB rejects (console.error output can contain them).
func sanitizeTelemetry(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	if len(raw) > maxTelemetryBytes {
		return nil, fmt.Errorf("telemetry exceeds %d KB", maxTelemetryBytes>>10)
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("telemetry is not valid JSON")
	}
	switch v.(type) {
	case map[string]any, []any:
	default:
		return nil, fmt.Errorf("telemetry must be a JSON object or array")
	}
	if !bytes.Contains(raw, []byte(`\u0000`)) {
		return raw, nil
	}
	return json.Marshal(stripNUL(v))
}

func stripNUL(v any) any {
	switch t := v.(type) {
	case string:
		return strings.ReplaceAll(t, "\x00", "")
	case []any:
		for i := range t {
			t[i] = stripNUL(t[i])
		}
	case map[string]any:
		for k, x := range t {
			nk := strings.ReplaceAll(k, "\x00", "")
			if nk != k {
				delete(t, k)
			}
			t[nk] = stripNUL(x)
		}
	}
	return v
}

var (
	reporterTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	emailRe         = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
)
