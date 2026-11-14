package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type User struct {
	ID          string     `json:"id"`
	Email       string     `json:"email"`
	Name        string     `json:"name"`
	RoleID      string     `json:"role_id"`
	RoleName    string     `json:"role_name"`
	IsOwner     bool       `json:"is_owner"`
	IsActive    bool       `json:"is_active"`
	Permissions []string   `json:"permissions"` // the role's permissions (owner: overridden to all by the API)
	LastLoginAt *time.Time `json:"last_login_at"`
	CreatedAt   time.Time  `json:"created_at"`
	// MustChangePassword is set when an admin chose the password (new account or reset).
	MustChangePassword bool `json:"must_change_password"`
}

type Role struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description *string   `json:"description"`
	Permissions []string  `json:"permissions"`
	IsSystem    bool      `json:"is_system"`
	UserCount   int       `json:"user_count"`
	CreatedAt   time.Time `json:"created_at"`
}

type DirectoryEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type UserRepo struct{ pool *pgxpool.Pool }

func NewUserRepo(pool *pgxpool.Pool) *UserRepo { return &UserRepo{pool: pool} }

const userCols = `u.id, u.email, u.name, u.role_id, r.name, u.is_owner, u.is_active, r.permissions, u.last_login_at, u.created_at, u.must_change_password`

func scanUser(row pgx.Row, extra ...any) (User, error) {
	var u User
	err := row.Scan(append([]any{&u.ID, &u.Email, &u.Name, &u.RoleID, &u.RoleName, &u.IsOwner, &u.IsActive,
		&u.Permissions, &u.LastLoginAt, &u.CreatedAt, &u.MustChangePassword}, extra...)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, ErrNotFound
	}
	return u, err
}

func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// ---- users ----

func (r *UserRepo) OwnerExists(ctx context.Context) (bool, error) {
	var ok bool
	err := r.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE is_owner)`).Scan(&ok)
	return ok, err
}

// CreateUser adds an account. mustChange forces a password change at first sign-in (used when
// an admin picked the temporary password).
func (r *UserRepo) CreateUser(ctx context.Context, email, name, hash, roleID string, owner, mustChange bool) (User, error) {
	var id string
	err := r.pool.QueryRow(ctx, `
		INSERT INTO users (email, name, password_hash, role_id, is_owner, must_change_password)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		strings.TrimSpace(email), name, hash, roleID, owner, mustChange).Scan(&id)
	if isUnique(err) {
		return User{}, ErrConflict
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return User{}, &ValidationError{"role not found"}
	}
	if err != nil {
		return User{}, err
	}
	return r.GetUser(ctx, id)
}

// CreateOwner creates the ultimate user with the system Owner role.
func (r *UserRepo) CreateOwner(ctx context.Context, email, name, hash string) (User, error) {
	var roleID string
	if err := r.pool.QueryRow(ctx, `SELECT id FROM roles WHERE name = 'Owner' AND is_system`).Scan(&roleID); err != nil {
		return User{}, err
	}
	return r.CreateUser(ctx, email, name, hash, roleID, true, false)
}

func (r *UserRepo) GetUser(ctx context.Context, id string) (User, error) {
	return scanUser(r.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, id))
}

// UserForLogin returns the user and password hash by (case-insensitive) email.
func (r *UserRepo) UserForLogin(ctx context.Context, email string) (User, string, error) {
	var hash string
	u, err := scanUser(r.pool.QueryRow(ctx,
		`SELECT `+userCols+`, u.password_hash FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.email) = lower($1)`,
		strings.TrimSpace(email)), &hash)
	return u, hash, err
}

func (r *UserRepo) PasswordHash(ctx context.Context, id string) (string, error) {
	var h string
	err := r.pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, id).Scan(&h)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return h, err
}

