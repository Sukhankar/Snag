package config

import "testing"

func TestConfigValidation(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://test")
	t.Setenv("SNAG_ADMIN_TOKEN", "")
	t.Setenv("SNAG_CREATE_PER_MINUTE", "")
	t.Setenv("SNAG_MAX_TICKET_MB", "")
	if c, e := Load(); e != nil || c.CreatePerMinute != 10 || c.MaxTicketBytes != 20<<20 {
		t.Fatal(c, e)
	}
	for _, tc := range []struct{ k, v string }{{"DATABASE_URL", ""}, {"SNAG_ADMIN_TOKEN", "short"}, {"SNAG_CREATE_PER_MINUTE", "0"}, {"SNAG_CREATE_PER_MINUTE", "bad"}, {"SNAG_MAX_TICKET_MB", "201"}} {
		t.Run(tc.k+tc.v, func(t *testing.T) {
			t.Setenv(tc.k, tc.v)
			if _, e := Load(); e == nil {
				t.Fatal("accepted invalid configuration")
			}
		})
	}
}
