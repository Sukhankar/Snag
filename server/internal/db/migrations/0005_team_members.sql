-- Team membership: a user can belong to any number of teams, a team has any number of users.
-- Removing a team or a user removes the membership rows, never the user or the team.

CREATE TABLE team_members (
    team_id  UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members (user_id);

-- Team names are unique regardless of case, so "Billing" and "billing" cannot both exist.
-- Older installs may already contain duplicates: rename them before adding the index.
WITH ranked AS (
    SELECT id, name, row_number() OVER (PARTITION BY lower(name) ORDER BY id) AS n FROM teams
)
UPDATE teams t SET name = left(r.name, 90) || ' (' || r.n || ')'
  FROM ranked r WHERE t.id = r.id AND r.n > 1;
CREATE UNIQUE INDEX teams_name_key ON teams (lower(name));
