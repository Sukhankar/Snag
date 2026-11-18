package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ProjectRepo struct{ pool *pgxpool.Pool }

func NewProjectRepo(pool *pgxpool.Pool) *ProjectRepo { return &ProjectRepo{pool: pool} }

const projectCols = `id, name, project_key, allowed_origins, is_active, created_at,
	identity_enabled, identity_required, identity_rotated_at, identity_version`

func scanProject(row pgx.Row) (Project, error) {
	var p Project
	err := row.Scan(&p.ID, &p.Name, &p.ProjectKey, &p.AllowedOrigins, &p.IsActive, &p.CreatedAt,
		&p.IdentityEnabled, &p.IdentityRequired, &p.IdentityRotatedAt, &p.IdentityVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

func NewProjectKey() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return "pk_" + hex.EncodeToString(b)
}

// ListActive returns every active project; used to warm the origin-guard cache.
func (r *ProjectRepo) ListActive(ctx context.Context) ([]Project, error) {
	return r.list(ctx, `SELECT `+projectCols+` FROM projects WHERE is_active ORDER BY name`)
}

func (r *ProjectRepo) List(ctx context.Context) ([]Project, error) {
	return r.list(ctx, `SELECT `+projectCols+` FROM projects ORDER BY name`)
}

func (r *ProjectRepo) list(ctx context.Context, q string) ([]Project, error) {
	rows, err := r.pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (r *ProjectRepo) Create(ctx context.Context, name string, origins []string, key string) (Project, error) {
	if key == "" {
		key = NewProjectKey()
	}
	p, err := scanProject(r.pool.QueryRow(ctx,
		`INSERT INTO projects (name, project_key, allowed_origins) VALUES ($1, $2, $3)
		 RETURNING `+projectCols, name, key, origins))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return p, ErrConflict
	}
	return p, err
}

// EnsureByKey creates the project if no project has that key yet (used for the demo seed).
func (r *ProjectRepo) EnsureByKey(ctx context.Context, name, key string, origins []string) (Project, error) {
	p, err := scanProject(r.pool.QueryRow(ctx,
		`SELECT `+projectCols+` FROM projects WHERE project_key = $1`, key))
	if err == nil {
		return p, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return p, err
	}
	return r.Create(ctx, name, origins, key)
}

type ProjectPatch struct {
	Name           *string
	AllowedOrigins []string // nil → unchanged
	IsActive       *bool
	RotateKey      bool
	// IdentityRequired rejects anonymous reporters; only allowed while identity is enabled
	// (enforced by projects_identity_required_ck).
	IdentityRequired *bool
}

func (r *ProjectRepo) Update(ctx context.Context, id string, patch ProjectPatch) (Project, error) {
	var newKey *string
	if patch.RotateKey {
		k := NewProjectKey()
		newKey = &k
	}
	p, err := scanProject(r.pool.QueryRow(ctx, `
		UPDATE projects SET
			name            = COALESCE($2, name),
			allowed_origins = COALESCE($3, allowed_origins),
			is_active       = COALESCE($4, is_active),
			project_key     = COALESCE($5, project_key),
			identity_required = COALESCE($6, identity_required)
		WHERE id = $1
		RETURNING `+projectCols,
		id, patch.Name, patch.AllowedOrigins, patch.IsActive, newKey, patch.IdentityRequired))
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23514" { // identity_required without identity
		return p, ErrConflict
	}
	return p, err
}

// RotateIdentity enables signed reporter identities, or rotates them if already enabled.
// The version only ever increases, so every earlier secret stops working immediately.
func (r *ProjectRepo) RotateIdentity(ctx context.Context, id string) (Project, error) {
	return scanProject(r.pool.QueryRow(ctx, `
		UPDATE projects SET identity_enabled = TRUE, identity_version = identity_version + 1,
		                    identity_rotated_at = now()
		WHERE id = $1 RETURNING `+projectCols, id))
}

// DisableIdentity turns signed identities off (and with them identity_required).
func (r *ProjectRepo) DisableIdentity(ctx context.Context, id string) (Project, error) {
	return scanProject(r.pool.QueryRow(ctx, `
		UPDATE projects SET identity_enabled = FALSE, identity_required = FALSE,
		                    identity_version = identity_version + 1, identity_rotated_at = now()
		WHERE id = $1 RETURNING `+projectCols, id))
}

