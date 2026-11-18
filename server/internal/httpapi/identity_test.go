package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/snag/server/internal/config"
	"github.com/snag/server/internal/store"
)

const testMaster = "test-master-key-0123456789abcdefghijklmnop"

func testProject(enabled bool, version int) *cachedProject {
	return &cachedProject{Project: store.Project{
		ID: "7f6c2a52-0000-4000-8000-000000000001", ProjectKey: "pk_test",
		IdentityEnabled: enabled, IdentityVersion: version,
	}}
}

func TestVerifyIdentity(t *testing.T) {
	s := &Server{cfg: config.Config{IdentityKey: testMaster}}
	p := testProject(true, 1)
	secret, _ := s.identitySecret(p)
	now := time.Unix(1_800_000_000, 0)
	exp := now.Add(12 * time.Hour).Unix()
	good := signIdentity(secret, p.ProjectKey, "cashier-42", exp)

	if uid, _, code := s.verifyIdentity(p, good, now); code != "" || uid != "cashier-42" {
		t.Fatalf("valid token rejected: %q %q", uid, code)
	}

	parts := strings.Split(good, ".")
	other := signIdentity(secret, p.ProjectKey, "cashier-43", exp)
	cases := map[string]string{
		"tampered user id (signature from another user)": "v1." + strings.Split(other, ".")[1] + "." + parts[2] + "." + parts[3],
		"tampered expiry":            parts[0] + "." + parts[1] + "." + strconv.FormatInt(exp+3600, 10) + "." + parts[3],
		"wrong secret":               signIdentity("sis_wrong", p.ProjectKey, "cashier-42", exp),
		"other project's key in MAC": signIdentity(secret, "pk_other", "cashier-42", exp),
		"rotated (old version)":      signIdentity(deriveIdentitySecret(testMaster, p.ID, 0), p.ProjectKey, "cashier-42", exp),
		"too far in the future":      signIdentity(secret, p.ProjectKey, "cashier-42", now.Add(30*24*time.Hour).Unix()),
		"wrong version prefix":       "v2" + strings.TrimPrefix(good, "v1"),
		"extra segment":              good + ".x",
		"not base64":                 "v1.***." + parts[2] + "." + parts[3],
		"negative expiry":            "v1." + parts[1] + ".-5." + parts[3],
		"empty user id":              signIdentity(secret, p.ProjectKey, "", exp),
		"control char in user id":    signIdentity(secret, p.ProjectKey, "a\nb", exp),
		"oversized":                  "v1." + strings.Repeat("A", 600) + "." + parts[2] + "." + parts[3],
	}
	for name, tok := range cases {
		if _, _, code := s.verifyIdentity(p, tok, now); code != "identity_invalid" {
			t.Errorf("%s: got %q, want identity_invalid", name, code)
		}
	}
	if _, _, code := s.verifyIdentity(p, signIdentity(secret, p.ProjectKey, "cashier-42", now.Add(-time.Hour).Unix()), now); code != "identity_expired" {
		t.Errorf("expired token: got %q", code)
	}
	if _, _, code := s.verifyIdentity(testProject(false, 1), good, now); code != "identity_not_enabled" {
		t.Errorf("disabled project: got %q", code)
	}
	if _, _, code := (&Server{}).verifyIdentity(p, good, now); code != "identity_not_enabled" {
		t.Errorf("no master key: got %q", code)
	}
}

func TestSecretsDifferPerProjectAndVersion(t *testing.T) {
	a := deriveIdentitySecret(testMaster, "p1", 1)
	if a == deriveIdentitySecret(testMaster, "p2", 1) || a == deriveIdentitySecret(testMaster, "p1", 2) ||
		a == deriveIdentitySecret(testMaster+"x", "p1", 1) {
		t.Fatal("identity secrets must differ per project, version and master key")
	}
}

func TestReporterKeysCannotCollide(t *testing.T) {
	u := userReporterKey("p1", "cashier-42")
	if reporterTokenRe.MatchString(u) {
		t.Fatal("a stored user key must never be accepted as an anonymous token")
	}
	if anonReporterKey("abcdefghijklmnop") == anonReporterKey("abcdefghijklmnoq") || u == userReporterKey("p2", "cashier-42") {
		t.Fatal("reporter keys must be distinct")
	}
	if len(u) > 64 || len(anonReporterKey(strings.Repeat("a", 64))) > 64 {
		t.Fatal("reporter key must fit tickets.reporter_token VARCHAR(64)")
	}
}

func TestReporterFromRequiresIdentity(t *testing.T) {
	s := &Server{cfg: config.Config{IdentityKey: testMaster}}
	p := testProject(true, 3)
	p.IdentityRequired = true
	r := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(withProject(p))
	r.Header.Set("X-Reporter-Token", "abcdefghijklmnopqrstuv")
	w := httptest.NewRecorder()
	if _, ok := s.reporterFrom(w, r); ok || w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous reporter accepted on an identity-required project: %d", w.Code)
	}
	// A bad signed token never falls back to the anonymous token sent alongside it.
	p.IdentityRequired = false
	r.Header.Set("X-Reporter-Identity", "v1.x.1.y")
	w = httptest.NewRecorder()
	if _, ok := s.reporterFrom(w, r); ok || w.Code != http.StatusUnauthorized {
		t.Fatalf("invalid identity fell back to anonymous: %d", w.Code)
	}
}

func TestStreamTicketsSingleUseAndBound(t *testing.T) {
	st := &streamTickets{m: map[string]streamTicket{}}
	id, ok := st.issue("p1", reporter{key: "a.k"})
	if !ok {
		t.Fatal("issue failed")
	}
	if _, ok := st.take(id, "p2"); ok {
		t.Fatal("ticket accepted for another project")
	}
	id, _ = st.issue("p1", reporter{key: "a.k"})
	if rep, ok := st.take(id, "p1"); !ok || rep.key != "a.k" {
		t.Fatal("valid ticket rejected")
	}
	if _, ok := st.take(id, "p1"); ok {
		t.Fatal("ticket reused")
	}
	id, _ = st.issue("p1", reporter{key: "a.k"})
	st.m[id] = streamTicket{projectID: "p1", until: time.Now().Add(-time.Second)}
	if _, ok := st.take(id, "p1"); ok {
		t.Fatal("expired ticket accepted")
	}
}

func withProject(p *cachedProject) context.Context {
	return context.WithValue(context.Background(), projectCtxKey, p)
}
