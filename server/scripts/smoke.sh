#!/usr/bin/env bash
# End-to-end smoke test against a running Snag server.
#   SNAG_URL=http://localhost:8080 ADMIN_TOKEN=... PROJECT_KEY=... ORIGIN=http://localhost:5173 ./scripts/smoke.sh
# Requires: curl, jq, gzip, base64.
set -uo pipefail

URL=${SNAG_URL:-http://localhost:8080}
ADMIN=${ADMIN_TOKEN:?Set ADMIN_TOKEN to the configured SNAG_ADMIN_TOKEN}
KEY=${PROJECT_KEY:-pk_demo_0000000000000000000000000000}
ORIGIN=${ORIGIN:-http://localhost:5173}
TOKEN="smoke_$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"

pass=0 fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }
expect() { [[ "$2" == "$3" ]] && ok "$1" || bad "$1 (expected $3, got $2)"; }

W=(-H "Origin: $ORIGIN" -H "X-Project-Key: $KEY" -H "X-Reporter-Token: $TOKEN" -H "Content-Type: application/json")
A=(-H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -H "X-Snag-Actor: smoke-test")
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== health"
expect "healthz" "$(code "$URL/healthz")" 200

echo "== origin guard"
expect "missing key → 401"          "$(code -X POST -H "Origin: $ORIGIN" "$URL/api/v1/widget/tickets")" 401
expect "unknown key → 403"          "$(code -X POST -H "Origin: $ORIGIN" -H 'X-Project-Key: pk_nope' "$URL/api/v1/widget/tickets")" 403
expect "foreign origin → 403"       "$(code -X POST -H 'Origin: https://evil.example' -H "X-Project-Key: $KEY" "$URL/api/v1/widget/tickets")" 403
expect "no origin/referer → 403"    "$(code -X POST -H "X-Project-Key: $KEY" "$URL/api/v1/widget/tickets")" 403
expect "referer fallback accepted"  "$(code -H "Referer: $ORIGIN/some/page" -H "X-Project-Key: $KEY" -H "X-Reporter-Token: $TOKEN" "$URL/api/v1/widget/tickets")" 200
expect "preflight allowed → 204"    "$(code -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' "$URL/api/v1/widget/tickets")" 204
expect "preflight foreign → 403"    "$(code -X OPTIONS -H 'Origin: https://evil.example' "$URL/api/v1/widget/tickets")" 403
acao=$(curl -s -D - -o /dev/null "${W[@]}" "$URL/api/v1/widget/tickets" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
expect "ACAO echoes origin"         "$acao" "$ORIGIN"
expect "admin without token → 401"  "$(code "$URL/api/v1/admin/tickets")" 401

echo "== ticket ingestion (atomic)"
# Minimal byte sequences that satisfy the server's magic-number checks.
WEBP=$(printf 'RIFF\x24\x00\x00\x00WEBPVP8 \x18\x00\x00\x00' | base64 -w0)
LOG=$(printf 'line1 error\nline2 stack\n' | gzip -c | base64 -w0)
body=$(jq -n --arg webp "$WEBP" --arg log "$LOG" '{
  title: "Checkout button freezes", description: "Clicking Pay does nothing.",
  category: "bug", priority: "P1_High", reporter_name: "Smoke", reporter_email: "smoke@example.com",
  app_version: "2.4.1",
  telemetry: {events: [{t: 1, type: "console.error", msg: "bad\u0000null"}, {t: 2, type: "fetch", status: 500, url: "/api/pay"}]},
  attachments: [
    {file_name: "shot.webp", mime_type: "image/webp", compression_type: "webp_canvas", thumbnail_b64: $webp, payload_b64: $webp},
    {file_name: "app.log",   mime_type: "text/plain", compression_type: "gzip", payload_b64: $log}
  ]}')
res=$(curl -s -w '\n%{http_code}' -X POST "${W[@]}" -d "$body" "$URL/api/v1/widget/tickets")
expect "create → 201" "$(tail -1 <<<"$res")" 201
CODE1=$(head -1 <<<"$res" | jq -r .ticket_code)
[[ "$CODE1" == SNAG-* ]] && ok "ticket_code $CODE1" || bad "ticket_code missing"

bad_att=$(jq -n '{title:"x", attachments:[{file_name:"a.webp", mime_type:"image/webp", compression_type:"webp_canvas", payload_b64:"aGVsbG8="}]}')
expect "spoofed image → 422" "$(code -X POST "${W[@]}" -d "$bad_att" "$URL/api/v1/widget/tickets")" 422
expect "svg rejected → 422"  "$(code -X POST "${W[@]}" -d '{"title":"x","attachments":[{"file_name":"a.svg","mime_type":"image/svg+xml","compression_type":"none","payload_b64":"PHN2Zy8+"}]}' "$URL/api/v1/widget/tickets")" 422
expect "missing title → 422" "$(code -X POST "${W[@]}" -d '{"title":"  "}' "$URL/api/v1/widget/tickets")" 422
expect "no reporter token → 400" "$(code -X POST -H "Origin: $ORIGIN" -H "X-Project-Key: $KEY" -d '{"title":"x"}' "$URL/api/v1/widget/tickets")" 400

echo "== admin inbox (keyset pagination)"
for i in 1 2 3; do curl -s -o /dev/null -X POST "${W[@]}" -d "{\"title\":\"Paging $i\"}" "$URL/api/v1/widget/tickets"; done
p1=$(curl -s "${A[@]}" "$URL/api/v1/admin/tickets?limit=2")
expect "page 1 size" "$(jq '.items|length' <<<"$p1")" 2
cur=$(jq -r .next_cursor <<<"$p1")
p2=$(curl -s "${A[@]}" "$URL/api/v1/admin/tickets?limit=2&cursor=$cur")
overlap=$(jq -n --argjson a "$p1" --argjson b "$p2" '[$a.items[].id] - ([$a.items[].id] - [$b.items[].id]) | length')
expect "page 2 has no overlap" "$overlap" 0
expect "newest first" "$(jq -r '.items[0].title' <<<"$p1")" "Paging 3"
expect "bad cursor → 400" "$(code "${A[@]}" "$URL/api/v1/admin/tickets?cursor=zzz")" 400

ID1=$(curl -s "${A[@]}" "$URL/api/v1/admin/tickets?q=$CODE1" | jq -r '.items[0].id')
det=$(curl -s "${A[@]}" "$URL/api/v1/admin/tickets/$ID1")
expect "detail: 2 attachments" "$(jq '.attachments|length' <<<"$det")" 2
expect "detail: no payload in metadata" "$(jq '[.attachments[]|has("payload_b64")]|any' <<<"$det")" false
expect "telemetry NUL stripped" "$(jq -r '.telemetry.events[0].msg' <<<"$det")" "badnull"
ATT=$(jq -r '.attachments[0].id' <<<"$det")
expect "attachment payload fetch" "$(curl -s "${A[@]}" "$URL/api/v1/admin/attachments/$ATT" | jq -r .payload_b64)" "$WEBP"

echo "== SSE + internal-note isolation"
SSE_OUT=$(mktemp)
curl -sN -H "Origin: $ORIGIN" "$URL/api/v1/widget/stream?key=$KEY&token=$TOKEN" >"$SSE_OUT" &
SSE_PID=$!
ADMIN_SSE=$(mktemp)
curl -sN "${A[@]}" "$URL/api/v1/admin/stream" >"$ADMIN_SSE" &
ADMIN_PID=$!
sleep 0.5
expect "internal note → 201" "$(code -X POST "${A[@]}" -d '{"body":"SECRET: root cause is the cache","is_internal":true}' "$URL/api/v1/admin/tickets/$ID1/messages")" 201
expect "public reply → 201"  "$(code -X POST "${A[@]}" -d '{"body":"We are on it.","is_internal":false}' "$URL/api/v1/admin/tickets/$ID1/messages")" 201
sleep 0.5
kill $SSE_PID $ADMIN_PID 2>/dev/null; wait $SSE_PID $ADMIN_PID 2>/dev/null
grep -q 'We are on it.' "$SSE_OUT" && ok "widget stream got public reply" || bad "widget stream missing public reply"
grep -q 'SECRET' "$SSE_OUT" && bad "widget stream LEAKED internal note" || ok "widget stream has no internal note"
grep -q 'SECRET' "$ADMIN_SSE" && ok "admin stream got internal note" || bad "admin stream missing internal note"
wdet=$(curl -s "${W[@]}" "$URL/api/v1/widget/tickets/$CODE1")
grep -q 'SECRET' <<<"$wdet" && bad "widget detail LEAKED internal note" || ok "widget detail has no internal note"
expect "widget sees public thread" "$(jq '.messages|length' <<<"$wdet")" 2
expect "public reply auto-triaged" "$(jq -r .status <<<"$wdet")" triaged
expect "other reporter can't read" "$(code -H "Origin: $ORIGIN" -H "X-Project-Key: $KEY" -H 'X-Reporter-Token: someone_else_token_123' "$URL/api/v1/widget/tickets/$CODE1")" 404
rm -f "$SSE_OUT" "$ADMIN_SSE"

echo "== duplicate linking + cascade resolution"
CODE2=$(curl -s -X POST "${W[@]}" -d '{"title":"Pay button broken (dup)"}' "$URL/api/v1/widget/tickets" | jq -r .ticket_code)
ID2=$(curl -s "${A[@]}" "$URL/api/v1/admin/tickets?q=$CODE2" | jq -r '.items[0].id')
expect "self-link → 422" "$(code -X PATCH "${A[@]}" -d "{\"parent_ticket_id\":\"$ID1\"}" "$URL/api/v1/admin/tickets/$ID1")" 422
expect "link dup → 200" "$(code -X PATCH "${A[@]}" -d "{\"parent_ticket_id\":\"$ID1\",\"scope_class\":\"bug\"}" "$URL/api/v1/admin/tickets/$ID2")" 200
expect "cycle (parent→child) → 422" "$(code -X PATCH "${A[@]}" -d "{\"parent_ticket_id\":\"$ID2\"}" "$URL/api/v1/admin/tickets/$ID1")" 422
expect "parent duplicate_count" "$(curl -s "${A[@]}" "$URL/api/v1/admin/tickets/$ID1" | jq .duplicate_count)" 1
expect "resolve parent → 200" "$(code -X PATCH "${A[@]}" -d '{"status":"resolved"}' "$URL/api/v1/admin/tickets/$ID1")" 200
d2=$(curl -s "${W[@]}" "$URL/api/v1/widget/tickets/$CODE2")
expect "duplicate cascaded to resolved" "$(jq -r .status <<<"$d2")" resolved
jq -e '.messages[]|select(.author_type=="system")|.body|test("resolved")' <<<"$d2" >/dev/null && ok "duplicate reporter notified" || bad "no system notice on duplicate"
expect "broadcast → 201" "$(code -X POST "${A[@]}" -d '{"body":"Fixed in 2.4.2"}' "$URL/api/v1/admin/tickets/$ID1/broadcast")" 201
expect "broadcast reached duplicate" "$(curl -s "${W[@]}" "$URL/api/v1/widget/tickets/$CODE2" | jq '[.messages[]|select(.body=="Fixed in 2.4.2")]|length')" 1
expect "client reply reopens resolved" "$(curl -s -X POST "${W[@]}" -d '{"body":"Still broken"}' "$URL/api/v1/widget/tickets/$CODE2/messages" -o /dev/null -w '%{http_code}'; curl -s "${W[@]}" "$URL/api/v1/widget/tickets/$CODE2" | jq -r .status)" "201triaged"
ev=$(curl -s "${A[@]}" "$URL/api/v1/admin/tickets/$ID2" | jq -c '.events')
jq -e 'map(select(.field=="status" and .note=="Follows '"$CODE1"'"))|length==1' <<<"$ev" >/dev/null && ok "cascade logged on the duplicate" || bad "cascade not in activity log"
jq -e 'map(select(.actor=="Reporter" and .new_value=="triaged"))|length==1' <<<"$ev" >/dev/null && ok "reopen logged as the reporter" || bad "reopen not in activity log"
jq -e 'map(select(.field=="parent"))|length==1' <<<"$ev" >/dev/null && ok "duplicate link logged" || bad "link not in activity log"

echo "== projects"
np=$(curl -s -X POST "${A[@]}" -d '{"name":"Smoke POS","allowed_origins":["https://*.pos.example.com","https://pos.example.com:443/"]}' "$URL/api/v1/admin/projects")
expect "origins normalised" "$(jq -c .allowed_origins <<<"$np")" '["https://*.pos.example.com","https://pos.example.com"]'
NK=$(jq -r .project_key <<<"$np")
expect "wildcard subdomain allowed" "$(code -H 'Origin: https://store7.pos.example.com' -H "X-Project-Key: $NK" -H "X-Reporter-Token: $TOKEN" "$URL/api/v1/widget/tickets")" 200
expect "wildcard look-alike blocked" "$(code -H 'Origin: https://evilpos.example.com' -H "X-Project-Key: $NK" -H "X-Reporter-Token: $TOKEN" "$URL/api/v1/widget/tickets")" 403
expect "bad origin rule → 422" "$(code -X POST "${A[@]}" -d '{"name":"x","allowed_origins":["https://*.com"]}' "$URL/api/v1/admin/projects")" 422
NPID=$(jq -r .id <<<"$np")
curl -s -o /dev/null -X PATCH "${A[@]}" -d '{"is_active":false}' "$URL/api/v1/admin/projects/$NPID"
expect "deactivated project → 403" "$(code -H 'Origin: https://pos.example.com' -H "X-Project-Key: $NK" -H "X-Reporter-Token: $TOKEN" "$URL/api/v1/widget/tickets")" 403

echo "== rate limiting"
if [[ -n "${EXPECT_CREATE_LIMIT:-}" ]]; then
  got429=0
  for _ in $(seq 1 $((EXPECT_CREATE_LIMIT + 5))); do
    [[ "$(code -X POST "${W[@]}" -d '{}' "$URL/api/v1/widget/tickets")" == 429 ]] && { got429=1; break; }
  done
  expect "create burst → 429" "$got429" 1
else
  echo "  (skipped: set EXPECT_CREATE_LIMIT to the server's burst to test)"
fi

echo
echo "passed: $pass  failed: $fail"
[[ $fail -eq 0 ]]
