/* Run before a release; staged mode verifies the exact bytes being committed. */
const fs = require('node:fs');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const staged = process.argv.includes('--staged');
const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8' });
const read = (file) => staged ? git('show', ':' + file) : fs.readFileSync(file, 'utf8');
require('./build-guide.cjs').check(read);
const version = JSON.parse(read('version.json')).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.ok(version.split('.').every((part) => Number(part) < 10), '版本段应按项目约定进位');
assert.ok(read('app.js').includes("const APP_VERSION = '" + version + "'"));
assert.ok(read('sw.js').includes("const CACHE = 'scihub-research-v" + version + "'"));
for (const file of ['index.html', 'sw.js']) {
  const source = read(file);
  const versions = [...source.matchAll(/\?v=([\d.]+)/g)].map((match) => match[1]);
  assert.ok(versions.length && versions.every((value) => value === version), file + ' 资源版本不一致');
  for (const resource of ['data-safety.js', 'merge.js', 'platinum.js']) assert.ok(source.includes(resource + '?v=' + version), file + ' 缺少资源 ' + resource);
}
if (staged) {
  const files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR').trim().split('\n').filter(Boolean);
  for (const file of files) {
    assert.ok(!/(^|\/)(\.env(?:\..*)?|node_modules|outputs|\.temp)(\/|$)|\.(log|tmp|bak)$/.test(file), '禁止提交本机配置或临时文件：' + file);
    const source = read(file);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----|sb_secret_[A-Za-z0-9_-]{15,}|postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/.test(source), '发现疑似私钥或数据库凭据：' + file);
    for (const match of source.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
      const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString());
      assert.notEqual(payload.role, 'service_role', '禁止提交 service_role：' + file);
    }
  }
  const frontend = files.some((file) => /^(app\.js|experiment\.js|platinum\.js|data-safety\.js|merge\.js|style\.css|index\.html|sw\.js|guide\.(html|css|js))$/.test(file));
  if (frontend) {
    const previous = JSON.parse(git('show', 'HEAD:version.json')).version.split('.').map(Number);
    previous[2]++;
    for (let i = 2; i > 0; i--) if (previous[i] >= 10) { previous[i] = 0; previous[i - 1]++; }
    assert.equal(version, previous.join('.'), '前端发版必须递增版本');
  }
}
console.log('发布检查通过：v' + version + (staged ? '（暂存内容）' : ''));
