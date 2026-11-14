# Snag

Multi-tenant issue tracking and telemetry engine. Client apps embed a script tag, users report
issues with screenshots and an automatic "black box" of recent app activity, and the team
triages everything from one dashboard with live updates both ways.

```
 client app (POS / ERP / SaaS)            Go server (single binary)             Next.js dashboard
┌──────────────────────────────┐        ┌──────────────────────────────┐       ┌───────────────────────┐
│ <script widget.min.js>       │  JSON  │ /api/v1/widget/*  origin     │       │ /api/snag/* BFF proxy │
│  closed ShadowRoot (Preact)  ├───────►│   guard + rate limit         │◄──────┤  session cookie →     │
│  ring buffer: 20 events      │        │ /api/v1/admin/*   bearer     │ HTTP  │  admin bearer token   │
│  WebP/gzip compression       │◄───────┤ SSE broker (fan-out)         ├──────►│ inbox · triage · board│
│  "My Tickets" over SSE       │  SSE   │ pgxpool → PostgreSQL 17      │  SSE  │                       │
└──────────────────────────────┘        └──────────────────────────────┘       └───────────────────────┘
```

| Path | What |
|---|---|
| [server/](server/) | Go 1.26, chi, pgx v5. Migrations embedded, run at start-up. Also serves `widget.min.js`. |
| [widget/](widget/) | Preact + Vite library build → one IIFE file. |
| [dashboard/](dashboard/) | Next.js 16 App Router + Tailwind 4. |
| [e2e/](e2e/) | Playwright browser suites for the widget and the dashboard. |

## How to run

You need **Docker** (with Compose). That's all: Go, Node and Postgres run inside containers.

```bash
cd Snag
cp .env.example .env          # change the passwords/secrets for anything beyond local use
docker compose up --build -d  # first build takes a few minutes
docker compose ps             # postgres, server and dashboard should be "Up"
```

| Open | What |
|---|---|
| http://localhost:3000 | Dashboard. Sign in as the Owner: `SNAG_OWNER_EMAIL` / `SNAG_OWNER_PASSWORD` from `.env` |
| http://localhost:8080/healthz | API health check → `{"status":"ok"}` |
| http://localhost:8080/widget.min.js | The embeddable widget |

## Users, roles & permissions

- **Owner (the ultimate user).** Created on first start from `SNAG_OWNER_EMAIL` /
  `SNAG_OWNER_PASSWORD`. Always has every permission, can't be deactivated or re-roled, and
  only the Owner can edit the Owner account. Change the password after first sign-in under
  **My account**.
- **Users** page: create people (name, email, role, generated temporary password), change
  roles, reset passwords, deactivate/reactivate. Deactivating or resetting a password signs
  that person out everywhere immediately.
- **Roles** page: a grid of permissions × roles. Tick a box and it applies on that role's
  next request, even for people already signed in. Default roles are Admin, Developer,
  Support Agent and Viewer; create your own or edit these. The 👑 Owner role is locked.
- **13 permissions**: view / update / assign / classify (AMC) / link duplicates / reply /
  internal notes / broadcast on tickets; view / manage projects; manage teams; manage users;
  manage roles. Without "Internal notes", a user never receives internal notes, not even
  over the live stream.
- **No privilege escalation**: you can only assign roles or grant permissions you hold
  yourself, and you can't edit a user who has more permissions than you.
- Every rule is enforced by the Go server on each request; the dashboard only hides what
  you can't use. Passwords are hashed with argon2id, and only a SHA-256 of each session
  token is stored.

**Locked out?** Reset any account's password (including the Owner's) from the server:

```bash
docker compose run --rm -e SNAG_NEW_PASSWORD='a-new-long-password' server set-password owner@example.com
```

**Try the widget** with the built-in demo page (the demo project in `.env` whitelists port 5173):

```bash
cd widget && npm ci && npm run demo   # then open http://localhost:5173 and press Alt+B
```

Submit a ticket there and watch it appear live in the dashboard inbox.

Everyday commands:

