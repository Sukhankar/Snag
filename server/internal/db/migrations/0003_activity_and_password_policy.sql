-- Ticket activity log and the "change your temporary password" policy.
--
-- ticket_events: one row per triage change (status, priority, category, scope, team, assignee,
-- duplicate link). Values are stored as display text captured at the time of the change, so
-- the history stays readable after a team is renamed or a user is deactivated.

CREATE TABLE ticket_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    actor       VARCHAR(150),
    field       VARCHAR(30) NOT NULL
                CHECK (field IN ('status', 'priority', 'category', 'scope_class', 'team', 'assignee', 'parent')),
    old_value   TEXT,
    new_value   TEXT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);

-- Accounts created by an admin (or given a password by one) must choose their own password
-- before they can use anything else.
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
