package httpapi

import (
	"context"
	"encoding/base64"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOriginBoundaries(t *testing.T) {
	for _, tc := range []struct {
		rule, origin string
		want         bool
	}{{"https://*.example.com", "https://a.example.com", true}, {"https://*.example.com", "https://example.com", false}, {"https://*.example.com", "https://evil-example.com", false}, {"https://*.example.com", "http://a.example.com", false}, {"https://example.com:443", "https://example.com", true}} {
		r, ok := parseOriginRule(tc.rule)
		if !ok || r.matches(tc.origin) != tc.want {
			t.Errorf("%+v", tc)
		}
	}
	for _, s := range []string{"*", "https://*.com", "file:///tmp", "null"} {
		if _, ok := parseOriginRule(s); ok {
			t.Errorf("accepted %s", s)
		}
	}
}
func TestJSONBoundaries(t *testing.T) {
	for _, tc := range []struct {
		body   string
		max    int64
		status int
	}{{`{"x":1}`, 100, 200}, {`{"x":1} {}`, 100, 400}, {`{`, 100, 400}, {`{"x":"long"}`, 4, 413}} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
		var v map[string]any
		decodeJSON(w, r, tc.max, &v)
		if w.Code != tc.status {
			t.Errorf("%s: %d", tc.body, w.Code)
		}
	}
}
func TestAttachmentBoundaries(t *testing.T) {
	for _, tc := range []struct {
		mime, comp, payload string
		ok                  bool
	}{{"text/plain", "none", "hello", true}, {"text/plain", "none", "a\x00b", false}, {"text/plain", "none", "\xff", false}, {"image/svg+xml", "none", "<svg/>", false}, {"image/webp", "none", "fake", false}, {"application/pdf", "none", "%PDF-1.7", true}, {"application/pdf", "gzip", "%PDF", false}} {
		_, err := validateAttachments([]attachmentIn{{FileName: "test", MimeType: tc.mime, CompressionType: tc.comp, PayloadB64: base64.StdEncoding.EncodeToString([]byte(tc.payload))}})
		if (err == nil) != tc.ok {
			t.Errorf("%+v: %v", tc, err)
		}
	}
	if _, err := validateAttachments(make([]attachmentIn, 11)); err == nil {
		t.Fatal("accepted 11 attachments")
	}
}
func TestRateBuckets(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l := NewLimiter(ctx, 1, 2)
	if !l.Allow("a") || !l.Allow("a") || l.Allow("a") || !l.Allow("b") {
		t.Fatal("bucket isolation/burst")
	}
}
