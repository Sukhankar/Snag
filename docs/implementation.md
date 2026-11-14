# Implementation notes

[← Back to Snag](../README.md)

## How the spec maps to the code

**Telemetry ring buffer**: [widget/src/telemetry.ts](../widget/src/telemetry.ts). A fixed
20-slot circular array, in RAM only. It records clicks, history/hash route changes,
`console.error`, uncaught errors and rejections, and failed `fetch` and `XMLHttpRequest` calls
(4xx/5xx and network errors). Query strings are stripped from URLs and input values are never
recorded. The widget's own API traffic goes through a `fetch` captured before patching, so it
is never recorded.

**Compression**: [widget/src/compress.ts](../widget/src/compress.ts). Images are drawn on an
`OffscreenCanvas`, scaled to at most 1600px wide and encoded as WebP q0.72, plus a WebP q0.5
thumbnail inside a 150px box. On Safari versions without a WebP encoder it falls back to JPEG.
Text, log, CSV, JSON and XML files go through `CompressionStream('gzip')`. Previous build-report measurements: a 133 KB
PNG becomes a 9 KB WebP with a 1.4 KB thumbnail, and a 34 KB log gzips to 139 B.

**Origin guard**: [server/internal/httpapi/origin.go](../server/internal/httpapi/origin.go).
`X-Project-Key` plus `Origin` (falling back to `Referer`) is checked against
`projects.allowed_origins`; a mismatch gets 403. Wildcard subdomains (`https://*.acme.com`)
are supported. Projects are cached in memory, so the check costs no database round-trip.

**Atomic ingest**: `WidgetRepo.CreateTicket` in
[server/internal/store/widget_repo.go](../server/internal/store/widget_repo.go) inserts the
ticket, the first message and all attachments (as one pipelined batch) in a single
transaction. The server also checks each attachment's file signature ("magic bytes") against
its declared type, so a file labelled `image/webp` really is one.

**`is_internal` isolation**: `WidgetRepo` and `AdminRepo` share no queries. Every widget
query is scoped by `(project_id, reporter_token)` and filters `is_internal = FALSE`, and
attachments are only visible when they hang off a public message. The SSE publisher also
refuses internal messages.

**Keyset inbox**: `AdminRepo.ListTickets` uses `WHERE (created_at, id) < ($1,$2)` over a
matching composite index. Previously measured at 200k tickets (not re-benchmarked here): **1.5–4.6 ms** end-to-end over HTTP,
whether on the first page, a deep page or a status filter.

**TOAST**: `payload_b64` is stored out of line (`EXTENDED`, lz4), so list and metadata
queries never read it. `thumbnail_b64` prefers inline storage (`MAIN`).

**SSE broker**: [server/internal/broker/broker.go](../server/internal/broker/broker.go) and
[sse.go](../server/internal/httpapi/sse.go). Non-blocking fan-out (slow clients are dropped and
reconnect), 20s heartbeats, a per-response write-deadline lift, and clean shutdown.

**Dedupe**: linking flattens the hierarchy to one level. Resolving or closing a parent
cascades to its open duplicates in one transaction and posts a system notice to each reporter.
"Broadcast" sends one public reply to every linked reporter.

**Dashboard security**: the admin token never reaches the browser. The
[BFF proxy](../dashboard/src/app/api/snag/[...path]/route.ts) forwards only allow-listed paths,
reads an opaque session token from an HttpOnly cookie, and enforces same-origin + JSON on every mutation.

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

- **Bundle size**: the previous build report recorded `widget.min.js` at **35 KB minified, 13.9 KB gzipped (12.4 KB brotli)**.
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

