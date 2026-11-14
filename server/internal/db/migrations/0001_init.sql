-- Snag — initial schema.
-- Follows the blueprint, with these deliberate hardening changes:
--   * TIMESTAMPTZ instead of TIMESTAMP (keyset cursors must be timezone-unambiguous)
--   * tickets.project_id is NOT NULL (a ticket without a tenant is unroutable)
--   * tickets.reporter_token: an anonymous, widget-generated secret that scopes "My Tickets"
--     (looking up by reporter_email would let anyone enumerate another person's tickets)
--   * tickets.scope_class: AMC classification (bug = warranty/AMC, change_request = billable)
--   * ticket_code is generated server-side from a sequence
--   * CHECK constraints on the enum-like columns; priority default is 'P2_Normal'

CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    project_key     VARCHAR(64)  UNIQUE NOT NULL,
    allowed_origins TEXT[]       NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE teams (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    description TEXT
);

CREATE SEQUENCE ticket_code_seq START 1001;

CREATE TABLE tickets (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_code      VARCHAR(32) UNIQUE NOT NULL DEFAULT ('SNAG-' || nextval('ticket_code_seq')),
    project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    team_id          UUID REFERENCES teams(id) ON DELETE SET NULL,
    assignee_id      UUID NULL,
    parent_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
    reporter_name    VARCHAR(150),
    reporter_email   VARCHAR(150),
    reporter_token   VARCHAR(64),
    title            VARCHAR(255) NOT NULL,
    description      TEXT,
    category         VARCHAR(50) NOT NULL DEFAULT 'bug'
                     CHECK (category IN ('bug', 'feature', 'query', 'amc_request')),
    priority         VARCHAR(20) NOT NULL DEFAULT 'P2_Normal'
                     CHECK (priority IN ('P0_Critical', 'P1_High', 'P2_Normal', 'P3_Low')),
    status           VARCHAR(30) NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'triaged', 'in_progress', 'resolved', 'closed')),
    scope_class      VARCHAR(20) NOT NULL DEFAULT 'unclassified'
                     CHECK (scope_class IN ('unclassified', 'bug', 'change_request')),
    app_version      VARCHAR(50),
    telemetry_json   JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (parent_ticket_id IS NULL OR parent_ticket_id <> id)
);

-- Keyset pagination: WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC
CREATE INDEX tickets_inbox_idx         ON tickets (created_at DESC, id DESC);
CREATE INDEX tickets_project_inbox_idx ON tickets (project_id, created_at DESC, id DESC);
CREATE INDEX tickets_status_inbox_idx  ON tickets (status, created_at DESC, id DESC);
CREATE INDEX tickets_parent_idx        ON tickets (parent_ticket_id) WHERE parent_ticket_id IS NOT NULL;
CREATE INDEX tickets_reporter_idx      ON tickets (project_id, reporter_token, created_at DESC)
                                       WHERE reporter_token IS NOT NULL;
CREATE INDEX tickets_telemetry_gin     ON tickets USING GIN (telemetry_json jsonb_path_ops);

CREATE TABLE ticket_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_type VARCHAR(20) NOT NULL CHECK (author_type IN ('client', 'developer', 'system')),
    author_id   VARCHAR(100),
    body        TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE,
    -- clock_timestamp(), not now(): rows inserted in one transaction keep their order.
    created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ticket_messages_thread_idx ON ticket_messages (ticket_id, created_at, id);

CREATE TABLE ticket_attachments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id        UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    message_id       UUID REFERENCES ticket_messages(id) ON DELETE CASCADE,
    file_name        VARCHAR(255) NOT NULL,
    mime_type        VARCHAR(100) NOT NULL,
    compression_type VARCHAR(50) NOT NULL DEFAULT 'webp_canvas',
    thumbnail_b64    TEXT,
    payload_b64      TEXT NOT NULL,
    compressed_size  INT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ticket_attachments_ticket_idx  ON ticket_attachments (ticket_id);
CREATE INDEX ticket_attachments_message_idx ON ticket_attachments (message_id);

-- TOAST tuning: the full payload always goes out-of-line (EXTENDED), so list and metadata
-- queries never detoast it. Thumbnails prefer inline storage (MAIN): reading them skips a
-- TOAST fetch.
ALTER TABLE ticket_attachments ALTER COLUMN payload_b64   SET STORAGE EXTENDED;
ALTER TABLE ticket_attachments ALTER COLUMN thumbnail_b64 SET STORAGE MAIN;
DO $$
BEGIN
    ALTER TABLE ticket_attachments ALTER COLUMN payload_b64 SET COMPRESSION lz4;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'lz4 TOAST compression unavailable, keeping pglz';
END $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_touch_updated_at
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
