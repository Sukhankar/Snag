#!/usr/bin/env bash
# Users / roles / permissions test against a running Snag server.
#   OWNER_EMAIL=... OWNER_PASSWORD=... ./scripts/rbac.sh
# Creates throwaway users and roles named "rbac-<random>".
set -uo pipefail

URL=${SNAG_URL:-http://localhost:8080}
OWNER_EMAIL=${OWNER_EMAIL:-owner@example.com}
OWNER_PASSWORD=${OWNER_PASSWORD:-change-me-now-please}
RUN=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
PW=Passw0rd-$RUN
TMP=Temp0rary-$RUN

pass=0 fail=0
ok()  { echo "  ✓ $1"; pass=$((pass+1)); }
bad() { echo "  ✗ $1"; fail=$((fail+1)); }
expect() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (expected $3, got $2)"; }

# api TOKEN METHOD PATH [JSON] → prints body, last line = status
api() { curl -s -w '\n%{http_code}' -X "$2" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' ${4:+-d "$4"} "$URL$3"; }
code() { api "$@" | tail -1; }
body() { api "$@" | sed '$d'; }
login() { curl -s -X POST -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}" "$URL/api/v1/auth/login" | jq -r '.token // empty'; }

echo "== owner sign-in"
expect "wrong password → 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"nope\"}" "$URL/api/v1/auth/login")" 401
OWNER=$(login "$OWNER_EMAIL" "$OWNER_PASSWORD")
[[ -n "$OWNER" ]] && ok "owner signs in" || { bad "owner sign-in failed"; exit 1; }
expect "owner has every permission" "$(body "$OWNER" GET /api/v1/admin/me | jq '.permissions|length')" 13
expect "no token → 401" "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/v1/admin/tickets")" 401

role_id() { body "$OWNER" GET /api/v1/admin/roles | jq -r --arg n "$1" '.items[]|select(.name==$n)|.id'; }
OWNER_ROLE=$(role_id Owner); ADMIN_ROLE=$(role_id Admin); DEV_ROLE=$(role_id Developer); VIEWER_ROLE=$(role_id Viewer)

