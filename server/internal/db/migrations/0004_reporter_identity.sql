-- Signed reporter identities and one-way reporter keys.
--
-- * projects.identity_*: a project can accept reporter tokens signed by the host application's
--   server. The secret itself is never stored: it is derived from SNAG_IDENTITY_KEY (server
--   environment) plus the project id and identity_version. Rotating bumps the version, which
--   instantly invalidates the old secret; the counter never goes back, so disabling and
--   re-enabling can never revive an old secret.
-- * tickets.reporter_token now holds a one-way reporter KEY instead of the browser's credential:
--   "a.<b64url sha256(anonymous token)>" or "u.<b64url sha256(project, user id)>".
--   A copy of the database therefore contains nothing that can be replayed against the widget API.

ALTER TABLE projects
    ADD COLUMN identity_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN identity_version    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN identity_required   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN identity_rotated_at TIMESTAMPTZ,
    ADD CONSTRAINT projects_identity_required_ck CHECK (identity_enabled OR NOT identity_required);

-- Existing rows hold raw anonymous tokens ([A-Za-z0-9_-], never a '.'); hash them in place.
UPDATE tickets
   SET reporter_token = 'a.' || rtrim(translate(encode(sha256(convert_to(reporter_token, 'UTF8')), 'base64'), '+/', '-_'), '=')
 WHERE reporter_token IS NOT NULL
   AND position('.' IN reporter_token) = 0;
