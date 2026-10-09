const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const safety = require('../data-safety.js');

function parser(upstream) {
  const window = { SciHubSafety: safety, addEventListener() {}, dispatchEvent() {} };
  const element = { addEventListener() {} };
  const context = vm.createContext({ window, SciHubSafety: safety, console, setTimeout, clearTimeout,
    client: { functions: { invoke: async () => ({ data: upstream, error: null }) } },
    document: { getElementById: () => element, addEventListener() {} }, CustomEvent: class {} });
  const source = fs.readFileSync(path.join(__dirname, '../experiment.js'), 'utf8').replace('  window.Run = {',
    '  window.__parser = { parsePlan, parsePlanSmart, normalizePlan, formatChineseInstructions, guessDuration, mergePlanVersions, calcPyro, buildPyroSeq };\n  window.Run = {');
  vm.runInContext(source, context);
  return window.__parser;
}

test('source formatting keeps conditional clauses, decimal values, formulae and codes intact', () => {
  const api = parser();
  const source = '温度达到 80 ℃ 后，加入 0.50 g Fe(acac)₃；不得密闭（避免升压；原文提醒）。设置 C30-T60-C30--121。';
  const result = api.formatChineseInstructions(source);
  assert.equal(result, '温度达到 80 ℃ 后，加入 0.50 g Fe(acac)₃；\n不得密闭（避免升压；原文提醒）。\n设置 C30-T60-C30--121。');
  assert.equal(result.replace(/\n/g, ''), source);
});

test('fallback import preserves explicit process boundaries and measured field definitions', () => {
  const api = parser();
  const plan = api.parsePlan('虚构方案', ['一、干燥处理', '在 80 ℃ 干燥 2 h；记录实际质量：____ g。',
    '二、干燥处理后称量', '在 25 ℃ 称量。']);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].instruction, '在 80 ℃ 干燥 2 h；\n记录实际质量：____ g。');
  assert.equal(plan.steps[0].fields[0].label, '记录实际质量');
  assert.equal(plan.steps[0].fields[0].unit, 'g');
  assert.equal(plan.steps[1].instruction, '在 25 ℃ 称量。');
});

test('new duration hints preserve explicit values and leave vague or multiple waits for confirmation', () => {
  const api = parser();
  assert.equal(api.guessDuration('干燥过夜。'), '过夜（时长待确认）');
  assert.equal(api.guessDuration('搅拌 0.50 h。'), '0.50 h');
  assert.equal(api.guessDuration('搅拌 1 h；静置 2 h。'), '多段时长待确认：1 h；2 h');
  assert.equal(api.guessDuration('干燥 8-12 h。'), '时长范围待确认：8-12 h');
  assert.equal(api.guessDuration('干燥至少 8 h。'), '至少 8 h（时长待确认）');
  assert.equal(api.guessDuration('保持 > 2 h。'), '> 2 h（时长待确认）');
  assert.equal(api.guessDuration('保持 1e-3 h。'), '1e-3 h（时长待确认）');
});

test('fallback retains unnumbered content and treats numeric headings without splitting decimals', () => {
  const api = parser();
  const raw = '加入 1.5 g 试剂；搅拌过夜。';
  const plan = api.parsePlan('无编号方案', [raw]);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].instruction.replace(/\n/g, ''), raw);
  const numbered = api.parsePlan('编号方案', ['先检查容器。', '1. 加料', '加入 1.5 g 试剂。', '2. 干燥']);
  assert.equal(numbered.steps.length, 2);
  assert.match(numbered.steps[0].instruction, /先检查容器/);
  assert.match(numbered.steps[0].instruction, /1\.5 g/);
  assert.equal(numbered.steps[1].instruction, '干燥');
});

test('version upload never swaps adjacent steps with similar titles or guesses ambiguous matches', async () => {
  const api = parser();
  const old = [{ title: '干燥处理', instruction: '80 ℃ 干燥 2 h。', fields: [{ label: '干燥温度', unit: '℃', type: 'number' }] },
    { title: '干燥处理后记录', instruction: '记录干燥后的质量。', fields: [{ label: '干燥后质量', unit: 'g', type: 'number' }] }];
  const result = await api.mergePlanVersions(old, old.map(step => ({ ...step, fields: step.fields.map(field => ({ ...field })) })));
  assert.deepEqual(Array.from(result.steps, step => step.title), ['干燥处理', '干燥处理后记录']);
  assert.deepEqual(Array.from(result.steps, step => step.fields[0].label), ['干燥温度', '干燥后质量']);
  const ambiguous = await api.mergePlanVersions(old, [{ title: '干燥处理新工序', instruction: '120 ℃ 干燥 4 h。', fields: [] }]);
  assert.equal(ambiguous.stats.newCount, 1);
  assert.equal(ambiguous.stats.userKept, 2);
  assert.equal(ambiguous.steps[0].fields.length, 0);
  assert.equal(ambiguous.steps.length, 3);
  const changed = await api.mergePlanVersions(old, [{...old[0], title:'改名后的工序', fields:[{label:'干燥温度',unit:'K',type:'number'}]}]);
  assert.equal(changed.steps[0].title,'干燥处理');
  assert.equal(changed.steps[0].fields[0].unit,'℃');
});

test('a new client falls back while the old parser is deployed and accepts the marked Chinese protocol response', async () => {
  const output = { title: '中文方案', steps: [{ title: '干燥', instruction: '在 80 ℃ 干燥 2 h。',
    fields: [], notice: '', duration_hint: '2 h' }] };
  assert.equal(await parser(output).parsePlanSmart('在 80 ℃ 干燥 2 h。'), null);
  const plan = await parser({ ...output, writing_format: 'chemical-procedure-zh-v1' }).parsePlanSmart('在 80 ℃ 干燥 2 h。');
  assert.equal(plan.steps[0].instruction, output.steps[0].instruction);
  assert.equal(parser().normalizePlan({ ...output, steps: [{ ...output.steps[0], duration_hint: '过夜' }] }).steps[0].duration_hint, '过夜（时长待确认）');
});

test('pyro calculator accepts zero Celsius and rejects missing or non-positive inputs', () => {
  const api = parser();
  const sequence = 'C25-T55-C300-T60-C300';
  assert.equal(api.calcPyro(sequence, 0, 5, 300).total, 120);
  assert.equal(api.buildPyroSeq(sequence, 0, 5, 300), 'C0-T60-C300-T60-C300');
  for (const values of [['', 5, 300], [0, '', 300], [0, -1, 300], [0, 5, '']]) {
    assert.equal(api.calcPyro(sequence, ...values), null);
    assert.equal(api.buildPyroSeq(sequence, ...values), '');
  }
});