echo "== owner creates roles and users"
LEAD=$(body "$OWNER" POST /api/v1/admin/roles "{\"name\":\"rbac-lead-$RUN\",\"permissions\":[\"tickets.view\",\"projects.view\",\"users.manage\"]}" | jq -r .id)
[[ "$LEAD" =~ ^[0-9a-f-]{36}$ ]] && ok "custom role created" || bad "custom role create"
expect "unknown permission rejected" "$(code "$OWNER" POST /api/v1/admin/roles "{\"name\":\"rbac-x-$RUN\",\"permissions\":[\"tickets.fly\"]}")" 422
mk() { body "$OWNER" POST /api/v1/admin/users "{\"name\":\"$1 $RUN\",\"email\":\"$1-$RUN@example.com\",\"role_id\":\"$2\",\"password\":\"$TMP\"}" | jq -r .id; }
# A new user signs in with the temporary password and must replace it before anything else.
activate() { local t; t=$(login "$1" "$TMP"); code "$t" POST /api/v1/admin/me/password "{\"current_password\":\"$TMP\",\"new_password\":\"$PW\"}" >/dev/null; echo "$t"; }
ADMIN_ID=$(mk admin "$ADMIN_ROLE"); DEV_ID=$(mk dev "$DEV_ROLE"); VIEW_ID=$(mk viewer "$VIEWER_ROLE"); LEAD_ID=$(mk lead "$LEAD")
expect "duplicate email → 409" "$(code "$OWNER" POST /api/v1/admin/users "{\"name\":\"x\",\"email\":\"DEV-$RUN@example.com\",\"role_id\":\"$DEV_ROLE\",\"password\":\"$PW\"}")" 409
expect "short password → 422" "$(code "$OWNER" POST /api/v1/admin/users "{\"name\":\"x\",\"email\":\"short-$RUN@example.com\",\"role_id\":\"$DEV_ROLE\",\"password\":\"abc\"}")" 422
expect "Owner role not assignable → 422" "$(code "$OWNER" POST /api/v1/admin/users "{\"name\":\"x\",\"email\":\"o2-$RUN@example.com\",\"role_id\":\"$OWNER_ROLE\",\"password\":\"$PW\"}")" 422
echo "== temporary passwords"
FRESH=$(login "viewer-$RUN@example.com" "$TMP")
[[ -n "$FRESH" ]] && ok "new user signs in with the temporary password" || bad "temporary password sign-in"
expect "flagged must_change_password" "$(body "$FRESH" GET /api/v1/admin/me | jq -r .must_change_password)" true
expect "everything else blocked until changed" "$(code "$FRESH" GET /api/v1/admin/tickets)" 403
expect "reason is password_change_required" "$(body "$FRESH" GET /api/v1/admin/tickets | jq -r .error)" password_change_required
expect "new password must differ" "$(code "$FRESH" POST /api/v1/admin/me/password "{\"current_password\":\"$TMP\",\"new_password\":\"$TMP\"}")" 422
expect "user picks own password" "$(code "$FRESH" POST /api/v1/admin/me/password "{\"current_password\":\"$TMP\",\"new_password\":\"$PW\"}")" 204
expect "same session now unlocked" "$(code "$FRESH" GET /api/v1/admin/tickets)" 200
ADMIN=$(activate "admin-$RUN@example.com"); DEV=$(activate "DEV-$RUN@example.com"); LEAD_T=$(activate "lead-$RUN@example.com")
ADMIN=$(login "admin-$RUN@example.com" "$PW"); DEV=$(login "DEV-$RUN@example.com" "$PW"); VIEW=$(login "viewer-$RUN@example.com" "$PW"); LEAD_T=$(login "lead-$RUN@example.com" "$PW")
[[ -n "$ADMIN" && -n "$DEV" && -n "$VIEW" && -n "$LEAD_T" ]] && ok "new users sign in (email case-insensitive)" || bad "new users sign in"

# a ticket to work on, with an internal note
TID=$(body "$OWNER" GET '/api/v1/admin/tickets?limit=1' | jq -r '.items[0].id')
code "$OWNER" POST "/api/v1/admin/tickets/$TID/messages" "{\"body\":\"rbac-secret-$RUN\",\"is_internal\":true}" >/dev/null

echo "== viewer (read-only)"
expect "can list tickets" "$(code "$VIEW" GET /api/v1/admin/tickets)" 200
expect "cannot change status" "$(code "$VIEW" PATCH "/api/v1/admin/tickets/$TID" '{"status":"triaged"}')" 403
expect "cannot reply" "$(code "$VIEW" POST "/api/v1/admin/tickets/$TID/messages" '{"body":"hi","is_internal":false}')" 403
expect "cannot see users" "$(code "$VIEW" GET /api/v1/admin/users)" 403
expect "cannot manage projects" "$(code "$VIEW" POST /api/v1/admin/projects '{"name":"x","allowed_origins":["https://x.example.com"]}')" 403
body "$VIEW" GET "/api/v1/admin/tickets/$TID" | grep -q "rbac-secret-$RUN" && bad "viewer sees internal notes" || ok "internal notes hidden from viewer"

