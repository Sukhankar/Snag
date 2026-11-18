package httpapi

// Reporter identity.
//
// A widget request proves who the reporter is in one of two ways:
//
//   - Anonymous: X-Reporter-Token, a random value the widget generates and keeps in the
//     browser (16–64 URL-safe characters). It scopes "My tickets" to that browser.
//   - Signed: X-Reporter-Identity, minted by the host application's SERVER for its signed-in
//     user. It follows the user to any browser or device:
//
//     v1.<base64url(user id)>.<expires, unix seconds>.<base64url(HMAC-SHA256(secret, message))>
//     message = "snag-identity-v1\n" + project key + "\n" + user id + "\n" + expires
//
// The project's identity secret is derived from SNAG_IDENTITY_KEY (server environment) and
// the project's id and identity version; it is shown once to an administrator and never
// stored. Neither credential is stored either: tickets keep a one-way reporter KEY,
//
//	"a." + base64url(SHA-256(anonymous token))
//	"u." + base64url(SHA-256("snag-user\x00" + project id + "\x00" + user id))
//
// so a copy of the database contains nothing that can be replayed against the widget API.
// An anonymous token can never contain '.', so it can never collide with or be presented as
// a signed user's key.

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	identityMessagePrefix = "snag-identity-v1\n"
	identityMaxTTL        = 7 * 24 * time.Hour // longest validity a host app may mint
	identityClockSkew     = 2 * time.Minute
	identityMaxLen        = 512
	identityMaxUserID     = 128
)

var b64 = base64.RawURLEncoding

// identitySecret returns the project's current identity secret, if the feature is enabled.
func (s *Server) identitySecret(p *cachedProject) (string, bool) {
	if s.cfg.IdentityKey == "" || !p.IdentityEnabled {
		return "", false
	}
	return deriveIdentitySecret(s.cfg.IdentityKey, p.ID, p.IdentityVersion), true
}

func deriveIdentitySecret(masterKey, projectID string, version int) string {
	mac := hmac.New(sha256.New, []byte(masterKey))
	mac.Write([]byte("snag/project-identity-secret/v1\x00" + projectID + "\x00" + strconv.Itoa(version)))
	return "sis_" + b64.EncodeToString(mac.Sum(nil))
}

// signIdentity mints a token exactly as a host application must (used by tests and docs).
func signIdentity(secret, projectKey, userID string, expires int64) string {
	exp := strconv.FormatInt(expires, 10)
	return "v1." + b64.EncodeToString([]byte(userID)) + "." + exp + "." +
		b64.EncodeToString(identityMAC(secret, projectKey, userID, exp))
}

func identityMAC(secret, projectKey, userID, expires string) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(identityMessagePrefix + projectKey + "\n" + userID + "\n" + expires))
	return mac.Sum(nil)
}

