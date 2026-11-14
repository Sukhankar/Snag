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

const projectCols = `id, name, project_key, allowed_origins, is_active, created_at`

func scanProject(row pgx.Row) (Project, error) {
	var p Project
	err := row.Scan(&p.ID, &p.Name, &p.ProjectKey, &p.AllowedOrigins, &p.IsActive, &p.CreatedAt)
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
}

func (r *ProjectRepo) Update(ctx context.Context, id string, patch ProjectPatch) (Project, error) {
	var newKey *string
	if patch.RotateKey {
		k := NewProjectKey()
		newKey = &k
	}
	return scanProject(r.pool.QueryRow(ctx, `
		UPDATE projects SET
			name            = COALESCE($2, name),
			allowed_origins = COALESCE($3, allowed_origins),
			is_active       = COALESCE($4, is_active),
			project_key     = COALESCE($5, project_key)
		WHERE id = $1
		RETURNING `+projectCols,
		id, patch.Name, patch.AllowedOrigins, patch.IsActive, newKey))
}

// ---- teams ----

func (r *ProjectRepo) ListTeams(ctx context.Context) ([]Team, error) {
	rows, err := r.pool.Query(ctx, `SELECT id, name, description FROM teams ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Team{}
	for rows.Next() {
		var t Team
		if err := rows.Scan(&t.ID, &t.Name, &t.Description); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *ProjectRepo) CreateTeam(ctx context.Context, name string, description *string) (Team, error) {
	var t Team
	err := r.pool.QueryRow(ctx,
		`INSERT INTO teams (name, description) VALUES ($1, $2) RETURNING id, name, description`,
		name, description).Scan(&t.ID, &t.Name, &t.Description)
	return t, err
}

// UpdateTeam renames a team or changes its description (nil leaves a field unchanged).
func (r *ProjectRepo) UpdateTeam(ctx context.Context, id string, name, description *string) (Team, error) {
	var t Team
	err := r.pool.QueryRow(ctx, `
		UPDATE teams SET name = COALESCE($2, name), description = COALESCE($3, description)
		WHERE id = $1 RETURNING id, name, description`, id, name, description).Scan(&t.ID, &t.Name, &t.Description)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
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
