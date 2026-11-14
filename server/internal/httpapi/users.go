package httpapi

import (
	"net/http"
	"strings"

	"github.com/snag/server/internal/auth"
	"github.com/snag/server/internal/store"
)

// Rules enforced here (the dashboard mirrors them, but this is the authority):
//  1. The owner can only be edited by the owner, and can never be deactivated or re-roled.
//  2. You can only manage users whose role permissions you fully hold yourself.
//  3. You can only assign roles / grant permissions that you hold yourself.
//  4. You cannot deactivate yourself.
//  5. The system "Owner" role cannot be edited, deleted or assigned.

func validName(s string, max int) (string, bool) {
	s = clean(s)
	return s, s != "" && runeLen(s) <= max
}

// GET /api/v1/admin/users
func (s *Server) adminListUsers(w http.ResponseWriter, r *http.Request) {
	us, err := s.users.ListUsers(r.Context())
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": us})
}

// GET /api/v1/admin/users/directory — active users for assignee pickers.
func (s *Server) adminUserDirectory(w http.ResponseWriter, r *http.Request) {
	d, err := s.users.Directory(r.Context())
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": d})
}

// assignableRole loads a role and checks the caller may give it to someone.
func (s *Server) assignableRole(w http.ResponseWriter, r *http.Request, roleID string) bool {
	if !isUUID(roleID) {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "role_id is required")
		return false
	}
	role, err := s.users.GetRole(r.Context(), roleID)
	if err != nil {
		writeStoreErr(w, r, err)
		return false
	}
	if role.IsSystem {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "the Owner role cannot be assigned")
		return false
	}
	if !me(r).canGrant(role.Permissions) {
		writeErr(w, http.StatusForbidden, "forbidden", "you cannot assign a role with permissions you don't have")
		return false
	}
	return true
}

