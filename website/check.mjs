/* Release checks for dist/. Run after `npm run build`; fails with a clear message on the first problem. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SITE_URL, PRODUCTION, FINGERPRINT, SECURITY_HEADERS, CACHE } from './site.config.mjs';

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const fail = message => { throw Error(message); };
const read = file => readFileSync(file, 'utf8');
const pages = walk('dist').filter(file => file.endsWith('.html'));
const hashed = readdirSync('dist').filter(file => /\.[0-9a-f]{10}\.(css|js)$/.test(file));

if (process.env.NODE_ENV === 'production' && !PRODUCTION) fail(`Production builds need an https SITE_URL (got ${SITE_URL}).`);
if (hashed.length !== FINGERPRINT.length) fail(`Expected ${FINGERPRINT.length} fingerprinted assets, found ${hashed.join(', ')}`);

let links = 0;
const canonicals = new Set();
for (const file of pages) {
  const html = read(file);
  const notFound = file === path.join('dist', '404.html');
  for (const marker of ['<title>', 'id="main"', 'class="theme-switch"', 'id="storage-dialog"', 'name="snag-static"', 'name="snag-consent"', 'name="description"', 'rel="manifest"', 'property="og:image"', 'name="twitter:card"']) {
    if (!html.includes(marker)) fail(`Missing ${marker}: ${file}`);
  }
  // Content-Security-Policy compatibility: no inline code or inline styles.
  for (const [, attrs] of html.matchAll(/<script([^>]*)>/g)) {
    if (!/\bsrc=/.test(attrs) && !/type="application\/ld\+json"/.test(attrs)) fail(`Inline script blocked by CSP: ${file}`);
  }
  if (/\sstyle="/.test(html)) fail(`Inline style attribute blocked by CSP: ${file}`);
  if (/\son[a-z]+="/.test(html)) fail(`Inline event handler blocked by CSP: ${file}`);
  for (const name of FINGERPRINT) if (new RegExp(`["/]${name.replace('.', '\\.')}"`).test(html)) fail(`Unfingerprinted ${name} referenced: ${file}`);
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    try { JSON.parse(json); } catch (error) { fail(`Invalid JSON-LD in ${file}: ${error.message}`); }
  }
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
  if (description.length < 50 || description.length > 170) fail(`Description should be 50–170 characters (${description.length}): ${file}`);
  if (notFound) {
    if (!html.includes('<meta name="robots" content="noindex">')) fail('404 page must be noindex.');
  } else {
    const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1] ?? fail(`Missing canonical: ${file}`);
    if (!canonical.startsWith(SITE_URL + '/')) fail(`Canonical outside ${SITE_URL}: ${file}`);
    canonicals.add(canonical);
  }
  const fileURL = new URL(file.replace(/^dist\//, ''), 'https://snag.test/');
  const base = html.match(/<base href="([^"]+)"/)?.[1];
  const baseURL = base ? new URL(base, fileURL) : fileURL;
  for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|mailto:|data:|#)/.test(url) || url === base) continue;
    const resolved = new URL(url, baseURL);
    const target = path.join('dist', decodeURIComponent(resolved.pathname));
    if (!existsSync(target) && !existsSync(path.join(target, 'index.html'))) fail(`Broken link ${file}: ${url} -> ${target}`);
    links++;
  }
}

// Search engines
const sitemap = read('dist/sitemap.xml');
const listed = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]));
for (const url of canonicals) if (!listed.has(url)) fail(`Sitemap is missing ${url}`);
for (const url of listed) if (!canonicals.has(url)) fail(`Sitemap lists a non-canonical URL ${url}`);
const robots = read('dist/robots.txt');
if (PRODUCTION ? !robots.includes(`Sitemap: ${SITE_URL}/sitemap.xml`) : !robots.includes('Disallow: /')) fail('robots.txt does not match the build mode.');

// Host headers and caching
const headers = read('dist/_headers');
for (const [key, value] of Object.entries(SECURITY_HEADERS)) if (!headers.includes(`${key}: ${value}`)) fail(`_headers is missing ${key}`);
for (const name of hashed) if (!headers.includes(`/${name}\n  Cache-Control: ${CACHE.immutable}`)) fail(`_headers does not cache ${name} as immutable`);
if (!headers.includes(`/sw.js\n  Cache-Control: ${CACHE.document}`)) fail('The worker must always revalidate.');
const nginxHeaders = read('build/nginx/security-headers.conf');
for (const key of Object.keys(SECURITY_HEADERS)) if (!nginxHeaders.includes(`add_header ${key} `)) fail(`nginx headers missing ${key}`);
const nginx = read('deploy/nginx.conf');
for (const include of ['/etc/nginx/snag/security-headers.conf', 'gzip_static on', 'error_page 404 /404.html']) if (!nginx.includes(include)) fail(`deploy/nginx.conf is missing ${include}`);

// Compression
for (const name of [...hashed, 'index.html']) {
  for (const ext of ['.br', '.gz']) if (!existsSync(`dist/${name}${ext}`)) fail(`Missing pre-compressed dist/${name}${ext}`);
}

// Installability and trust files
const manifest = JSON.parse(read('dist/manifest.webmanifest'));
for (const icon of manifest.icons) if (!existsSync(path.join('dist', icon.src))) fail(`Manifest icon missing: ${icon.src}`);
if (!manifest.icons.some(icon => icon.purpose === 'maskable')) fail('Manifest needs a maskable icon.');
for (const file of ['favicon.ico', 'icons/apple-touch-icon.png', 'icons/og-image.png', '.well-known/gpc.json']) if (!existsSync(`dist/${file}`)) fail(`Missing dist/${file}`);
const security = read('dist/.well-known/security.txt');
const expires = Date.parse(security.match(/^Expires: (.+)$/m)?.[1] ?? '');
if (!security.match(/^Contact: https:\/\//m) || !(expires > Date.now())) fail('security.txt needs a Contact and a future Expires date.');

// Product rules carried over from the original checks
for (const route of ['docs/api', 'docs/getting-started', 'legal/privacy', 'legal/terms', 'legal/cookies']) {
  if (!existsSync(`dist/${route}/index.html`)) fail(`Missing clean route: ${route}`);
}
if (read('dist/index.html').includes('<pre>')) fail('Product landing page should link to developer examples rather than lead with code.');
const css = read(path.join('dist', hashed.find(name => name.endsWith('.css'))));
if (/fonts\.googleapis|fonts\.gstatic/.test(css)) fail('Remote fonts are not expected.');

console.log(`Checked ${pages.length} pages, ${links} local links/assets, ${canonicals.size} canonical URLs, sitemap, robots, security headers, caching, compression, manifest, and security.txt (${PRODUCTION ? 'production' : 'preview'} build for ${SITE_URL}).`);
