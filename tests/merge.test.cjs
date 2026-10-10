const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const safety = require('../data-safety.js');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../merge.js'), 'utf8'), { window, SciHubSafety: safety });
const api = window.Merges;
function fixture() {
  const rows = [{ id: 1, title: 'A', status: 'running' }, { id: 2, title: 'B', status: 'running' }];
  const steps = (runId) => Array.from({ length: 6 }, (_, position) => ({ run_id: runId, position, title: '步骤 ' + position,
    instruction: position === 3 ? '80 ℃ 12 h' : '', fields: [{ label: '质量', unit: 'g' }], status: position < 3 ? 'done' : 'pending', values: position < 3 ? { 质量: runId } : {}, images: [] }));
  return { rows, steps: { 1: steps(1), 2: steps(2) } };
}
test('parallel branches may have distinct measured values and share a clean suffix', () => {
  const f = fixture(); assert.equal(api.reviewLocal(f.rows, f.steps, 2).firstShared, 4);
});
test('both prefix and suffix definitions are mandatory gates', () => {
  for (const position of [0, 5]) {
    const f = fixture(); f.steps[2][position].instruction = '不同操作';
    assert.throws(() => api.reviewLocal(f.rows, f.steps, 2), /不一致/);
  }
});
test('unit case is significant and checklist definitions must match', () => {
  const f = fixture(); f.steps[1][1].fields[0].unit = 'M'; f.steps[2][1].fields[0].unit = 'm';
  assert.throws(() => api.reviewLocal(f.rows, f.steps, 2), /不一致/);
  const g = fixture(); g.steps[2][1].checklist = ['已冷却'];
  assert.throws(() => api.reviewLocal(g.rows, g.steps, 2), /不一致/);
});
test('unfinished prefix, data-bearing suffix and repeat merges are blocked', () => {
  const f = fixture(); f.steps[2][2].status = 'pending';
  assert.throws(() => api.reviewLocal(f.rows, f.steps, 2), /尚未完成/);
  f.steps[2][2].status = 'done'; f.steps[2][4].values = { 质量: 0 };
  assert.throws(() => api.reviewLocal(f.rows, f.steps, 2), /已有后续记录/);
  f.steps[2][4].values = {}; f.rows[1]._merge = { id: 1 };
  assert.throws(() => api.reviewLocal(f.rows, f.steps, 2), /尚未合并/);
});
test('shared stage displays the original protocol numbering', () => {
  assert.equal(api.number({ _mergeOffset: 3 }, 0), 4);
  assert.equal(api.number({ _mergeOffset: 3 }, 2), 6);
});

test('browsing a pending suffix with empty field keys and auto times permits review', () => {
  const f = fixture();
  f.rows[0].current_step = 5;
  f.rows[1].current_step = 4;
  f.steps[1][3].values = { 质量: '', 时间: null, 备注: ' \n\t　' };
  f.steps[1][3].started_at = '2026-10-09T02:00:00Z';
  f.steps[1][3].checks = { 已完成: false };
  assert.equal(api.reviewLocal(f.rows,f.steps,2).firstShared,4);
  assert.equal(safety.progressPosition(f.steps[1]),2);
  const legacyActive = fixture(); legacyActive.steps[1][3].status = 'active';
  legacyActive.steps[1][3].started_at = '2026-10-09T02:00:00Z';
  assert.equal(api.reviewLocal(legacyActive.rows, legacyActive.steps, 2).firstShared, 4);
  for (const item of [{values:{质量:0}},{values:{质量:'0'}},{note:'实际操作'},
    {images:[{path:'fictional/photo.jpg'}]},{checks:{核对:true}}]) {
    const g=fixture(); Object.assign(g.steps[1][3],item);
    assert.throws(()=>api.reviewLocal(g.rows,g.steps,2),/已有后续记录/);
  }
  for (const item of [{status:'done'},{finished_at:'2026-10-09T03:00:00Z'},
    {checks:{unexpected:0}},{checks:'legacy-record'}]) {
    const g=fixture(); Object.assign(g.steps[1][3],item);
    assert.equal(api.reviewLocal(g.rows,g.steps,2).firstShared,4);
  }
});
