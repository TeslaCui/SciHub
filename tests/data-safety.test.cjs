const test = require('node:test');
const assert = require('node:assert/strict');
const safety = require('../data-safety.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('steps debounce independently, including rapid navigation', async () => {
  const writes = [];
  const queue = safety.createSaveQueue(async (step) => writes.push([step.id, step.value]), { delay: 5000 });
  queue.schedule({ id: 1, run_id: 10, value: 'first' });
  queue.schedule({ id: 2, run_id: 10, value: 'second' });
  await queue.flushAll();
  assert.deepEqual(writes.sort(), [[1, 'first'], [2, 'second']]);
  assert.equal(queue.hasPending(), false);
});

test('an edit during an in-flight save is serialized and written afterwards', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const values = [];
  const queue = safety.createSaveQueue(async (step) => {
    values.push(step.value);
    if (values.length === 1) await gate;
  }, { delay: 5000 });
  const step = { id: 1, run_id: 10, value: 'old' };
  const saving = queue.save(step);
  await tick();
  step.value = 'new'; queue.schedule(step);
  release(); await saving; await queue.flushAll();
  assert.deepEqual(values, ['old', 'new']);
  assert.equal(queue.hasPending(), false);
});

test('network errors retain dirty state and can be retried', async () => {
  let failed = true;
  const queue = safety.createSaveQueue(async () => { if (failed) throw Error('offline'); });
  const step = { id: 1, run_id: 10 };
  await assert.rejects(queue.save(step), /offline/);
  assert.equal(queue.isDirty(step), true);
  failed = false; await queue.flushAll();
  assert.equal(queue.hasPending(), false);
});

test('identical step ids belonging to different runs never share a timer', async () => {
  const writes = [];
  const queue = safety.createSaveQueue(async (step) => writes.push(step.run_id), { delay: 5000 });
  queue.schedule({ id: 1, run_id: 10 }); queue.schedule({ id: 1, run_id: 11 });
  await queue.flushAll(); assert.deepEqual(writes.sort(), [10, 11]);
});

test('formula-like CSV cells are escaped but ordinary data stays intact', () => {
  for (const text of ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '  =1', '\t=1']) assert.equal(safety.csvCell(text).startsWith('"\''), true);
  assert.equal(safety.csvCell('普通 "实验"'), '"普通 ""实验"""');
  assert.equal(safety.csvCell(0), '"0"');
});

test('a reordered or inserted operation cannot receive old experimental values', () => {
  const original = [{ position: 0, title: '称量' }, { position: 1, title: '干燥' }];
  assert.throws(() => safety.assertSafeStepSync([{ position: 0, title: '干燥' }, { position: 1, title: '称量' }], original), /原快照/);
  assert.throws(() => safety.assertSafeStepSync([{ position: 0, title: '称量' }, { position: 1, title: '洗涤' }, { position: 2, title: '干燥' }], original), /原快照/);
  assert.doesNotThrow(() => safety.assertSafeStepSync([...original, { position: 2, title: '分析' }], original));
});

test('duplicate labels are blocked before two values can overwrite each other', () => {
  assert.throws(() => safety.validateFields([{ fields: [{ label: '质量' }, { label: ' 质量 ' }] }]), /重复字段/);
  assert.throws(() => safety.validateFields([{ fields: [{ label: '__proto__' }] }]), /修改字段/);
});

test('reordering identically named steps with different conditions is blocked', () => {
  const original = [{ position: 0, title: '干燥', instruction: '80 ℃' }, { position: 1, title: '干燥', instruction: '120 ℃' }];
  const changed = original.map((step, index) => ({ ...original[1 - index], position: index }));
  assert.throws(() => safety.assertSafeStepSync(changed, original), /重复步骤名/);
  assert.doesNotThrow(() => safety.assertSafeStepSync(original, original));
});

test('association components do not depend on recency order', () => {
  const runs = [{ id: 3 }, { id: 2 }, { id: 1 }, { id: 4 }];
  const groups = safety.groupsOf(runs, { 1: [{ link_run_id: 2, position: 0 }], 2: [{ link_run_id: 3, position: 0 }] });
  assert.deepEqual(groups.map((g) => g.runs.map((r) => r.id).sort()), [[1, 2, 3], [4]]);
  assert.equal(groups[0].links.length, 2);
});

test('link comparison includes temperature, time, units and instructions', () => {
  assert.notEqual(safety.stepSignature({ title: '干燥', instruction: '80 ℃ 12 h' }), safety.stepSignature({ title: '干燥', instruction: '120 ℃ 12 h' }));
  assert.notEqual(safety.stepSignature({ title: '称量', fields: [{ label: '质量', unit: 'g' }] }), safety.stepSignature({ title: '称量', fields: [{ label: '质量', unit: 'mg' }] }));
});

test('local date does not shift a calendar day through UTC conversion', () => {
  const date = { getFullYear: () => 2026, getMonth: () => 9, getDate: () => 8 };
  assert.equal(safety.localDate(date), '2026-10-08');
});