func validUserID(id string) bool {
	if id == "" || len(id) > identityMaxUserID || !utf8.ValidString(id) {
		return false
	}
	for _, r := range id {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func allDigits(s string) bool {
	if s == "" || len(s) > 12 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// verifyIdentity checks a signed token. The signature is checked (in constant time) before
// anything about the contents is reported, so unauthenticated callers learn nothing.
// It returns the user id and expiry, or an error code for the response.
func (s *Server) verifyIdentity(p *cachedProject, tok string, now time.Time) (string, time.Time, string) {
	secret, ok := s.identitySecret(p)
	if !ok {
		return "", time.Time{}, "identity_not_enabled"
	}
	if len(tok) > identityMaxLen {
		return "", time.Time{}, "identity_invalid"
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 4 || parts[0] != "v1" || !allDigits(parts[2]) {
		return "", time.Time{}, "identity_invalid"
	}
	uid, err1 := b64.DecodeString(parts[1])
	sig, err2 := b64.DecodeString(parts[3])
	if err1 != nil || err2 != nil || len(sig) != sha256.Size || !validUserID(string(uid)) {
		return "", time.Time{}, "identity_invalid"
	}
	if !hmac.Equal(sig, identityMAC(secret, p.ProjectKey, string(uid), parts[2])) {
		return "", time.Time{}, "identity_invalid"
	}
	expUnix, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		return "", time.Time{}, "identity_invalid"
	}
	exp := time.Unix(expUnix, 0)
	switch {
	case now.After(exp.Add(identityClockSkew)):
		return "", time.Time{}, "identity_expired"
	case exp.After(now.Add(identityMaxTTL + identityClockSkew)):
		return "", time.Time{}, "identity_invalid" // refuses effectively permanent tokens
	}
	return string(uid), exp, ""
}

func anonReporterKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "a." + b64.EncodeToString(sum[:])
}

func userReporterKey(projectID, userID string) string {
	sum := sha256.Sum256([]byte("snag-user\x00" + projectID + "\x00" + userID))
	return "u." + b64.EncodeToString(sum[:])
}

// reporter is the resolved identity of a widget request.
type reporter struct {
	key     string    // one-way key stored on tickets and used for realtime topics
	signed  bool      // came from a verified X-Reporter-Identity
	expires time.Time // signed only: when the presented token stops being valid
}

var identityMessages = map[string]string{
	"identity_invalid":     "X-Reporter-Identity is not a valid signed reporter token for this project",
	"identity_expired":     "the signed reporter token has expired; the host application must issue a new one",
	"identity_not_enabled": "signed reporter tokens are not enabled for this project",
	"identity_required":    "this project only accepts signed-in reporters",
}

// reporterFrom resolves the request's reporter, writing the error response on failure.
// A request that presents a signed identity never falls back to anonymous mode.
func (s *Server) reporterFrom(w http.ResponseWriter, r *http.Request) (reporter, bool) {
	p := projectFrom(r)
	if tok := r.Header.Get("X-Reporter-Identity"); tok != "" {
		uid, exp, code := s.verifyIdentity(p, tok, time.Now())
		if code != "" {
			writeErr(w, http.StatusUnauthorized, code, identityMessages[code])
			return reporter{}, false
		}
		return reporter{key: userReporterKey(p.ID, uid), signed: true, expires: exp}, true
	}
	if p.IdentityRequired {
		writeErr(w, http.StatusUnauthorized, "identity_required", identityMessages["identity_required"])
		return reporter{}, false
	}
	t := r.Header.Get("X-Reporter-Token")
	if !reporterTokenRe.MatchString(t) {
		writeErr(w, http.StatusBadRequest, "reporter_token_required", "X-Reporter-Token must be 16-64 URL-safe characters")
		return reporter{}, false
	}
	return reporter{key: anonReporterKey(t)}, true
}

// ---- stream tickets ----
//
// EventSource cannot send headers, and credentials in URLs end up in proxy access logs.
// So the widget first exchanges its headers for a stream ticket (POST, headers only), then
// opens the stream with ?ticket=. A ticket is random, single-use, bound to one project and
// valid for streamTicketTTL; a logged URL therefore holds nothing reusable.

const (
	streamTicketTTL = 60 * time.Second
	streamTicketMax = 100_000
)

type streamTicket struct {
	projectID string
	rep       reporter
	until     time.Time
}

type streamTickets struct {
	mu sync.Mutex
	m  map[string]streamTicket
}

func newStreamTickets(ctx context.Context) *streamTickets {
	st := &streamTickets{m: map[string]streamTicket{}}
	go func() {
		t := time.NewTicker(streamTicketTTL)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				st.mu.Lock()
				for k, v := range st.m {
					if now.After(v.until) {
						delete(st.m, k)
					}
				}
				st.mu.Unlock()
			}
		}
	}()
	return st
}

func (st *streamTickets) issue(projectID string, rep reporter) (string, bool) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", false
	}
	id := b64.EncodeToString(b)
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.m) >= streamTicketMax {
		return "", false
	}
	st.m[id] = streamTicket{projectID: projectID, rep: rep, until: time.Now().Add(streamTicketTTL)}
	return id, true
}

// take consumes a ticket. It succeeds once, before expiry, for the project it was issued to.
func (st *streamTickets) take(id, projectID string) (reporter, bool) {
	if len(id) != 43 {
		return reporter{}, false
	}
	st.mu.Lock()
	t, ok := st.m[id]
	delete(st.m, id)
	st.mu.Unlock()
	if !ok || time.Now().After(t.until) || t.projectID != projectID {
		return reporter{}, false
	}
	return t.rep, true
}
