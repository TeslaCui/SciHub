const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const safety = require('../data-safety.js');

function harness() {
  const elements = new Map(), storage = new Map(), messages = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, textContent: '', hidden: false, value: '', innerHTML: '', disabled: false,
      addEventListener() {}, querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }),
      setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  };
  const localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  const window = { SciHubSafety: safety, addEventListener() {}, dispatchEvent() {}, confirm: () => true, localStorage };
  const context = vm.createContext({ window, SciHubSafety: safety, localStorage, console, structuredClone, setTimeout, clearTimeout,
    document: { getElementById: element, createElement: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    CustomEvent: class {}, state: { user: { id: '00000000-0000-0000-0000-000000000001' } },
    esc: (value) => String(value ?? ''), setStatus: (text) => messages.push(text), route() {}, showView() {}, openModal() {}, closeModal() {}, loadRecords: async () => {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'support/mock-supabase.js'), 'utf8'), context);
  context.client = window.supabase.createClient();
  let source = fs.readFileSync(path.join(__dirname, '..', 'experiment.js'), 'utf8');
  source = source.replace('  window.Run = {', '  window.__test = { run, saveStep, nextStep, finishRun, migrateStepValues, planDiff, dropExtraSteps, syncRunNow, buildLog };\n  window.Run = {');
  vm.runInContext(source, context);
  return { context, api: window.__test, messages, element };
}

async function fixture(h) {
  const client = h.context.client;
  const owner = h.context.state.user.id;
  const { data: run } = await client.from('experiment_runs').insert({ user_id: owner, title: '保存测试', status: 'running', current_step: 0, plan_id: 1 }).select().single();
  const { data: steps } = await client.from('run_steps').insert([0, 1].map((position) => ({ user_id: owner, run_id: run.id, position, title: position ? '干燥' : '称量', fields: [], values: {}, images: [], status: 'pending' }))).select();
  Object.assign(h.api.run, { id: run.id, data: run, steps, pos: 0 });
  return { client, run, steps };
}

test('failed step writes cannot advance the run', async () => {
  const h = harness(); const { client } = await fixture(h);
  const original = client.from.bind(client);
  client.from = (table) => {
    const query = original(table);
    if (table === 'run_steps') query.update = () => { query.execute = () => ({ error: { message: 'offline' }, data: null }); return query; };
    return query;
  };
  await h.api.nextStep();
  assert.equal(h.api.run.pos, 0);
  assert.equal(h.api.run.data.current_step, 0);
  assert.equal(h.context.window.Run.hasPending(), true);
});

test('a stale step version preserves local input and reports the conflict', async () => {
  const h = harness(); const { client, steps } = await fixture(h);
  await client.from('run_steps').update({ note: '他端内容' }).eq('id', steps[0].id);
  steps[0].values = { 质量: '0.5' };
  assert.equal(await h.api.saveStep(steps[0]), false);
  assert.equal(steps[0].values.质量, '0.5');
  assert.equal((await client.from('run_steps').select().eq('id', steps[0].id).single()).data.note, '他端内容');
  assert.match(h.messages.join(' '), /其他设备/);
});

test('saving an old run step never changes the new displayed run', async () => {
  const h = harness(); const { client, steps } = await fixture(h);
  const { data: other } = await client.from('experiment_runs').insert({ user_id: h.context.state.user.id, title: '另一实验', status: 'running', current_step: 0 }).select().single();
  h.api.run.id = other.id; h.api.run.data = other;
  steps[1].values = { 质量: 0 };
  assert.equal(await h.api.saveStep(steps[1]), true);
  assert.equal(h.api.run.data.current_step, 0);
  assert.equal((await client.from('experiment_runs').select().eq('id', steps[1].run_id).single()).data.current_step, 1);
});

test('an uncommitted completion never shows a completed experiment', async () => {
  const h = harness(); const { client } = await fixture(h);
  h.api.run.pos = 1;
  client.rpc = async () => ({ error: { message: 'log unavailable' } });
  await h.api.finishRun();
  assert.equal(h.api.run.data.status, 'running');
  assert.match(h.messages.join(' '), /完成实验未确认/);
});

test('completed runs are guarded from further saves', async () => {
  const h = harness(); const { client, run, steps } = await fixture(h);
  await client.from('experiment_runs').update({ status: 'done' }).eq('id', run.id);
  assert.equal(await h.api.saveStep(steps[0]), false);
  assert.match(h.messages.join(' '), /不能继续修改/);
});

test('a delayed render cannot restore an experiment after logout/reset', async () => {
  const h = harness(); const { client, run } = await fixture(h);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const original = client.from.bind(client);
  client.from = (table) => {
    const query = original(table);
    if (table === 'experiment_runs') {
      const execute = query.execute.bind(query);
      query.execute = async () => { const result = execute(); await gate; return result; };
    }
    return query;
  };
  const rendering = h.context.window.Run.render(run.id);
  await new Promise((resolve) => setImmediate(resolve));
  h.context.window.Run.reset(); release(); await rendering;
  assert.equal(h.api.run.id, null);
  assert.equal(h.api.run.data, null);
  assert.equal(h.api.run.steps.length, 0);
});

test('field migration preserves zero, old values and unit boundaries', () => {
  const h = harness();
  const out = h.api.migrateStepValues([{ label: '质量', unit: 'g' }], [{ label: '质量', unit: 'g' }], { 质量: 0, 历史: '保留' }, null);
  assert.equal(out.质量, 0); assert.equal(out.历史, '保留');
  assert.throws(() => h.api.migrateStepValues([{ label: '质量', unit: 'g' }], [{ label: '质量', unit: 'mg' }], { 质量: '1' }, null), /单位改变/);
});

test('extra-step deletion warning has the original values and attachments', async () => {
  const h = harness(); await fixture(h);
  h.api.run.steps.push({ id: 999, position: 2, title: '额外步骤', values: { 质量: '3' }, images: [{ path: 'fixture.jpg' }], note: '' });
  const diff = await h.api.planDiff(h.api.run.data);
  assert.equal(diff.removed[0].values.质量, '3');
  assert.equal(diff.removed[0].images.length, 1);
});
