import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function worker(fetchImpl) {
  const handlers = {};
  const writes = [];
  const stored = new Map();
  const cache = { put: async (key, response) => { writes.push(key); stored.set(key, response); } };
  const self = {
    location: { href: 'https://snag.test/sw.js' },
    addEventListener: (name, handler) => handlers[name] = handler,
    registration: { unregister: async () => true },
    clients: { claim: async () => {} }, skipWaiting: async () => {}
  };
  vm.runInNewContext(readFileSync('dist/sw.js', 'utf8'), {
    self, URL, Response, Set, Promise,
    fetch: fetchImpl,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async key => stored.get(key) }
  });
  function request(url, method = 'GET') {
    let response;
    handlers.fetch({ request: new Request(url, { method }), respondWith: value => response = value });
    return response;
  }
  return { request, handlers, writes, stored };
}

test('worker ignores APIs, non-GET requests, foreign origins, and query parameters', () => {
  const w = worker(() => { throw Error('Should not fetch'); });
  for (const [url, method] of [
    ['https://snag.test/api/v1/admin/me', 'GET'],
    ['https://snag.test/index.html?token=private', 'GET'],
    ['https://elsewhere.test/index.html', 'GET'],
    ['https://snag.test/index.html', 'POST']
  ]) assert.equal(w.request(url, method), undefined);
});

test('network-first caches only validated static HTML and falls back offline', async () => {
  let online = true;
  const body = '<meta name="snag-static" content="v1"><h1>Docs</h1>';
  const w = worker(async () => {
    if (!online) throw Error('offline');
    return new Response(body, { headers: { 'content-type': 'text/html' } });
  });
  assert.equal(await (await w.request('https://snag.test/')).text(), body);
  assert.deepEqual(w.writes, ['https://snag.test/index.html']);
  online = false;
  assert.equal(await (await w.request('https://snag.test/')).text(), body);
});

test('authentication HTML without the static marker is never cached', async () => {
  const w = worker(async () => new Response('<h1>Sign in</h1>', { headers: { 'content-type': 'text/html' } }));
  await w.request('https://snag.test/index.html');
  assert.equal(w.writes.length, 0);
});

test('withdrawal stops the current worker from intercepting requests', async () => {
  const w = worker(async () => new Response('body'));
  let complete;
  w.handlers.message({ data: { type: 'DISABLE_CACHE' }, waitUntil: promise => complete = promise });
  await complete;
  assert.equal(w.request('https://snag.test/index.html'), undefined);
});