echo "== developer"
expect "can change status" "$(code "$DEV" PATCH "/api/v1/admin/tickets/$TID" '{"status":"in_progress"}')" 200
expect "can classify AMC scope" "$(code "$DEV" PATCH "/api/v1/admin/tickets/$TID" '{"scope_class":"bug"}')" 200
expect "can assign to a user" "$(code "$DEV" PATCH "/api/v1/admin/tickets/$TID" "{\"assignee_id\":\"$DEV_ID\"}")" 200
expect "assignee shown on ticket" "$(body "$DEV" GET "/api/v1/admin/tickets/$TID" | jq -r .assignee_id)" "$DEV_ID"
expect "unknown assignee → 422" "$(code "$DEV" PATCH "/api/v1/admin/tickets/$TID" '{"assignee_id":"00000000-0000-0000-0000-000000000000"}')" 422
body "$DEV" GET "/api/v1/admin/tickets/$TID" | grep -q "rbac-secret-$RUN" && ok "developer sees internal notes" || bad "developer missing internal notes"
expect "cannot manage users" "$(code "$DEV" POST /api/v1/admin/users "{\"name\":\"x\",\"email\":\"x-$RUN@example.com\",\"role_id\":\"$VIEWER_ROLE\",\"password\":\"$PW\"}")" 403
expect "cannot edit roles" "$(code "$DEV" PATCH "/api/v1/admin/roles/$VIEWER_ROLE" '{"permissions":["tickets.view"]}')" 403

echo "== no privilege escalation (lead = view tickets/projects + manage users)"
expect "lead can create a Viewer" "$(code "$LEAD_T" POST /api/v1/admin/users "{\"name\":\"v2\",\"email\":\"v2-$RUN@example.com\",\"role_id\":\"$VIEWER_ROLE\",\"password\":\"$PW\"}")" 201
expect "lead cannot create an Admin" "$(code "$LEAD_T" POST /api/v1/admin/users "{\"name\":\"a2\",\"email\":\"a2-$RUN@example.com\",\"role_id\":\"$ADMIN_ROLE\",\"password\":\"$PW\"}")" 403
expect "lead cannot promote self" "$(code "$LEAD_T" PATCH "/api/v1/admin/users/$LEAD_ID" "{\"role_id\":\"$ADMIN_ROLE\"}")" 403
expect "lead cannot edit a Developer" "$(code "$LEAD_T" PATCH "/api/v1/admin/users/$DEV_ID" '{"is_active":false}')" 403
expect "admin cannot edit the owner" "$(code "$ADMIN" PATCH "/api/v1/admin/users/$(body "$OWNER" GET /api/v1/admin/me | jq -r .id)" '{"name":"pwned"}')" 403
expect "owner cannot deactivate self" "$(code "$OWNER" PATCH "/api/v1/admin/users/$(body "$OWNER" GET /api/v1/admin/me | jq -r .id)" '{"is_active":false}')" 422
expect "Owner role is locked" "$(code "$OWNER" PATCH "/api/v1/admin/roles/$OWNER_ROLE" '{"permissions":[]}')" 422
expect "role in use cannot be deleted" "$(code "$OWNER" DELETE "/api/v1/admin/roles/$LEAD")" 409

echo "== permission changes apply immediately"
code "$OWNER" PATCH "/api/v1/admin/roles/$LEAD" '{"permissions":["tickets.view"]}' >/dev/null
expect "lead lost users.manage on next request" "$(code "$LEAD_T" GET /api/v1/admin/users)" 403

echo "== sessions"
expect "deactivate viewer" "$(code "$OWNER" PATCH "/api/v1/admin/users/$VIEW_ID" '{"is_active":false}')" 200
expect "deactivated user's token revoked" "$(code "$VIEW" GET /api/v1/admin/tickets)" 401
[[ -z "$(login "viewer-$RUN@example.com" "$PW")" ]] && ok "deactivated user cannot sign in" || bad "deactivated user signed in"
expect "owner resets dev password" "$(code "$OWNER" PATCH "/api/v1/admin/users/$DEV_ID" "{\"password\":\"New-$PW\"}")" 200
expect "dev's old session revoked" "$(code "$DEV" GET /api/v1/admin/tickets)" 401
DEV=$(login "dev-$RUN@example.com" "New-$PW"); [[ -n "$DEV" ]] && ok "dev signs in with new password" || bad "dev new password"
expect "admin-reset password is temporary" "$(code "$DEV" GET /api/v1/admin/tickets)" 403
expect "change own password: wrong current → 422" "$(code "$DEV" POST /api/v1/admin/me/password "{\"current_password\":\"x\",\"new_password\":\"Another-$PW\"}")" 422
expect "change own password" "$(code "$DEV" POST /api/v1/admin/me/password "{\"current_password\":\"New-$PW\",\"new_password\":\"Another-$PW\"}")" 204
expect "current session survives own change" "$(code "$DEV" GET /api/v1/admin/tickets)" 200
curl -s -o /dev/null -X POST -H "Authorization: Bearer $DEV" "$URL/api/v1/auth/logout"
expect "logout revokes token" "$(code "$DEV" GET /api/v1/admin/tickets)" 401