// ---- teams ----

const teamCols = `t.id, t.name, t.description,
	ARRAY(SELECT m.user_id::text FROM team_members m WHERE m.team_id = t.id ORDER BY m.added_at)`

func scanTeam(row pgx.Row) (Team, error) {
	var t Team
	err := row.Scan(&t.ID, &t.Name, &t.Description, &t.MemberIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	if t.MemberIDs == nil {
		t.MemberIDs = []string{}
	}
	return t, err
}

func (r *ProjectRepo) ListTeams(ctx context.Context) ([]Team, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+teamCols+` FROM teams t ORDER BY lower(t.name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Team{}
	for rows.Next() {
		t, err := scanTeam(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *ProjectRepo) GetTeam(ctx context.Context, id string) (Team, error) {
	return scanTeam(r.pool.QueryRow(ctx, `SELECT `+teamCols+` FROM teams t WHERE t.id = $1`, id))
}

// CreateTeam creates a team, optionally with its first members, in one transaction.
func (r *ProjectRepo) CreateTeam(ctx context.Context, name string, description *string, memberIDs []string) (Team, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Team{}, err
	}
	defer rollback(ctx, tx)
	var id string
	err = tx.QueryRow(ctx, `INSERT INTO teams (name, description) VALUES ($1, $2) RETURNING id`, name, description).Scan(&id)
	if isUnique(err) {
		return Team{}, ErrConflict
	}
	if err != nil {
		return Team{}, err
	}
	if err := setMembers(ctx, tx, id, memberIDs); err != nil {
		return Team{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Team{}, err
	}
	return r.GetTeam(ctx, id)
}

// UpdateTeam renames a team or changes its description (nil leaves a field unchanged).
func (r *ProjectRepo) UpdateTeam(ctx context.Context, id string, name, description *string) (Team, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE teams SET name = COALESCE($2, name), description = COALESCE($3, description)
		WHERE id = $1`, id, name, description)
	if isUnique(err) {
		return Team{}, ErrConflict
	}
	if err != nil {
		return Team{}, err
	}
	if tag.RowsAffected() == 0 {
		return Team{}, ErrNotFound
	}
	return r.GetTeam(ctx, id)
}

// SetTeamMembers replaces a team's member list.
func (r *ProjectRepo) SetTeamMembers(ctx context.Context, teamID string, userIDs []string) (Team, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return Team{}, err
	}
	defer rollback(ctx, tx)
	var one int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, teamID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
		return Team{}, ErrNotFound
	} else if err != nil {
		return Team{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM team_members WHERE team_id = $1 AND NOT (user_id = ANY($2::uuid[]))`, teamID, userIDs); err != nil {
		return Team{}, err
	}
	if err := setMembers(ctx, tx, teamID, userIDs); err != nil {
		return Team{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Team{}, err
	}
	return r.GetTeam(ctx, teamID)
}

// SetUserTeams replaces the set of teams a user belongs to.
func (r *ProjectRepo) SetUserTeams(ctx context.Context, userID string, teamIDs []string) ([]string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `DELETE FROM team_members WHERE user_id = $1 AND NOT (team_id = ANY($2::uuid[]))`, userID, teamIDs); err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO team_members (team_id, user_id) SELECT unnest($2::uuid[]), $1 ON CONFLICT DO NOTHING`, userID, teamIDs)
	if isForeignKey(err) {
		return nil, &ValidationError{"unknown team"}
	}
	if err != nil {
		return nil, err
	}
	var out []string
	if err := tx.QueryRow(ctx, `SELECT ARRAY(SELECT team_id::text FROM team_members WHERE user_id = $1 ORDER BY added_at)`, userID).Scan(&out); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func setMembers(ctx context.Context, tx pgx.Tx, teamID string, userIDs []string) error {
	if len(userIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO team_members (team_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, teamID, userIDs)
	if isForeignKey(err) {
		return &ValidationError{"unknown user"}
	}
	return err
}

func isForeignKey(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

// DeleteTeam removes a team; its tickets become unassigned to any team (ON DELETE SET NULL).
func (r *ProjectRepo) DeleteTeam(ctx context.Context, id string) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM teams WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