```bash
docker compose logs -f server         # API logs
docker compose up --build -d          # rebuild after code changes
docker compose down                   # stop (data is kept in the pgdata volume)
docker compose down -v                # stop and delete all data
```

Embed the widget in any app (the dashboard's **Projects** page generates this for you):

```html
<script src="https://snag.example.com/widget.min.js"
        data-project-key="pk_..."
        data-app-version="2.4.1"
        async></script>
```

Optional attributes: `data-api`, `data-user-name`, `data-user-email`, `data-fab="false"`
(hotkey only), `data-mask-text="true"` (don't record clicked text), `data-theme`, `data-accent`.
JS API: `Snag.init({...})`, `open()`, `close()`, `toggle()`, `identify({name, email})`.

### Running without Docker

```bash
# server  (needs Postgres; Go 1.26)
cd server && DATABASE_URL=postgres://... SNAG_OWNER_EMAIL=you@example.com SNAG_OWNER_PASSWORD=<10+ chars> go run ./cmd/snag
# widget
cd widget && npm ci && npm run build      # → dist/widget.min.js (set SNAG_WIDGET_FILE to serve it)
npm run demo                              # hostile-CSS demo host on :5173
# dashboard
cd dashboard && npm ci && cp .env.example .env.local && npm run dev
```

Server environment: `DATABASE_URL` (required); `SNAG_OWNER_EMAIL` / `SNAG_OWNER_PASSWORD` / `SNAG_OWNER_NAME` (first start); `SNAG_ADMIN_TOKEN` (optional full-access token for scripts); `SNAG_ADDR` (`:8080`),
`SNAG_WIDGET_FILE`, `SNAG_MAX_TICKET_MB` (20), `SNAG_CREATE_PER_MINUTE` (10 per project+IP),
`SNAG_TRUST_PROXY` (only behind a proxy that overwrites `X-Forwarded-For`),
`SNAG_DEMO_PROJECT_KEY` / `SNAG_DEMO_ORIGINS`.

## How the spec maps to the code

**Telemetry ring buffer**: [widget/src/telemetry.ts](widget/src/telemetry.ts). A fixed
20-slot circular array, in RAM only. It records clicks, history/hash route changes,
`console.error`, uncaught errors and rejections, and failed `fetch` and `XMLHttpRequest` calls
(4xx/5xx and network errors). Query strings are stripped from URLs and input values are never
recorded. The widget's own API traffic goes through a `fetch` captured before patching, so it
is never recorded.

**Compression**: [widget/src/compress.ts](widget/src/compress.ts). Images are drawn on an
`OffscreenCanvas`, scaled to at most 1600px wide and encoded as WebP q0.72, plus a WebP q0.5
thumbnail inside a 150px box. On Safari versions without a WebP encoder it falls back to JPEG.
Text, log, CSV, JSON and XML files go through `CompressionStream('gzip')`. Measured: a 133 KB
PNG becomes a 9 KB WebP with a 1.4 KB thumbnail, and a 34 KB log gzips to 139 B.

**Origin guard**: [server/internal/httpapi/origin.go](server/internal/httpapi/origin.go).
`X-Project-Key` plus `Origin` (falling back to `Referer`) is checked against
`projects.allowed_origins`; a mismatch gets 403. Wildcard subdomains (`https://*.acme.com`)
are supported. Projects are cached in memory, so the check costs no database round-trip.

**Atomic ingest**: `WidgetRepo.CreateTicket` in
[server/internal/store/widget_repo.go](server/internal/store/widget_repo.go) inserts the
ticket, the first message and all attachments (as one pipelined batch) in a single
transaction. The server also checks each attachment's file signature ("magic bytes") against
its declared type, so a file labelled `image/webp` really is one.

**`is_internal` isolation**: `WidgetRepo` and `AdminRepo` share no queries. Every widget
query is scoped by `(project_id, reporter_token)` and filters `is_internal = FALSE`, and
attachments are only visible when they hang off a public message. The SSE publisher also
refuses internal messages.

**Keyset inbox**: `AdminRepo.ListTickets` uses `WHERE (created_at, id) < ($1,$2)` over a
matching composite index. Measured at 200k tickets: **1.5–4.6 ms** end-to-end over HTTP,
whether on the first page, a deep page or a status filter.

**TOAST**: `payload_b64` is stored out of line (`EXTENDED`, lz4), so list and metadata
queries never read it. `thumbnail_b64` prefers inline storage (`MAIN`).

**SSE broker**: [server/internal/broker/broker.go](server/internal/broker/broker.go) and
[sse.go](server/internal/httpapi/sse.go). Non-blocking fan-out (slow clients are dropped and
reconnect), 20s heartbeats, a per-response write-deadline lift, and clean shutdown.

**Dedupe**: linking flattens the hierarchy to one level. Resolving or closing a parent
cascades to its open duplicates in one transaction and posts a system notice to each reporter.
"Broadcast" sends one public reply to every linked reporter.

**Dashboard security**: the admin token never reaches the browser. The
[BFF proxy](dashboard/src/app/api/snag/[...path]/route.ts) forwards only allow-listed paths,
requires a signed HMAC session cookie, and enforces same-origin + JSON on every mutation.

## Deviations from the blueprint (deliberate)

- **`TIMESTAMPTZ`** instead of `TIMESTAMP`: keyset cursors must be timezone-unambiguous.
- **`tickets.reporter_token`** (new): an anonymous per-browser secret that scopes "My
  Tickets". Looking tickets up by `reporter_email` would let anyone read anyone's tickets.
- **`tickets.scope_class`** (new: `unclassified | bug | change_request`): the blueprint's
  `category` column (bug/feature/query/amc_request) describes what the *client* reported. AMC
  coverage is a separate call made by the team, so it gets its own field.
- **Priority default `P2_Normal`**: the blueprint's `'P2'` default didn't match its own values.
- `project_id NOT NULL`, CHECK constraints on enum-like columns, `ticket_code` generated from a
  sequence (`SNAG-1001`…), and message/attachment `created_at` uses `clock_timestamp()` so rows
  inserted in one transaction keep their order.

## Known limits / next steps

- **Bundle size**: `widget.min.js` is **35 KB minified, 13.9 KB gzipped (12.4 KB brotli)**.
  Preact + hooks + jsx-runtime alone are ~16.5 KB minified, so a 20 KB *minified* budget can't
  fit the specified UI. The build gate is set on gzip, which is the transfer size. Getting
  under 20 KB minified would mean dropping Preact for hand-written DOM code.
- **Single replica for realtime**: the SSE broker is in-process. Running several server
  replicas needs Postgres `LISTEN/NOTIFY` (or Redis) behind `Broker.Publish`.
- **Dashboard sign-in** is email + password. SSO/OIDC and 2FA are not built yet.
  Users are deactivated rather than deleted, so their replies and notes stay attributed.
- **Base64 in `TEXT`** follows the spec. Note that LZ-family TOAST compression can't shrink
  base64 of already-compressed WebP or gzip data, so `BYTEA` would be ~25% smaller on disk.
- The origin guard is a browser-side control: it stops other sites from using a leaked key,
  not a script that forges headers. Per-project+IP rate limits cover that case.
- Electron/`file://` hosts send `Origin: null` and cannot be whitelisted yet.

## Tests

```bash
server/scripts/smoke.sh                         # 48 API checks: origin guard, atomic ingest, keyset,
                                                #   SSE + is_internal isolation, dedupe cascade, projects
EXPECT_CREATE_LIMIT=5 server/scripts/smoke.sh   # also asserts the 429 rate limit
server/scripts/rbac.sh                          # 44 checks: roles, permissions, escalation, sessions
cd e2e && npm i && npm run widget               # 35 browser checks (needs :8080 + demo on :5173)
npm run dashboard                               # 32 browser checks (needs :8080 + :3000)
npm run users                                   # 17 browser checks: users, roles grid, restricted views
```
