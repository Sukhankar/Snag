/* Static build: src/ → dist/.
 *  1. Copy sources and give CSS/JS a content-hashed name (cached for a year, never stale).
 *  2. Add per-page SEO: canonical URL, description, Open Graph / Twitter cards, JSON-LD, robots.
 *  3. Create clean directory URLs (/docs/api/) beside the .html files.
 *  4. Generate robots.txt, sitemap.xml, the web manifest, security.txt, gpc.json,
 *     host headers (dist/_headers, build/nginx/*.conf) and the opt-in offline worker.
 *  5. Pre-compress text assets (.br and .gz) so hosts can serve them without CPU cost.
 * Set SITE_URL for production, e.g. SITE_URL=https://snag.example.org npm run build. */
import { cpSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';
import path from 'node:path';
import { SITE, SITE_URL, PRODUCTION, SECURITY_HEADERS, CACHE, FINGERPRINT, COMPRESSIBLE, CONSENT_VERSION } from './site.config.mjs';

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const posix = file => file.split(path.sep).join('/');
const hash = data => createHash('sha256').update(data).digest('hex').slice(0, 10);
const escapeAttr = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const stripTags = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const today = new Date().toISOString().slice(0, 10);

rmSync('dist', { recursive: true, force: true });
rmSync('build', { recursive: true, force: true });
mkdirSync('dist');
cpSync('src', 'dist', { recursive: true });

// ---------- 1. Fingerprint CSS and JS ----------
const renamed = {};
for (const file of FINGERPRINT) {
  const ext = path.extname(file);
  const name = `${path.basename(file, ext)}.${hash(readFileSync(path.join('dist', file)))}${ext}`;
  renameSync(path.join('dist', file), path.join('dist', name));
  renamed[file] = name;
}
const assetPattern = new RegExp(`((?:\\.\\./)*)(${FINGERPRINT.map(f => f.replace('.', '\\.')).join('|')})"`, 'g');

// ---------- 2. Per-page metadata ----------
const GENERIC = 'Snag: contextual bug reports, live conversations, and developer documentation for a self-hosted Go, Preact, and Next.js stack.';
function lastModified(file) {
  try {
    const date = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (date && !execFileSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8' }).trim()) return date;
  } catch { /* Not a git checkout (e.g. a Docker build): fall back to the file time. */ }
  return statSync(file).mtime.toISOString().slice(0, 10);
}
function routeOf(relative) {
  if (relative === 'index.html') return '/';
  return '/' + relative.replace(/\.html$/, '/');
}
function jsonLd(data) {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

const pages = [];
for (const file of walk('dist').filter(f => f.endsWith('.html'))) {
  const relative = posix(path.relative('dist', file));
  const notFound = relative === '404.html';
  const depth = notFound ? 0 : relative.split('/').length - 1;
  const prefix = '../'.repeat(depth);
  let html = readFileSync(file, 'utf8').replace(assetPattern, (_, up, name) => `${up}${renamed[name]}"`);

  const title = stripTags(html.match(/<title>(.*?)<\/title>/s)?.[1] ?? SITE.name);
  const shortTitle = title.replace(/\s+—\s+Snag$/, '');
  const lead = stripTags(html.match(/<p class="lead">(.*?)<\/p>/s)?.[1] ?? '');
  let description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? SITE.description;
  if (description === GENERIC && lead) description = lead.length > 160 ? lead.slice(0, 157).replace(/\s+\S*$/, '') + '…' : lead;
  html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeAttr(description)}">`);

  const route = routeOf(relative);
  const url = SITE_URL + route;
  const section = relative.startsWith('docs/') ? 'Docs' : relative.startsWith('legal/') ? 'Legal' : null;
  const image = `${SITE_URL}/${SITE.ogImage.path}`;
  const head = [
    notFound ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${url}">`,
    !notFound && !PRODUCTION ? '<meta name="robots" content="noindex, nofollow">' : '',
    `<link rel="icon" href="${prefix}favicon.ico" sizes="32x32">`,
    `<link rel="apple-touch-icon" href="${prefix}icons/apple-touch-icon.png">`,
    `<link rel="manifest" href="${prefix}manifest.webmanifest">`,
    `<meta name="application-name" content="${SITE.name}">`,
    `<meta property="og:site_name" content="${SITE.name}">`,
    `<meta property="og:type" content="${section ? 'article' : 'website'}">`,
    `<meta property="og:title" content="${escapeAttr(shortTitle === SITE.name ? SITE.tagline : shortTitle)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    notFound ? '' : `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="${SITE.ogImage.width}">`,
    `<meta property="og:image:height" content="${SITE.ogImage.height}">`,
    `<meta property="og:image:alt" content="${escapeAttr(SITE.ogImage.alt)}">`,
    `<meta property="og:locale" content="${SITE.locale}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeAttr(shortTitle === SITE.name ? SITE.tagline : shortTitle)}">`,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
    `<meta name="twitter:image" content="${image}">`,
  ];
  if (relative === 'index.html') {
    head.push(jsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', '@id': `${SITE_URL}/#organization`, name: SITE.name, url: `${SITE_URL}/`, logo: `${SITE_URL}/icons/icon-512.png`, sameAs: [SITE.repository] },
        { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, name: SITE.name, url: `${SITE_URL}/`, publisher: { '@id': `${SITE_URL}/#organization` }, inLanguage: 'en' },
        {
          '@type': 'SoftwareApplication', name: SITE.name, description: SITE.description, url: `${SITE_URL}/`,
          applicationCategory: 'DeveloperApplication', operatingSystem: 'Linux, macOS, Windows (Docker)',
          isAccessibleForFree: true, license: SITE.license, image, publisher: { '@id': `${SITE_URL}/#organization` },
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        },
      ],
    }));
  } else if (section) {
    const sectionUrl = section === 'Docs' ? `${SITE_URL}/docs/getting-started/` : `${SITE_URL}/legal/privacy/`;
    head.push(jsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': section === 'Docs' ? 'TechArticle' : 'WebPage', headline: shortTitle, description, url,
          dateModified: lastModified(path.join('src', relative)), inLanguage: 'en', image,
          isPartOf: { '@type': 'WebSite', name: SITE.name, url: `${SITE_URL}/` },
          publisher: { '@type': 'Organization', name: SITE.name, logo: `${SITE_URL}/icons/icon-512.png` },
        },
        {
          '@type': 'BreadcrumbList', itemListElement: [
            { '@type': 'ListItem', position: 1, name: SITE.name, item: `${SITE_URL}/` },
            { '@type': 'ListItem', position: 2, name: section, item: sectionUrl },
            { '@type': 'ListItem', position: 3, name: shortTitle, item: url },
          ],
        },
      ],
    }));
  }
  html = html.replace('</head>', head.filter(Boolean).join('') + '</head>');
  html = html.replace('<meta name="snag-static" content="v1">', `<meta name="snag-static" content="v1"><meta name="snag-consent" content="${CONSENT_VERSION}">`);
  writeFileSync(file, html);
  if (!notFound) pages.push({ relative, route, url, modified: lastModified(path.join('src', relative)) });
}

