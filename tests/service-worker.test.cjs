const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function worker(fetch) {
  const handlers = {}, removed = [], writes = [];
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../sw.js'), 'utf8'), {
    Request, Response, URL, fetch,
    self: { location: { origin: 'https://example.test' }, skipWaiting() {}, clients: { claim() {} }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    caches: { keys: async () => ['scihub-research-v0.9.9', 'other-app-v1', 'scihub-research-v' + JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../version.json'), 'utf8')).version], delete: async (key) => removed.push(key),
      open: async () => ({ put: async (...args) => writes.push(args), addAll: async () => {} }),
      match: async (request) => request === './index.html' ? new Response('<html>cached</html>')
        : request === './guide.html?v=' + JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../version.json'), 'utf8')).version
          ? new Response('<html>cached guide</html>') : undefined },
  });
  return { handlers, removed, writes };
}
test('activation only removes old SciHub caches', async () => {
  const w = worker(); let promise;
  w.handlers.activate({ waitUntil: (value) => { promise = value; } }); await promise;
  assert.deepEqual(w.removed, ['scihub-research-v0.9.9']);
});
test('offline asset failure cannot return HTML as JavaScript', async () => {
  const w = worker(async () => { throw Error('offline'); }); let promise;
  w.handlers.fetch({ request: new Request('https://example.test/app.js'), respondWith: (value) => { promise = value; } });
  assert.equal((await promise).type, 'error');
});
test('failed responses are never cached and remote APIs are bypassed', async () => {
  const w = worker(async () => new Response('failed', { status: 503 })); let promise;
  w.handlers.fetch({ request: new Request('https://example.test/app.js'), respondWith: (value) => { promise = value; } });
  assert.equal((await promise).status, 503); assert.equal(w.writes.length, 0);
  w.handlers.fetch({ request: new Request('https://api.example.test/data'), respondWith: () => assert.fail('API intercepted') });
});

test('offline guide navigation returns the cached guide instead of the app page', async () => {
  const w = worker(async () => { throw Error('offline'); }); let promise;
  const request = new Request('https://example.test/guide.html');
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  w.handlers.fetch({ request, respondWith: value => { promise = value; } });
  assert.equal(await (await promise).text(), '<html>cached guide</html>');
});
