const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadProxy(name, upstream = {}, authenticated = true) {
  const ts = require(process.env.TYPESCRIPT_MODULE);
  const calls = [];
  let handler;
  const context = { exports: {}, Response, Request, Headers, AbortSignal, TextDecoder, console,
    Deno: { env: { get: (key) => ({ SUPABASE_URL: 'https://auth.example.test', SUPABASE_ANON_KEY: 'fixture-public-key', DEEPSEEK_API_KEY: 'fixture-server-key' })[key] }, serve: (fn) => { handler = fn; } },
    fetch: async (url) => {
      calls.push(url);
      if (url.includes('/auth/v1/user')) return Response.json(authenticated ? { id: 'fixture-user' } : {}, { status: authenticated ? 200 : 401 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(upstream) } }] });
    } };
  const compile = (file) => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sharedContext = vm.createContext({ ...context, exports: {} });
  vm.runInContext(compile(path.join(__dirname, '../supabase/functions/_shared/ai.ts')), sharedContext);
  const proxyContext = vm.createContext({ ...context, require: () => sharedContext.exports });
  vm.runInContext(compile(path.join(__dirname, '../supabase/functions', name, 'index.ts')), proxyContext);
  return { calls, request: (body, token = 'fixture-user-token') => handler(new Request('https://local.example.test/' + name, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: JSON.stringify(body) })) };
}

test('AI proxies require an actual user before calling the paid upstream', { skip: !process.env.TYPESCRIPT_MODULE }, async () => {
  for (const name of ['parse-plan', 'check-link', 'match-params', 'todo-plan']) {
    const proxy = loadProxy(name, {}, false);
    assert.equal((await proxy.request({ text: 'test' })).status, 401);
    assert.equal(proxy.calls.some((url) => url.includes('deepseek')), false);
    assert.equal((await proxy.request({}, '')).status, 401);
  }
});

test('same titles with different operating conditions cannot be merged', { skip: !process.env.TYPESCRIPT_MODULE }, async () => {
  const proxy = loadProxy('check-link', { same: true });
  const response = await proxy.request({ mine: [{ title: '干燥', instruction: '80 ℃ 12 h' }], other: [{ title: '干燥', instruction: '120 ℃ 12 h' }] });
  assert.equal((await response.json()).same, false);
  assert.equal(proxy.calls.some((url) => url.includes('deepseek')), false);
});

test('AI field matching enforces one-to-one pairs', { skip: !process.env.TYPESCRIPT_MODULE }, async () => {
  const proxy = loadProxy('match-params', { pairs: [{ from: 'a', to: 'x' }, { from: 'b', to: 'x' }, { from: 'a', to: 'y' }] });
  const response = await proxy.request({ old: ['a', 'b'], new: ['x', 'y'] });
  assert.deepEqual((await response.json()).pairs, [{ from: 'a', to: 'x' }]);
});

test('AI durations must match the exact input step count', { skip: !process.env.TYPESCRIPT_MODULE }, async () => {
  const proxy = loadProxy('parse-plan', { durations: ['1 h'] });
  assert.equal((await proxy.request({ mode: 'duration', steps: [{ title: 'a' }, { title: 'b' }] })).status, 502);
});

test('oversized AI payloads are rejected before upstream execution', { skip: !process.env.TYPESCRIPT_MODULE }, async () => {
  const proxy = loadProxy('parse-plan');
  const response = await proxy.request({ text: 'x'.repeat(300000) });
  assert.notEqual(response.status, 200);
  assert.equal(proxy.calls.some((url) => url.includes('deepseek')), false);
});

test('all Edge Functions pass TypeScript checking against the Deno surface', { skip: !process.env.TYPESCRIPT_MODULE }, () => {
  const ts = require(process.env.TYPESCRIPT_MODULE);
  const root = path.join(__dirname, '..');
  const files = ['parse-plan', 'check-link', 'match-params', 'todo-plan'].map((name) => path.join(root, 'supabase/functions', name, 'index.ts'));
  files.push(path.join(__dirname, 'support/deno-env.d.ts'));
  const program = ts.createProgram(files, { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: (file) => file, getNewLine: () => '\n' }));
});
