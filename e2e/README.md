# Snag regression tests

Use an isolated database and test services. These suites create tickets, users, roles and projects, change permissions, and revoke sessions. Do not point them at production.

The original suites support these environment variables:

```sh
export SNAG_URL=http://localhost:18081
export DASH_URL=http://localhost:13001
export WIDGET_URL=http://localhost:15173
export SITE_URL=http://localhost:14173
export ADMIN_TOKEN='<test-only service token>'
export OWNER_EMAIL=owner@example.com
export OWNER_PASSWORD='<test owner password>'
export CHROME_PATH=/usr/bin/google-chrome
```

The widget demo must load its script and API from `SNAG_URL`; its origin must be allowed on the demo project. The dashboard's server needs `SNAG_API_URL` pointing to that same server. For local HTTP only, set `COOKIE_SECURE=false`. Build the website with the same `SITE_URL` used by its checks.

From `e2e`, after installing locked dependencies:

```sh
npm run dashboard
npm run widget
npm run users
npm run regressions
npm run website
npm run performance
npm run accessibility
```

`regressions` requires explicit URLs and an admin token. It covers duplicate completion, the 25 admin status transitions, live permission changes, logout/deactivation while streaming, attachment decoding failure, rejected optimistic saves, and widget reconnect/navigation recovery. Errors are injected through browser routes; no production failure hooks are added.

`website` covers all public routes, actual 404 responses, responsive overflow, appearance, preference expiry, cross-tab synchronization, offline caching and withdrawal, and documentation search.

`performance` sends 100 requests each to health, ticket-list and AMC-report endpoints at concurrency 10, then records a browser page load. It is a small local diagnostic workload, not a capacity benchmark or Lighthouse score.

Backend checks, from `server`:

```sh
go test -race -cover ./...
go vet ./...
SNAG_URL="$SNAG_URL" ADMIN_TOKEN="$ADMIN_TOKEN" ORIGIN="$WIDGET_URL" bash scripts/smoke.sh
SNAG_URL="$SNAG_URL" OWNER_EMAIL="$OWNER_EMAIL" OWNER_PASSWORD="$OWNER_PASSWORD" bash scripts/rbac.sh
```

Run the smoke suite before RBAC: RBAC expects at least one existing ticket. The smoke suite's optional creation-rate assertion needs a server configured with the matching burst. Unit tests separately cover bucket isolation and exhaustion.

For coverage of real API operations, build the server using `go build -cover`, run it with `GOCOVERDIR` set to an empty directory, run the suites, and terminate it gracefully. Read the resulting counters with `go tool covdata percent -i=<directory>`. Unit and integration coverage are different measurements; do not average their percentages.

The website and state-regression suites use `BROWSER=chromium|firefox|webkit` (default Chromium). Install compatible browsers with `node node_modules/playwright-core/cli.js install firefox webkit`; Linux runtime libraries must also be available. `PLAYWRIGHT_BROWSERS_PATH` can select a local browser directory. Only Chromium uses `CHROME_PATH`.

`accessibility` runs axe-core WCAG A/AA rules on public routes in both themes, the storage dialog, login, and seven dashboard routes in light/dark. It also checks modal focus isolation/restoration and appearance arrow-key controls. The audit context bypasses CSP solely to inject axe; the application policy is unchanged. Automated checks and axe's incomplete results still require manual assistive-technology review.

`regressions` also runs 20 reciprocal-link races, 10 link/completion races, five malformed saved-position cases, and an inbox snapshot held behind a newer live event. Graph rewrites/completion cascades use a transaction-scoped PostgreSQL advisory lock before row locking; this favors consistency over simultaneous graph-write throughput across API replicas.

Use `PERF_REQUESTS=3000 PERF_CONCURRENCY=25 npm run performance` for a larger bounded local workload. The harness rejects out-of-range sizes and times out requests after 10 seconds. It reports p50/p95/p99 and errors; it is not a sustained production load test.

Firefox, real touch devices, assistive technologies, prolonged load, network partitions, database failover and production deployment still require environment-specific runs. A browser installation or partial run is not a passing suite.
