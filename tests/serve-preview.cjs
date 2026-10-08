/* node tests/serve-preview.cjs [port]
 * /?mock=1 replaces only the SDK in the served HTML, without editing production files. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = new Set(['index.html', 'style.css', 'app.js', 'experiment.js', 'data-safety.js', 'merge.js', 'sw.js', 'manifest.json', 'version.json']);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = url.pathname.slice(1) || 'index.html';
  if (file === '__test__/mock-supabase.js') file = 'tests/support/mock-supabase.js';
  else if (!files.has(file)) { res.writeHead(404); res.end(); return; }
  let content = fs.readFileSync(path.join(root, file), 'utf8');
  if (url.searchParams.get('mock') === '1') {
    if (file === 'index.html') content = content.replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '/__test__/mock-supabase.js' + (url.searchParams.get('parallel') === '1' ? '?parallel=1' : '')).replace('src="app.js?v=1.0.4"', 'src="app.js?v=1.0.4&mock=1"').replace('<main>', '<main><p class="hint">本地回归测试 · 模拟数据 · 不连接真实数据库</p>');
    if (file === 'app.js') content = content.replace('\nregisterServiceWorker();', '\n/* Disabled for the mock preview. */');
  }
  res.writeHead(200, { 'Content-Type': (mime[path.extname(file)] || 'text/plain') + ';charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(content);
});
server.listen(Number(process.argv[2] || 8787), '127.0.0.1', () => console.log('Preview http://127.0.0.1:' + server.address().port + '/?mock=1'));