func (r *UserRepo) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+userCols+` FROM users u JOIN roles r ON r.id = u.role_id
		ORDER BY u.is_owner DESC, u.is_active DESC, lower(u.name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (r *UserRepo) Directory(ctx context.Context) ([]DirectoryEntry, error) {
	rows, err := r.pool.Query(ctx, `SELECT id, name FROM users WHERE is_active ORDER BY lower(name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DirectoryEntry{}
	for rows.Next() {
		var d DirectoryEntry
		if err := rows.Scan(&d.ID, &d.Name); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

type UserPatch struct {
	Name         *string
	Email        *string
	RoleID       *string
	IsActive     *bool
	PasswordHash *string
	// MustChange sets or clears the forced password change flag.
	MustChange *bool
}

// UpdateUser applies the patch. Deactivation or a password change revokes all of the user's
// sessions in the same transaction (except keepSession, used for "change my own password").
func (r *UserRepo) UpdateUser(ctx context.Context, id string, p UserPatch, keepSession []byte) (User, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer rollback(ctx, tx)
	tag, err := tx.Exec(ctx, `
		UPDATE users SET
			name          = COALESCE($2, name),
			email         = COALESCE($3, email),
			role_id       = COALESCE($4, role_id),
			is_active     = COALESCE($5, is_active),
			password_hash = COALESCE($6, password_hash),
			must_change_password = COALESCE($7, must_change_password)
		WHERE id = $1`, id, p.Name, p.Email, p.RoleID, p.IsActive, p.PasswordHash, p.MustChange)
	if isUnique(err) {
		return User{}, ErrConflict
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return User{}, &ValidationError{"role not found"}
	}
	if err != nil {
		return User{}, err
	}
	if tag.RowsAffected() == 0 {
		return User{}, ErrNotFound
	}
	if (p.IsActive != nil && !*p.IsActive) || p.PasswordHash != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2`, id, keepSession); err != nil {
			return User{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, err
	}
	return r.GetUser(ctx, id)
}

// ---- sessions ----

func (r *UserRepo) CreateSession(ctx context.Context, userID string, digest []byte, ttl time.Duration, ip, ua string) (time.Time, error) {
	exp := time.Now().Add(ttl)
	if len(ua) > 300 {
		ua = ua[:300]
	}
	_, err := r.pool.Exec(ctx, `
		WITH gc AS (DELETE FROM sessions WHERE expires_at < now())
		INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
		digest, userID, exp, ip, ua)
	if err != nil {
		return exp, err
	}
	_, err = r.pool.Exec(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1`, userID)
	return exp, err
}

// SessionUser resolves a token digest to its active user, refreshing last_seen_at at most
// once a minute.
func (r *UserRepo) SessionUser(ctx context.Context, digest []byte) (User, error) {
	var lastSeen time.Time
	u, err := scanUser(r.pool.QueryRow(ctx, `
		SELECT `+userCols+`, s.last_seen_at
		FROM sessions s
		JOIN users u ON u.id = s.user_id AND u.is_active
		JOIN roles r ON r.id = u.role_id
		WHERE s.token_hash = $1 AND s.expires_at > now()`, digest), &lastSeen)
	if err != nil {
		return u, err
	}
	if time.Since(lastSeen) > time.Minute {
		_, _ = r.pool.Exec(ctx, `UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, digest)
	}
	return u, nil
}

func (r *UserRepo) DeleteSession(ctx context.Context, digest []byte) error {
	_, err := r.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, digest)
	return err
}

// ---- roles ----

const roleCols = `r.id, r.name, r.description, r.permissions, r.is_system, r.created_at,
	(SELECT count(*) FROM users u WHERE u.role_id = r.id)::int`

func scanRole(row pgx.Row) (Role, error) {
	var x Role
	err := row.Scan(&x.ID, &x.Name, &x.Description, &x.Permissions, &x.IsSystem, &x.CreatedAt, &x.UserCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ErrNotFound
	}
	return x, err
}

func (r *UserRepo) ListRoles(ctx context.Context) ([]Role, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+roleCols+` FROM roles r ORDER BY r.is_system DESC, cardinality(r.permissions) DESC, r.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Role{}
	for rows.Next() {
		x, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (r *UserRepo) GetRole(ctx context.Context, id string) (Role, error) {
	return scanRole(r.pool.QueryRow(ctx, `SELECT `+roleCols+` FROM roles r WHERE r.id = $1`, id))
}

func (r *UserRepo) CreateRole(ctx context.Context, name string, desc *string, perms []string) (Role, error) {
	var id string
	err := r.pool.QueryRow(ctx, `INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3) RETURNING id`,
		name, desc, perms).Scan(&id)
	if isUnique(err) {
		return Role{}, ErrConflict
	}
	if err != nil {
		return Role{}, err
	}
	return r.GetRole(ctx, id)
}

func (r *UserRepo) UpdateRole(ctx context.Context, id string, name *string, desc *string, perms []string) (Role, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE roles SET name = COALESCE($2, name), description = COALESCE($3, description),
		                 permissions = COALESCE($4, permissions)
		WHERE id = $1 AND NOT is_system`, id, name, desc, perms)
	if isUnique(err) {
		return Role{}, ErrConflict
	}
	if err != nil {
		return Role{}, err
	}
	if tag.RowsAffected() == 0 {
		return Role{}, ErrNotFound
	}
	return r.GetRole(ctx, id)
}

// DeleteRole removes an unused, non-system role.
func (r *UserRepo) DeleteRole(ctx context.Context, id string) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM roles WHERE id = $1 AND NOT is_system`, id)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return ErrConflict // still assigned to users
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
