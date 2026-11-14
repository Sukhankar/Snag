/* Single source of truth for the public website's identity, security headers and caching.
 * build.mjs writes these into dist/_headers (Netlify / Cloudflare Pages), build/nginx/*.conf
 * (Docker image) and serve.py reads dist/_headers, so every host sends the same policy. */

const rawUrl = process.env.SITE_URL || 'http://localhost:4173';
export const SITE_URL = rawUrl.replace(/\/+$/, '');
const parsed = new URL(SITE_URL);
export const HTTPS = parsed.protocol === 'https:';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** A production build is served over HTTPS from a real host name; anything else is a preview. */
export const PRODUCTION = HTTPS && !LOCAL_HOSTS.has(parsed.hostname);

export const SITE = {
  name: 'Snag',
  tagline: 'Every report deserves a resolution.',
  description: 'Snag connects customer bug reports, screenshots, team investigation, and live replies. Self-hosted issue reporting for teams supporting client applications.',
  repository: 'https://github.com/Sukhankar/Snag',
  securityContact: 'https://github.com/Sukhankar/Snag/security/advisories/new',
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  locale: 'en_US',
  themeColor: '#0a0a0a',
  ogImage: { path: 'icons/og-image.png', width: 1200, height: 630, alt: 'Snag — every report deserves a resolution.' },
};

/** Bump when the storage notice or the cookie policy changes: visitors are asked again. */
export const CONSENT_VERSION = '2026-11-14';

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(HTTPS ? ['upgrade-insecure-requests'] : []),
].join('; ');

/** Sent on every response. */
export const SECURITY_HEADERS = {
  'Content-Security-Policy': csp,
  ...(HTTPS ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'accelerometer=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  ...(PRODUCTION ? {} : { 'X-Robots-Tag': 'noindex, nofollow' }),
};

/** Cache classes. Fingerprinted assets never change; documents and the worker always revalidate. */
export const CACHE = {
  immutable: 'public, max-age=31536000, immutable',
  static: 'public, max-age=604800, stale-while-revalidate=86400',
  document: 'no-cache',
};

/** Source files that get a content hash in their published name. */
export const FINGERPRINT = ['style.css', 'app.js', 'theme.js'];

/** Extensions that are pre-compressed at build time. */
export const COMPRESSIBLE = /\.(html|css|js|json|svg|txt|xml|webmanifest|ico)$/;