echo "== activity log, filters, teams, reports"
DEV2=$(login "dev-$RUN@example.com" "Another-$PW")
expect "dev changes the status" "$(code "$DEV2" PATCH "/api/v1/admin/tickets/$TID" '{"status":"triaged"}')" 200
EV=$(body "$OWNER" GET "/api/v1/admin/tickets/$TID" | jq -c '[.events[] | select(.field=="status")] | last')
expect "status change logged" "$(jq -r '.new_value' <<<"$EV")" triaged
expect "logged with the actor's name" "$(jq -r '.actor' <<<"$EV")" "dev $RUN"
expect "assignee change logged by name" "$(body "$OWNER" GET "/api/v1/admin/tickets/$TID" | jq -r '[.events[] | select(.field=="assignee")] | last | .new_value')" "dev $RUN"
expect "assignee_id=me finds the ticket" "$(body "$DEV2" GET '/api/v1/admin/tickets?assignee_id=me&limit=200' | jq --arg t "$TID" '[.items[].id] | index($t) != null')" true
expect "assignee_id=none excludes it" "$(body "$DEV2" GET '/api/v1/admin/tickets?assignee_id=none&limit=200' | jq --arg t "$TID" '[.items[].id] | index($t) != null')" false
expect "bad assignee filter → 400" "$(code "$DEV2" GET '/api/v1/admin/tickets?assignee_id=bob')" 400
TEAM=$(body "$OWNER" POST /api/v1/admin/teams "{\"name\":\"rbac-team-$RUN\"}" | jq -r .id)
code "$OWNER" PATCH "/api/v1/admin/tickets/$TID" "{\"team_id\":\"$TEAM\"}" >/dev/null
expect "developer cannot rename teams" "$(code "$DEV2" PATCH "/api/v1/admin/teams/$TEAM" '{"name":"x"}')" 403
expect "owner renames team" "$(body "$OWNER" PATCH "/api/v1/admin/teams/$TEAM" "{\"name\":\"rbac-team2-$RUN\"}" | jq -r .name)" "rbac-team2-$RUN"
expect "owner deletes team" "$(code "$OWNER" DELETE "/api/v1/admin/teams/$TEAM")" 204
expect "ticket keeps existing without the team" "$(body "$OWNER" GET "/api/v1/admin/tickets/$TID" | jq -r .team_id)" null
expect "AMC report available to ticket viewers" "$(body "$DEV2" GET "/api/v1/admin/reports/amc?from=$(date -u -d "-1 year" +%F)&to=$(date -u +%F)" | jq '.items | length > 0')" true
expect "report rejects bad dates" "$(code "$DEV2" GET '/api/v1/admin/reports/amc?from=yesterday')" 400

echo "== brute-force protection"
got429=0
for _ in $(seq 1 8); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"email\":\"admin-$RUN@example.com\",\"password\":\"wrong\"}" "$URL/api/v1/auth/login")" == 429 ]] && { got429=1; break; }
done
expect "repeated failures on one account → 429" "$got429" 1

echo
echo "passed: $pass  failed: $fail"
[[ $fail -eq 0 ]]
