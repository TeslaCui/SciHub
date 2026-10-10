'use strict';

/* Shared data rules. Kept independent of the DOM so failure paths can be tested. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SciHubSafety = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  function localDate(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function meaningfulValue(value) {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return true;
    if (typeof value === 'object') return Object.values(value).some(meaningfulValue);
    return false;
  }
  function checksHaveRecord(checks) {
    const values = checks && typeof checks === 'object' && !Array.isArray(checks) ? Object.values(checks) : [checks];
    return values.some(value => value === true || value === 'true');
  }
  function stepHasInput(step) {
    if (!step) return false;
    return valueHasRecordedInput(step.values) || String(step.note || '').trim().length > 0
      || (Array.isArray(step.images) && step.images.length > 0)
      || checksHaveRecord(step.checks);
  }
  function valueHasRecordedInput(value) {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return value === true;
    if (Array.isArray(value)) return value.some(valueHasRecordedInput);
    if (typeof value === 'object') return Object.values(value).some(valueHasRecordedInput);
    return false;
  }
  function stepEvidence(step) {
    if (!step) return { input: false, completion: false, completionOnly: false, recorded: false, reasons: [] };
    const input = valueHasRecordedInput(step.values) || String(step.note || '').trim().length > 0
      || (Array.isArray(step.images) && step.images.length > 0)
      || checksHaveRecord(step.checks);
    const completion = step.status === 'done' || !!step.finished_at;
    const reasons = [];
    if (valueHasRecordedInput(step.values)) reasons.push('有效填写');
    if (String(step.note || '').trim()) reasons.push('备注');
    if (Array.isArray(step.images) && step.images.length) reasons.push('附件');
    if (checksHaveRecord(step.checks)) reasons.push('勾选记录');
    if (completion) reasons.push('完成标记');
    return { input, completion, completionOnly: completion && !input, recorded: input || completion, reasons };
  }
  function stepRecordReasons(step) {
    if (!step) return [];
    const reasons = [];
    if (stepHasInput(step)) reasons.push('有效填写');
    if (checksHaveRecord(step.checks)) reasons.push('勾选记录');
    if (Array.isArray(step.images) && step.images.length) reasons.push('附件');
    if (step.status === 'done') reasons.push('已完成');
    if (step.finished_at) reasons.push('完成时间');
    return reasons;
  }
  // Completion is an explicit audit fact, even for a step with no measurements.
  // Auto-created start times, browse positions and legacy active states are not input.
  function stepHasRecord(step) {
    return stepRecordReasons(step).length > 0;
  }
  function progressPosition(steps) {
    let reached = -1;
    (steps || []).forEach((step, i) => { if (stepHasInput(step)) reached = i; });
    return reached;
  }

  function csvCell(value) {
    let text = String(value == null ? '' : value);
    // Quoting alone does not prevent Excel from executing a formula.
    if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function validateFields(steps) {
    for (const [index, step] of steps.entries()) {
      const labels = new Set();
      for (const field of step.fields || []) {
        const label = String(field.label || '').trim();
        if (!label) continue;
        if (labels.has(label)) throw new Error('第 ' + (index + 1) + ' 步存在重复字段「' + label + '」，请改为不同名称。');
        if (['__proto__', 'constructor', 'prototype'].includes(label)) throw new Error('请修改字段名称「' + label + '」。');
        labels.add(label);
        field.label = label;
      }
    }
  }

  function assertSafeStepSync(planSteps, runSteps) {
    const byPosition = new Map(planSteps.map((step) => [Number(step.position), step]));
    const lastPlan = Math.max(-1, ...planSteps.map((step) => Number(step.position)));
    for (const step of runSteps) {
      const current = byPosition.get(Number(step.position));
      // Position is not an identity. Fail closed instead of assigning old values
      // to a different operation after insertion, renaming or reordering.
      if ((current && String(current.title).trim() !== String(step.title).trim())
        || (!current && Number(step.position) <= lastPlan)) {
        throw new Error('方案步骤的名称或顺序已改变。为避免数据对应到错误工序，本次实验保留原快照；请用新方案开始实验。');
      }
    }
    const titles = planSteps.map((step) => String(step.title).trim());
    const duplicateTitles = new Set(titles.filter((title, index) => titles.indexOf(title) !== index));
    if (duplicateTitles.size && (JSON.stringify(planSteps.map((s) => s.title)) !== JSON.stringify(runSteps.map((s) => s.title))
      || runSteps.some((step) => duplicateTitles.has(String(step.title).trim()) && stepSignature(step) !== stepSignature(byPosition.get(Number(step.position)) || {})))) {
      throw new Error('方案有重复步骤名且结构发生变化，无法安全对应原实验数据。');
    }
  }

  function stepSignature(step) {
    const normalize = (value) => String(value || '').replace(/\s+/g, '');
    return JSON.stringify([normalize(step.title), normalize(step.instruction), normalize(step.notice),
      normalize(step.pyro_seq), normalize(step.duration_hint),
      (step.fields || []).map((field) => [normalize(field.label), normalize(field.unit), field.type || 'text']),
      step.checklist || []]);
  }

  // Merge review allows harmless wording differences in parallel branches,
  // while preserving a strict comparison for the shared suffix. Quantities
  // in a completed branch can differ by scale; temperatures, times, pH,
  // concentrations, atmosphere and other control conditions cannot.
  function mergeText(value, stripBranchNumbers = false) {
    let text = String(value == null ? '' : value).normalize('NFKC').toLowerCase();
    const synonyms = [
      [/称取/g, '称量'], [/加入/g, '添加'], [/倒入/g, '添加'],
      [/添加到/g, '添加'], [/添加入/g, '添加'],
      [/离心分离/g, '离心'], [/烘干/g, '干燥'], [/清洗/g, '洗涤'],
      [/摄氏度/g, '℃'], [/°c/g, '℃'], [/度/g, '℃'], [/小时/g, 'h'], [/分钟/g, 'min'],
    ];
    synonyms.forEach(([from, to]) => { text = text.replace(from, to); });
    if (stripBranchNumbers) text = text.replace(/[-+]?\d+(?:\.\d+)?/g, '#');
    return text.replace(/[并将]/g, '').replace(/[\s，。；：、（）()【】\[\]{}「」『』<>《》,.;:!?！？/\\]+/g, '');
  }

  function mergeCriticalText(value) {
    const text = String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(/摄氏度|°c/g, '℃');
    const matches = text.match(/[-+]?\d+(?:\.\d+)?\s*(?:℃|°c|c\b|k\b|小时|h\b|天|分钟|min\b|秒|s\b|rpm|转(?:\/分钟)?|ph\b|%|mol(?:\/l)?|m\b|bar|kpa|mpa|pa\b)/gi) || [];
    return matches.map((item) => item.replace(/\s+/g, '')).join('|');
  }

  function mergeStepSignature(step = {}, { branch = false } = {}) {
    const text = [step.title, step.instruction, step.notice].join('|');
    const fields = (step.fields || []).map((field) => [
      mergeText(field.label), String(field.unit == null ? '' : field.unit).normalize('NFKC').replace(/\s+/g, ''), field.type || 'text',
    ]);
    return {
      wording: mergeText(text, branch),
      exactText: mergeText(text),
      critical: mergeCriticalText(text),
      pyro_seq: mergeText(step.pyro_seq),
      duration_hint: mergeText(step.duration_hint),
      fields,
      checklist: (step.checklist || []).slice().sort(),
    };
  }

  function mergeStepDifference(left, right, { branch = false } = {}) {
    const a = mergeStepSignature(left, { branch }), b = mergeStepSignature(right, { branch });
    const structural = ['pyro_seq', 'duration_hint', 'fields', 'checklist'];
    const sameStructure = structural.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
    const sameOperation = a.wording === b.wording && a.critical === b.critical;
    return {
      same: sameStructure && sameOperation,
      textOnly: sameStructure && sameOperation && a.exactText !== b.exactText,
      a, b,
    };
  }
  function progressSummary(steps, currentStep = 0) {
    const list = steps || [];
    const inputPositions = [], completionOnly = [];
    list.forEach((step, index) => {
      const evidence = stepEvidence(step);
      if (evidence.input) inputPositions.push(index);
      else if (evidence.completionOnly) completionOnly.push(index);
    });
    const lastInput = inputPositions.length ? Math.max(...inputPositions) : -1;
    const uncertain = completionOnly.filter(index => index > lastInput);
    const cursor = Math.max(0, Math.min(Number.isFinite(Number(currentStep)) ? Math.trunc(Number(currentStep)) : 0, Math.max(0, list.length - 1)));
    return { lastInput, inputPositions, completionOnly, uncertain, cursor, hasInput: lastInput >= 0 };
  }
  function mergeEvidence(steps, after) {
    const prefixWarnings = [], suffixBlockers = [], suffixWarnings = [];
    (steps || []).forEach((step, index) => {
      const evidence = stepEvidence(step);
      if (index <= after && !evidence.completion) prefixWarnings.push({ position: index, reason: '尚未确认完成' });
      if (index <= after && evidence.completionOnly) prefixWarnings.push({ position: index, reason: '只有完成标记，没有有效填写' });
      if (index > after && evidence.input) suffixBlockers.push({ position: index, reasons: evidence.reasons });
      if (index > after && evidence.completionOnly) suffixWarnings.push({ position: index, reason: '只有完成标记和时间，可能是浏览产生的旧状态' });
    });
    return { allowed: !prefixWarnings.some(item => item.reason === '尚未确认完成') && suffixBlockers.length === 0, prefixWarnings, suffixBlockers, suffixWarnings };
  }

  function updateStepSchema(step = {}) {
    const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return stable({ title: step.title || '', instruction: step.instruction || '', notice: step.notice || '',
      pyro_seq: step.pyro_seq || '', duration_hint: step.duration_hint || '',
      fields: (step.fields || []).map(field => ({ ...field, unit: field.unit || '', type: field.type || '' })),
      checklist: (step.checklist || Object.keys(step.checks || {})).slice().sort() });
  }

  function planUpdateChanges(before, after) {
    const names = { title: '标题', instruction: '说明', notice: '注意事项', pyro_seq: '热解程序', duration_hint: '时长', fields: '字段', checklist: '完成确认' };
    return Array.from({ length: Math.max(before.length, after.length) }, (_, position) => {
      const old = before[position], next = after[position];
      const a = updateStepSchema(old), b = updateStepSchema(next);
      const what = Object.keys(names).filter(key => JSON.stringify(a[key]) !== JSON.stringify(b[key])).map(key => names[key]);
      return { position, old, next, what, action: !old ? '新增' : !next ? '移除' : '修改' };
    }).filter(change => !change.old || !change.next || change.what.length);
  }

  function reviewPlanUpdate(candidate, runs, stepMap) {
    const issues = [], reviewed = [];
    for (const run of runs.filter(item => item.status === 'running' && !item._mergedInto)) {
      const steps = (stepMap[run.id] || []).slice().sort((a, b) => a.position - b.position);
      const evidence = steps.filter(step => step.status === 'done' || step.finished_at || stepHasInput(step));
      const locked = Math.max(-1, ...evidence.map(step => step.position));
      for (let position = 0; position <= locked; position++) {
        const step = steps.find(item => item.position === position);
        if (!step || !candidate[position] || JSON.stringify(updateStepSchema(step)) !== JSON.stringify(updateStepSchema(candidate[position]))) {
          issues.push({ run_id: run.id, title: run.title, position, reason: '已完成、当前或已有记录的步骤定义不一致' });
        }
      }
      reviewed.push({ id: run.id, title: run.title, locked_through: locked, updated_at: run.updated_at,
        steps: steps.map(step => ({ id: step.id, position: step.position, updated_at: step.updated_at })) });
    }
    return { allowed: !issues.length, issues, runs: reviewed };
  }

  function groupsOf(runs, stepMap) {
    const byId = new Map(runs.map((run) => [String(run.id), run]));
    const neighbors = new Map(runs.map((run) => [String(run.id), new Set()]));
    const links = [];
    for (const run of runs) {
      for (const step of stepMap[run.id] || []) {
        if (!step.link_run_id || !byId.has(String(step.link_run_id))) continue;
        const from = String(run.id), to = String(step.link_run_id);
        neighbors.get(from).add(to);
        neighbors.get(to).add(from);
        links.push({ from: run.id, to: step.link_run_id, position: step.position, note: step.link_note });
      }
    }
    const seen = new Set(), groups = [];
    for (const run of runs) {
      if (seen.has(String(run.id))) continue;
      const ids = new Set(), pending = [String(run.id)];
      while (pending.length) {
        const id = pending.pop();
        if (ids.has(id)) continue;
        ids.add(id); seen.add(id);
        pending.push(...neighbors.get(id));
      }
      groups.push({ runs: [...ids].map((id) => byId.get(id)), links: links.filter((link) => ids.has(String(link.from))) });
    }
    return groups;
  }

  function createSaveQueue(write, { delay = 1000, onError = () => {} } = {}) {
    const entries = new Map();
    const keyOf = (step) => String(step.run_id) + ':' + step.id;
    function entryFor(step) {
      const key = keyOf(step);
      if (!entries.has(key)) entries.set(key, { step, revision: 0, saved: 0, timer: null, promise: null });
      const entry = entries.get(key);
      entry.step = step;
      return entry;
    }
    function schedule(step) {
      const entry = entryFor(step);
      entry.revision++;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        flushEntry(entry).catch((error) => onError(error, step));
      }, delay);
    }
    async function flushEntry(entry) {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      if (entry.promise) return entry.promise;
      entry.promise = (async () => {
        while (entry.saved < entry.revision) {
          const revision = entry.revision;
          await write(entry.step);
          entry.saved = revision;
        }
      })();
      try { await entry.promise; }
      finally { entry.promise = null; }
    }
    async function save(step) {
      const entry = entryFor(step);
      entry.revision++;
      await flushEntry(entry);
    }
    async function flushAll() {
      await Promise.all([...entries.values()].map(flushEntry));
    }
    function isDirty(step) {
      const entry = entries.get(keyOf(step));
      return !!entry && (entry.saved < entry.revision || !!entry.promise);
    }
    return { schedule, save, flushAll, isDirty, hasPending: () => [...entries.values()].some((e) => e.saved < e.revision || !!e.promise) };
  }

  return { localDate, meaningfulValue, checksHaveRecord, stepHasInput, valueHasRecordedInput, stepEvidence, stepRecordReasons, stepHasRecord, progressPosition, progressSummary, mergeEvidence, csvCell, validateFields, assertSafeStepSync, stepSignature, mergeText, mergeCriticalText, mergeStepSignature, mergeStepDifference, updateStepSchema, planUpdateChanges, reviewPlanUpdate, groupsOf, createSaveQueue };
});