// ---------- 3. Clean directory URLs ----------
for (const { relative } of pages) {
  if (relative === 'index.html') continue;
  const directory = path.join('dist', relative.replace(/\.html$/, ''));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'index.html'), readFileSync(path.join('dist', relative), 'utf8').replace('<head>', '<head><base href="../">'));
}

// ---------- 4. Generated files ----------
writeFileSync('dist/robots.txt', PRODUCTION
  ? `User-agent: *\nAllow: /\nDisallow: /404.html\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
  : '# Preview build: not for indexing. Build with an https SITE_URL for production.\nUser-agent: *\nDisallow: /\n');

const priority = route => route === '/' ? '1.0' : route.startsWith('/docs/') ? '0.8' : '0.3';
writeFileSync('dist/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
  .sort((a, b) => priority(b.route) - priority(a.route) || a.route.localeCompare(b.route))
  .map(p => `  <url><loc>${p.url}</loc><lastmod>${p.modified}</lastmod><priority>${priority(p.route)}</priority></url>`).join('\n')}\n</urlset>\n`);

writeFileSync('dist/manifest.webmanifest', JSON.stringify({
  name: SITE.name, short_name: SITE.name, description: SITE.description, lang: 'en',
  start_url: './', scope: './', display: 'minimal-ui',
  background_color: SITE.themeColor, theme_color: SITE.themeColor,
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n');

mkdirSync('dist/.well-known', { recursive: true });
const expires = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
writeFileSync('dist/.well-known/security.txt', [
  `Contact: ${SITE.securityContact}`,
  `Expires: ${expires}`,
  'Preferred-Languages: en',
  `Canonical: ${SITE_URL}/.well-known/security.txt`,
  `Policy: ${SITE_URL}/docs/security/`,
  '',
].join('\n'));
// The site honours the Global Privacy Control signal (https://privacycg.github.io/gpc-spec/).
writeFileSync('dist/.well-known/gpc.json', JSON.stringify({ gpc: true, lastUpdate: CONSENT_VERSION }) + '\n');

// Host headers. Netlify / Cloudflare Pages read dist/_headers; serve.py reads it too.
const block = (pattern, headers) => `${pattern}\n${Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`;
const longLived = Object.values(renamed).map(name => block(`/${name}`, { 'Cache-Control': CACHE.immutable }));
writeFileSync('dist/_headers', [
  '# Generated by build.mjs from site.config.mjs. Do not edit.',
  block('/*', { ...SECURITY_HEADERS, 'Cache-Control': CACHE.document }),
  ...longLived,
  block('/icons/*', { 'Cache-Control': CACHE.static }),
  block('/favicon.ico', { 'Cache-Control': CACHE.static }),
  block('/mark.svg', { 'Cache-Control': CACHE.static }),
  block('/sw.js', { 'Cache-Control': CACHE.document }),
].join('\n'));

// nginx include files for the Docker image (outside dist so they are never served).
mkdirSync('build/nginx', { recursive: true });
writeFileSync('build/nginx/security-headers.conf', '# Generated by build.mjs from site.config.mjs.\n' +
  Object.entries(SECURITY_HEADERS).map(([k, v]) => `add_header ${k} "${v}" always;`).join('\n') + '\n');
writeFileSync('build/nginx/cache.conf', '# Generated by build.mjs from site.config.mjs.\n' + [
  `set $snag_cache_immutable "${CACHE.immutable}";`,
  `set $snag_cache_static "${CACHE.static}";`,
  `set $snag_cache_document "${CACHE.document}";`,
].join('\n') + '\n');

// ---------- Offline worker (opt-in from the storage settings) ----------
const OFFLINE = /\.(html|css|js|json|svg|png|ico|txt|webmanifest)$/;
const assets = walk('dist').map(file => posix(path.relative('dist', file)))
  .filter(file => OFFLINE.test(file) && !file.startsWith('.well-known/') && !['robots.txt'].includes(file));
const version = hash(assets.map(file => file + readFileSync(path.join('dist', file))).join(''));
const worker = `const ROOT = new URL('./', self.location.href);
const PREFIX = 'snag-docs-' + encodeURIComponent(ROOT.pathname) + '-';
const CACHE = PREFIX + '${version}';
const FILES = ${JSON.stringify(assets)};
const ALLOWED = new Set(FILES.map(file => new URL(file, ROOT).href));
let enabled = true;
function canonical(url) {
  if (url.pathname === ROOT.pathname) return new URL('index.html', ROOT).href;
  if (url.pathname.endsWith('/')) return new URL('index.html', url).href;
  return url.href;
}
async function valid(response, url) {
  if (!enabled || !response.ok || response.redirected || response.type === 'opaque') return false;
  const type = response.headers.get('content-type') || '';
  if (url.endsWith('.html')) return type.includes('text/html') && (await response.clone().text()).includes('name="snag-static" content="v1"');
  if (url.endsWith('.js')) return type.includes('javascript');
  if (url.endsWith('.css')) return type.includes('text/css');
  if (url.endsWith('.svg')) return type.includes('image/svg+xml');
  if (url.endsWith('.png') || url.endsWith('.ico')) return type.startsWith('image/');
  if (url.endsWith('.webmanifest')) return type.includes('manifest+json') || type.includes('application/json');
  if (url.endsWith('.json')) return type.includes('application/json');
  return type.includes('text/plain');
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(FILES.map(async file => {
      const url = new URL(file, ROOT).href;
      try { const response = await fetch(url, { cache: 'reload' }); if (await valid(response, url)) await cache.put(url, response); } catch { /* Keep online operation available. */ }
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'DISABLE_CACHE') {
    enabled = false;
    event.waitUntil(Promise.all([self.registration.unregister(), caches.delete(CACHE)]));
  }
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const key = canonical(url);
  if (!enabled || event.request.method !== 'GET' || url.origin !== ROOT.origin || url.search || !ALLOWED.has(key)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (await valid(response, key)) {
        const cache = await caches.open(CACHE);
        if (enabled) await cache.put(key, response.clone());
      }
      return response;
    } catch {
      const cached = enabled ? await caches.match(key, { cacheName: CACHE }) : null;
      return cached || Response.error();
    }
  })());
});`;
writeFileSync('dist/sw.js', worker);

// ---------- 5. Pre-compression ----------
let saved = 0;
for (const file of walk('dist').filter(f => COMPRESSIBLE.test(f) && !f.endsWith('_headers'))) {
  const data = readFileSync(file);
  if (data.length < 512) continue;
  const br = brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } });
  const gz = gzipSync(data, { level: 9 });
  if (br.length < data.length) writeFileSync(file + '.br', br);
  if (gz.length < data.length) writeFileSync(file + '.gz', gz);
  saved += data.length - br.length;
}

console.log(`Built ${pages.length} pages and ${assets.length} offline assets for ${SITE_URL}${PRODUCTION ? '' : ' (preview: noindex)'}.`);
console.log(`Fingerprinted: ${Object.values(renamed).join(', ')}. Offline cache version ${version}. Brotli saves ${(saved / 1024).toFixed(0)} KB.`);
