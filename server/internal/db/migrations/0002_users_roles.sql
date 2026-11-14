-- Users, roles and sessions for the operations dashboard (RBAC).
--
-- * roles.permissions holds keys from the catalog in internal/auth/permissions.go.
-- * Exactly one user can be the owner (the "ultimate user"): full access regardless of role,
--   cannot be deactivated, and can only be edited by themselves.
-- * sessions store a SHA-256 of the bearer token, never the token itself.

CREATE TABLE roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(60) NOT NULL UNIQUE,
    description TEXT,
    permissions TEXT[] NOT NULL DEFAULT '{}',
    is_system   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR(254) NOT NULL,
    name          VARCHAR(100) NOT NULL,
    password_hash TEXT NOT NULL,
    role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    is_owner      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (NOT is_owner OR is_active)
);
CREATE UNIQUE INDEX users_email_key   ON users (lower(email));
CREATE UNIQUE INDEX users_single_owner ON users (is_owner) WHERE is_owner;

CREATE TRIGGER users_touch_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE sessions (
    token_hash   BYTEA PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    ip           TEXT,
    user_agent   TEXT
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- tickets.assignee_id now points at a real user.
UPDATE tickets SET assignee_id = NULL WHERE assignee_id IS NOT NULL;
ALTER TABLE tickets
    ADD CONSTRAINT tickets_assignee_fk FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX tickets_assignee_idx ON tickets (assignee_id) WHERE assignee_id IS NOT NULL;

-- Default roles. Only "Owner" is a locked system role; the others are starting points the
-- owner can edit or delete.
INSERT INTO roles (name, description, permissions, is_system) VALUES
('Owner', 'Full access to everything. Reserved for the ultimate user.',
 ARRAY['tickets.view','tickets.update','tickets.assign','tickets.classify','tickets.link','tickets.reply','tickets.note','tickets.broadcast',
       'projects.view','projects.manage','teams.manage','users.manage','roles.manage'], TRUE),
('Admin', 'Manages people, projects and all tickets.',
 ARRAY['tickets.view','tickets.update','tickets.assign','tickets.classify','tickets.link','tickets.reply','tickets.note','tickets.broadcast',
       'projects.view','projects.manage','teams.manage','users.manage','roles.manage'], FALSE),
('Developer', 'Triages and fixes tickets, writes internal notes.',
 ARRAY['tickets.view','tickets.update','tickets.assign','tickets.classify','tickets.link','tickets.reply','tickets.note','tickets.broadcast',
       'projects.view'], FALSE),
('Support Agent', 'Talks to clients and moves tickets along.',
 ARRAY['tickets.view','tickets.update','tickets.assign','tickets.reply','tickets.note','projects.view'], FALSE),
('Viewer', 'Read-only access to tickets.',
 ARRAY['tickets.view','projects.view'], FALSE);
