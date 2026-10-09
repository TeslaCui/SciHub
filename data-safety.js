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
    return values.some(value => value !== false && value !== 'false' && meaningfulValue(value));
  }
  function stepHasInput(step) {
    if (!step) return false;
    return meaningfulValue(step.values) || String(step.note || '').trim().length > 0
      || (Array.isArray(step.images) && step.images.length > 0)
      || Object.values(step.checks || {}).some(value => value === true || value === 'true');
  }
  // Completion is an explicit audit fact, even for a step with no measurements.
  // Auto-created start times and browse positions are not experimental input.
  function stepHasRecord(step) {
    return !!step && (stepHasInput(step) || checksHaveRecord(step.checks) || meaningfulValue(step.images) || (step.status != null && step.status !== 'pending') || !!step.finished_at);
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

  return { localDate, meaningfulValue, checksHaveRecord, stepHasInput, stepHasRecord, progressPosition, csvCell, validateFields, assertSafeStepSync, stepSignature, groupsOf, createSaveQueue };
});
