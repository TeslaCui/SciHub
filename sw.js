/* Service Worker：全部走 network-first。
 *
 * 为什么不用 cache-first：本站的内容随每次发布更新，而用户拿到旧版 JS 会陷入
 * 「提示有新版本却怎么都更新不了」的死循环（HTTP 缓存 + SW 缓存双重拦截）。
 * 现在一律先请求网络；成功就顺手把响应写进缓存，失败才回退缓存（离线兜底）。
 *
 * 改版时同步更新下面 CACHE 的版本号、version.json，以及 index.html 里的 ?v= 参数。
 */
const CACHE = 'scihub-research-v0.22.0';
const ASSETS = [
  './index.html',
  './style.css?v=0.22.0',
  './app.js?v=0.22.0',
  './experiment.js?v=0.22.0',
  './manifest.json?v=0.22.0',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase / CDN 始终走网络

  // HTML 强制绕过 HTTP 缓存：HTML 里的 ?v= 参数决定了资源 URL，
  // 若 HTML 本身被缓存住，新版本就永远传不下去。
  const isDocument = request.mode === 'navigate' || request.destination === 'document';
  const target = isDocument ? new Request(request, { cache: 'no-store' }) : request;

  event.respondWith(
    fetch(target)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html')))
  );
});
