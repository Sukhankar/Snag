package auth

import (
	"bytes"
	"strings"
	"testing"
)

func TestPasswordPolicy(t *testing.T) {
	for _, tc := range []struct {
		pw    string
		valid bool
	}{{"", false}, {"123456789", false}, {"1234567890", true}, {strings.Repeat("界", 10), true}, {strings.Repeat("x", 256), true}, {strings.Repeat("x", 257), false}} {
		if (ValidatePassword(tc.pw) == nil) != tc.valid {
			t.Errorf("unexpected validity for %d bytes", len(tc.pw))
		}
	}
}
func TestPasswordHashAndMalformedInput(t *testing.T) {
	h, err := HashPassword("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword("correct horse battery", h) || VerifyPassword("wrong", h) {
		t.Fatal("password verification")
	}
	for _, bad := range []string{"", "garbage", strings.Replace(h, "v=19", "v=99", 1), strings.Replace(h, "t=2", "t=0", 1), strings.Replace(h, "p=2", "p=0", 1)} {
		if VerifyPassword("correct horse battery", bad) {
			t.Error("accepted malformed hash")
		}
	}
}
func TestSessionTokens(t *testing.T) {
	a, d, err := NewSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _, _ := NewSessionToken()
	if a == b || len(a) != 43 || !bytes.Equal(d, TokenDigest(a)) || len(d) != 32 {
		t.Fatal("invalid session token")
	}
}
