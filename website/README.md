# Snag website

A product landing page, ten developer guides, and terms, privacy, and browser-storage notices. Legal pages direct questions to the project's GitHub issues. If you operate a commercial deployment, have the operator name, jurisdiction and contacts reviewed and added.

## Run locally

```bash
npm run build
npm test
npm run dev
```

Open http://localhost:4173. If that port is busy, use `PORT=4174 npm run dev`. Node.js runs the dependency-free build and checks; Python 3 serves the preview.

## Source

- `src/index.html`: product story, workflow carousel, setup path, FAQ, and developer links.
- `src/docs/`: integration, API, configuration, testing, operations, and troubleshooting.
- `src/legal/`: draft website notices and storage disclosures.
- `src/theme.js`: pre-paint appearance selection; first visits follow the system.
- `src/app.js`: appearance, consent/preferences, carousel, copy controls, and guide filtering.
- `src/style.css`: shared light/dark tokens and responsive layouts.
- `site.config.mjs`: site identity, consent version, security headers and cache policy.
- `build.mjs`: generates `dist/`, hashed assets, SEO metadata, clean URLs, sitemap, robots, manifest, security.txt, host headers, pre-compressed files and the offline worker.
- `src/icons/`, `src/favicon.ico`: app icons and the social share image.
- `deploy/nginx.conf`, `Dockerfile`: the production container.
- `serve.py`: preview server that applies `dist/_headers`, serves pre-compressed files and returns the custom 404.
- `tests/cache.test.mjs`: worker isolation, validation, offline fallback, and withdrawal checks.

## Appearance and storage

Dark is the default for first visits; visitors switch between System, Light and Dark with the segmented control in the header (arrow keys supported). Appearance is persisted only after opting into Remember appearance. The hero preview loops through Capture, Triage and Reply every seven seconds, with a progress line on the active tab. Choosing a step jumps to it and the loop carries on; it only waits while the browser tab is hidden.

No analytics, advertising SDKs, remote font requests, or application cookies are included. Saving storage choices records a localStorage preference for up to 180 days. Offline caching is opt-in, limited to static site assets, network-first, and versioned by content. API requests, query-bearing URLs, foreign origins, and unmarked authentication pages are excluded. Footer settings can disable/clear the offline cache or reset all preferences. These controls do not erase browser HTTP cache, hosting cookies, or another Snag application's data.

## Production build

```bash
SITE_URL=https://snag.example.org npm run build:prod   # build + release checks; refuses a non-https SITE_URL
docker compose up -d --build website                  # or: docker build --build-arg SITE_URL=... website/
```

`site.config.mjs` is the single source of truth for the site identity, consent version, security headers and cache policy. The build turns it into `dist/_headers` (Netlify, Cloudflare Pages), `build/nginx/*.conf` (Docker image) and the preview server's headers, so every host sends the same policy. Without an https `SITE_URL` the build is a preview: `robots.txt` disallows everything and pages carry `noindex`.

| Area | What the build provides |
| --- | --- |
| Security | Strict Content-Security-Policy (no inline code), HSTS and `upgrade-insecure-requests` on https, `X-Frame-Options`/`frame-ancestors`, `nosniff`, Referrer-Policy, Permissions-Policy, COOP/CORP, `.well-known/security.txt` (expires one year after each build). |
| Caching | CSS and JS get content-hashed names cached for a year (`immutable`); HTML, `sw.js` and the manifest always revalidate; icons cache for a week. Brotli and gzip files are pre-compressed. The offline worker is opt-in and versioned by content. |
| Search and sharing | Canonical URLs, per-page descriptions, Open Graph and Twitter cards with a 1200×630 image, JSON-LD (Organization, WebSite, SoftwareApplication, TechArticle, BreadcrumbList), `sitemap.xml`, `robots.txt`, `noindex` on 404. |
| Privacy | Consent records store the choice, policy version and time; bump `CONSENT_VERSION` to ask again. Global Privacy Control is honoured (no prompt, no optional storage) and declared in `.well-known/gpc.json`. No cookies, analytics or remote fonts. |
| Install | Web app manifest, favicon.ico, PNG and maskable icons, Apple touch icon. |
| Container | nginx-unprivileged (non-root), read-only filesystem, all capabilities dropped, per-IP rate limit, dot-files and `_headers` never served, custom 404 with HTTP 404, health check. |

`npm test` checks every page for CSP-safe markup, valid JSON-LD, canonical and sitemap agreement, header and cache rules, compression, manifest icons and `security.txt`, then runs the worker tests.

## Hosting elsewhere

Serve `dist/` as the site root and return `404.html` with HTTP status 404 for unknown paths. Netlify and Cloudflare Pages apply `dist/_headers` automatically; on other hosts, copy the rules from it. Service workers need HTTPS (localhost is fine for development).

`.openai/hosting.json` retains the registered private Sites identity. Registration is not deployment. The prior Sites credential handoff remains blocked by execution approval policy; GitHub source updates are independent of hosting.

The site never submits tickets or runs requests against the Snag API. The carousel uses illustrative data; executable samples are in the developer guides. Apache-2.0 applies; see the root LICENSE.