// POST /api/v1/admin/users {name, email, role_id, password}
func (s *Server) adminCreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		RoleID   string `json:"role_id"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, 16<<10, &req) {
		return
	}
	name, ok := validName(req.Name, 100)
	if !ok {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "name is required (max 100 characters)")
		return
	}
	email := strings.ToLower(clean(req.Email))
	if !emailRe.MatchString(email) || len(email) > 254 {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "a valid email is required")
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	if !s.assignableRole(w, r, req.RoleID) {
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	u, err := s.users.CreateUser(r.Context(), email, name, hash, req.RoleID, false)
	if err == store.ErrConflict {
		writeErr(w, http.StatusConflict, "conflict", "a user with this email already exists")
		return
	}
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

// PATCH /api/v1/admin/users/{id} {name?, email?, role_id?, is_active?, password?}
func (s *Server) adminPatchUser(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		Name     *string `json:"name"`
		Email    *string `json:"email"`
		RoleID   *string `json:"role_id"`
		IsActive *bool   `json:"is_active"`
		Password *string `json:"password"`
	}
	if !decodeJSON(w, r, 16<<10, &req) {
		return
	}
	caller := me(r)
	target, err := s.users.GetUser(r.Context(), id)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	switch {
	case target.IsOwner && !caller.Owner && !caller.Service:
		writeErr(w, http.StatusForbidden, "forbidden", "only the owner can change the owner account")
		return
	case target.IsOwner && (req.RoleID != nil || (req.IsActive != nil && !*req.IsActive)):
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "the owner always has full access and cannot be deactivated")
		return
	case !target.IsOwner && !caller.canGrant(target.Permissions):
		writeErr(w, http.StatusForbidden, "forbidden", "this user has permissions you don't have")
		return
	case target.ID == caller.ID && req.IsActive != nil && !*req.IsActive:
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "you cannot deactivate your own account")
		return
	}

	patch := store.UserPatch{IsActive: req.IsActive}
	if req.Name != nil {
		n, ok := validName(*req.Name, 100)
		if !ok {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid name")
			return
		}
		patch.Name = &n
	}
	if req.Email != nil {
		e := strings.ToLower(clean(*req.Email))
		if !emailRe.MatchString(e) {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid email")
			return
		}
		patch.Email = &e
	}
	if req.RoleID != nil {
		if !s.assignableRole(w, r, *req.RoleID) {
			return
		}
		patch.RoleID = req.RoleID
	}
	if req.Password != nil {
		if err := auth.ValidatePassword(*req.Password); err != nil {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
			return
		}
		h, err := auth.HashPassword(*req.Password)
		if err != nil {
			writeStoreErr(w, r, err)
			return
		}
		patch.PasswordHash = &h
	}
	var keep []byte
	if target.ID == caller.ID {
		keep = auth.TokenDigest(bearer(r)) // resetting your own password keeps this session
	}
	u, err := s.users.UpdateUser(r.Context(), id, patch, keep)
	if err == store.ErrConflict {
		writeErr(w, http.StatusConflict, "conflict", "a user with this email already exists")
		return
	}
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// ---- roles ----

func (s *Server) adminListRoles(w http.ResponseWriter, r *http.Request) {
	rs, err := s.users.ListRoles(r.Context())
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rs})
}

type roleReq struct {
	Name        *string  `json:"name"`
	Description *string  `json:"description"`
	Permissions []string `json:"permissions"`
}

func (s *Server) validRolePerms(w http.ResponseWriter, r *http.Request, perms []string) ([]string, bool) {
	seen := map[string]bool{}
	out := []string{}
	for _, k := range perms {
		if !auth.Valid(k) {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "unknown permission "+k)
			return nil, false
		}
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	if !me(r).canGrant(out) {
		writeErr(w, http.StatusForbidden, "forbidden", "you cannot grant permissions you don't have")
		return nil, false
	}
	return out, true
}

func (s *Server) adminCreateRole(w http.ResponseWriter, r *http.Request) {
	var req roleReq
	if !decodeJSON(w, r, 16<<10, &req) {
		return
	}
	if req.Name == nil {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "name is required")
		return
	}
	name, ok := validName(*req.Name, 60)
	if !ok {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "name is required (max 60 characters)")
		return
	}
	perms, ok := s.validRolePerms(w, r, req.Permissions)
	if !ok {
		return
	}
	role, err := s.users.CreateRole(r.Context(), name, optional(deref(req.Description), 500), perms)
	if err == store.ErrConflict {
		writeErr(w, http.StatusConflict, "conflict", "a role with this name already exists")
		return
	}
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, role)
}

func (s *Server) adminPatchRole(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	var req roleReq
	if !decodeJSON(w, r, 16<<10, &req) {
		return
	}
	current, err := s.users.GetRole(r.Context(), id)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if current.IsSystem {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "the Owner role cannot be changed")
		return
	}
	if !me(r).canGrant(current.Permissions) {
		writeErr(w, http.StatusForbidden, "forbidden", "this role has permissions you don't have")
		return
	}
	var name *string
	if req.Name != nil {
		n, ok := validName(*req.Name, 60)
		if !ok {
			writeErr(w, http.StatusUnprocessableEntity, "validation_failed", "invalid name")
			return
		}
		name = &n
	}
	var perms []string
	if req.Permissions != nil {
		if perms, ok = s.validRolePerms(w, r, req.Permissions); !ok {
			return
		}
	}
	role, err := s.users.UpdateRole(r.Context(), id, name, req.Description, perms)
	if err == store.ErrConflict {
		writeErr(w, http.StatusConflict, "conflict", "a role with this name already exists")
		return
	}
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, role)
}

func (s *Server) adminDeleteRole(w http.ResponseWriter, r *http.Request) {
	id, ok := uuidParam(w, r, "id")
	if !ok {
		return
	}
	current, err := s.users.GetRole(r.Context(), id)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	if current.IsSystem || !me(r).canGrant(current.Permissions) {
		writeErr(w, http.StatusForbidden, "forbidden", "you cannot delete this role")
		return
	}
	if err := s.users.DeleteRole(r.Context(), id); err == store.ErrConflict {
		writeErr(w, http.StatusConflict, "conflict", "move its users to another role first")
		return
	} else if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
