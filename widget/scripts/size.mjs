// Prints bundle sizes and fails the build if the gzipped (over-the-wire) size exceeds 20 KB.
//
// Why gzip and not minified: Preact + hooks + jsx-runtime alone are ~16.5 KB minified, so a
// 20 KB *minified* budget leaves no room for the UI. Transfer size is what affects host-page
// load, and every CDN/server serves this file compressed.
import { readFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const BUDGET_GZIP = 20 * 1024;
const buf = readFileSync(new URL('../dist/widget.min.js', import.meta.url));
const gz = gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`widget.min.js  min ${kb(buf.length)}  gzip ${kb(gz)}  brotli ${kb(brotliCompressSync(buf).length)}`);
if (gz > BUDGET_GZIP) {
  console.error(`✗ over the ${kb(BUDGET_GZIP)} gzip budget`);
  process.exit(1);
}
console.log(`✓ within the ${kb(BUDGET_GZIP)} gzip budget`);
