'use strict';

/* Parallel branches retain their rows; only the continuation owns shared data. */
(function () {
  const GROUP = 'experiment_merge_groups', MEMBER = 'experiment_merge_members';
  let groups = [], members = [], loaded = false, loadOwner = null;
  const number = (row, position) => Number(position) + (row && row._mergeOffset || 0) + 1;
  function decorate(rows) {
    for (const row of rows || []) {
      const membership = members.find((item) => Number(item.parent_run_id) === Number(row.id));
      const group = membership ? groups.find((item) => item.id === membership.group_id)
        : groups.find((item) => Number(item.result_run_id) === Number(row.id));
      row._merge = group || null;
      row._mergedInto = membership && group ? group.result_run_id : null;
      row._mergeOffset = !membership && group ? group.after_position + 1 : 0;
    }
    return rows;
  }
  async function refresh() {
    const owner = state.user && state.user.id;
    if (!owner) { groups = []; members = []; loaded = false; loadOwner = null; return; }
    const results = await Promise.all([client.from(GROUP).select('*'), client.from(MEMBER).select('*')]);
    if (!state.user || state.user.id !== owner) return;
    const error = results.find((result) => result.error);
    if (error) {
      // Older production databases can still read existing independent experiments.
      if (/PGRST205|42P01/.test(String(error.error.code))) { groups = []; members = []; loaded = false; loadOwner = owner; return; }
      throw error.error;
    }
    groups = results[0].data || []; members = results[1].data || [];
    loaded = true; loadOwner = owner;
  }
  async function context(runId) {
    await refresh();
    const row = decorate([{ id: runId }])[0];
    if (!row._merge) return null;
    const group = row._merge;
    const ids = members.filter((item) => item.group_id === group.id).map((item) => item.parent_run_id);
    const { data: runs, error } = await client.from('experiment_runs').select('*').in('id', [...ids, group.result_run_id]);
    if (error) throw error;
    return { group, runs: decorate(runs || []), parentIds: ids, resultId: group.result_run_id, isParent: !!row._mergedInto };
  }
  function diagram(info, activeId) {
    if (!info) return '';
    const after = info.group.after_position + 1;
    const parents = info.runs.filter((item) => info.parentIds.includes(item.id));
    const result = info.runs.find((item) => item.id === info.resultId);
    const count = (info.group.schema_snapshot || []).length || after + 1;
    const nodes = (from, to) => '<span class="merge-nodes">' + Array.from({ length: to - from + 1 }, (_, index) =>
      '<span class="merge-node">' + (from + index) + '</span>' + (from + index < to ? '<i aria-hidden="true">→</i>' : '')).join('') + '</span>';
    return '<section class="merge-flow" aria-label="平行实验合并流程">'
      + '<p class="merge-scroll-hint">左右滑动查看完整流程 →</p><div class="merge-flow-scroll" tabindex="0" role="region" aria-label="可左右滚动的合并流程"><div class="merge-flow-track">'
      + '<div class="merge-lanes">' + parents.map((item) => '<button class="merge-lane' + (Number(item.id) === Number(activeId) ? ' selected' : '')
        + '" type="button" data-merge-view="' + item.id + '"><b>' + esc(item.title) + '</b>' + nodes(1, after) + '<span>第 1–' + after + ' 步 · 分别记录</span><em>已完成 · 原始记录只读</em></button>').join('')
      + '</div><div class="merge-join"><span aria-hidden="true">→</span><b>混合合并</b><span>第 ' + after + ' 步之后</span></div>'
      + '<button class="merge-lane merge-common' + (Number(activeId) === Number(info.resultId) ? ' selected' : '') + '" type="button" data-merge-view="' + info.resultId + '"><b>'
      + esc(result ? result.title : '共同阶段') + '</b>' + nodes(after + 1, count) + '<span>从第 ' + (after + 1) + ' 步起 · 共用一份记录</span><em>'
      + (result && result.status === 'done' ? '已完成 · 只读' : '共同执行') + '</em></button></div></div>'
      + '<p class="merge-audit">确认于 ' + esc(new Date(info.group.created_at).toLocaleString()) + ' · ' + esc(info.group.note) + '</p></section>';
  }
  function bind(host) {
    host.querySelectorAll('[data-merge-view]').forEach((button) => button.addEventListener('click', () => route('run', Number(button.dataset.mergeView))));
  }
  function card(row) {
    if (!row._merge || row._mergedInto) return '';
    return diagram({ group: row._merge, runs: [...(row._mergeParents || []), row],
      parentIds: (row._mergeParents || []).map((item) => item.id), resultId: row.id }, row.id);
  }
  async function completed() {
    if (!groups.length) return [];
    const { data, error } = await client.from('experiment_runs').select('*').in('id', groups.map((group) => group.result_run_id))
      .eq('status', 'done').order('finished_at', { ascending: false }).limit(5);
    if (error) throw error;
    return decorate(data || []);
  }
  async function completionLog(row, steps, ended, buildLog) {
    const info = await context(row.id);
    if (!info) return buildLog(row, steps, ended);
    const { data: parents, error } = await client.from('run_steps').select('*').in('run_id', info.parentIds).order('position');
    if (error) throw error;
    return ['平行实验合并记录', '合并说明：' + info.group.note, '合并时间：' + new Date(info.group.created_at).toLocaleString(),
      ...info.runs.filter((item) => info.parentIds.includes(item.id)).map((parent) => '独立支路 #' + parent.id + '\n'
        + buildLog(parent, (parents || []).filter((step) => step.run_id === parent.id && step.position <= info.group.after_position), info.group.created_at)),
      '共同阶段 #' + row.id + '\n' + buildLog(row, steps, ended)].join('\n\n');
  }
  function reviewLocal(rows, stepsById, after) {
    if (rows.length < 2 || rows.length > 8) throw Error('请选择 2 至 8 个平行实验。');
    const first = stepsById[rows[0].id] || [];
    if (!Number.isInteger(after) || after < 0 || after >= first.length - 1) throw Error('合并前后都必须有步骤。');
    const signatures = first.map(SciHubSafety.stepSignature);
    for (const row of rows) {
      if (row.status !== 'running' || row._merge) throw Error('只能合并尚未合并的进行中实验。');
      const steps = stepsById[row.id] || [];
      if (steps.length !== first.length) throw Error('前置或后置步骤数量不一致。');
      for (const [index, step] of steps.entries()) {
        if (step.position !== index || signatures[index] !== SciHubSafety.stepSignature(step)) throw Error('第 ' + (index + 1) + ' 步不一致，不能合并。请核对前置和后置的顺序、说明、条件、字段及单位。');
        if (step.link_run_id) throw Error('实验有旧关联，请先处理旧关系。');
        if (index <= after && step.status !== 'done') throw Error('「' + row.title + '」的第 ' + (index + 1) + ' 步尚未完成。');
        if (index > after && (step.status !== 'pending' || Object.keys(step.values || {}).length || (step.images || []).length
          || String(step.note || '').trim() || step.finished_at || Object.values(step.checks || {}).some(Boolean))) {
          throw Error('「' + row.title + '」的第 ' + (index + 1) + ' 步已有后续记录，不能合并。');
        }
      }
    }
    return { after, firstShared: after + 2, parents: rows.length };
  }
  let committing = false, modalSequence = 0;
  async function open(runId) {
    if (committing || !state.user) return;
    if (window.Run && (window.Run.busy() || !await window.Run.flush())) return;
    try {
      await refresh();
      if (!loaded) throw Error('合并功能暂不可用，请联系维护者。');
      const owner = state.user.id;
      const modalId = ++modalSequence;
      const { data, error } = await client.from('experiment_runs').select('*').eq('status', 'running').order('started_at');
      if (error) throw error;
      const rows = decorate(data || []).filter((item) => !item._merge);
      const current = rows.find((item) => Number(item.id) === Number(runId));
      if (!current) throw Error('该实验已结束或已合并，请刷新后查看共同阶段。');
      if (rows.length < 2) throw Error('至少需要两个尚未合并的进行中实验。');
      const { data: steps, error: stepsError } = await client.from('run_steps').select('*').in('run_id', rows.map((item) => item.id)).order('position');
      if (stepsError) throw stepsError;
      const stepsById = {};
      for (const step of steps || []) (stepsById[step.run_id] ||= []).push(step);
      const currentSteps = stepsById[current.id] || [];
      let review = null, reviewing = false, sequence = 0;
      const others = rows.filter((item) => item.id !== current.id);
      const form = '<p>各平行实验保留前面的独立记录，混合后创建一条共同阶段。合并后原支路锁定，后续只填写一次。</p>'
        + '<b>本实验：' + esc(current.title) + '</b><fieldset class="merge-choices"><legend>选择一起混合的平行实验</legend>'
        + others.map((item) => '<label><input type="checkbox" data-merge-choice value="' + item.id + '"> ' + esc(item.title) + '</label>').join('') + '</fieldset>'
        + '<label>在完成哪一步之后混合？<select id="merge-after">' + currentSteps.slice(0, -1).map((step) => '<option value="' + step.position + '">第 ' + (step.position + 1) + ' 步：' + esc(step.title) + ' → 共同进行第 ' + (step.position + 2) + ' 步起</option>').join('') + '</select></label>'
        + '<div id="merge-review" class="merge-review" role="status">请选择平行实验和合并边界，再点击审核。</div>'
        + '<label>合并说明<textarea id="merge-note" maxlength="2000" placeholder="记录混合的样品编号、实际操作及必要说明"></textarea></label>'
        + '<label class="merge-confirm"><input type="checkbox" id="merge-confirm" disabled> 我已核对各支路记录，并确认样品将在上述边界混合，后续共用一份记录。</label>';
      const selection = () => [current.id, ...Array.from(document.querySelectorAll('[data-merge-choice]:checked')).map((input) => Number(input.value))];
      const key = () => JSON.stringify([selection(), Number($('merge-after').value)]);
      const updateSubmit = () => {
        const button = $('modal-actions').querySelector('.primary');
        if (button) button.disabled = committing || !review || review.key !== key() || !$('merge-confirm').checked || !$('merge-note').value.trim();
      };
      const invalidate = () => {
        sequence++; review = null; $('merge-confirm').checked = false; $('merge-confirm').disabled = true;
        $('merge-review').textContent = '选择已改变，请重新审核。';
        updateSubmit();
      };
      openModal('合并平行实验', form, [
        { label: '取消', onClick: () => { if (!committing) { sequence++; closeModal(); } } },
        { label: '审核合并条件', onClick: async () => {
          if (reviewing || committing) return;
          reviewing = true;
          const stamp = ++sequence, selectedKey = key();
          review = null; $('merge-confirm').checked = false; $('merge-confirm').disabled = true;
          $('merge-review').textContent = '正在检查全部前置、后置定义及最新记录…';
          try {
            const ids = selection(), after = Number($('merge-after').value);
            reviewLocal(rows.filter((item) => ids.includes(item.id)), stepsById, after);
            const { data: result, error: reviewError } = await client.rpc('research_review_merge', { p_run_ids: ids, p_after_position: after });
            if (reviewError) throw reviewError;
            if (!result || result.allowed !== true) throw Error('审核未通过。');
            if (stamp !== sequence || modalId !== modalSequence || selectedKey !== key() || !state.user || state.user.id !== owner || $('modal').hidden) return;
            review = { ...result, key: selectedKey };
            $('merge-review').innerHTML = '<b>✓ 审核通过</b><p>' + ids.length + ' 路实验的全部前置和后置定义一致；各自第 1–' + (after + 1) + ' 步已完成，后续无数据。合并后从第 ' + (after + 2) + ' 步共用记录。</p>';
            $('merge-confirm').disabled = false;
            updateSubmit();
          } catch (err) { if (stamp === sequence && !$('modal').hidden) $('merge-review').textContent = '审核不通过：' + (err.message || err); }
          finally { reviewing = false; }
        } },
        { label: '确认混合并创建共同阶段', primary: true, onClick: async () => {
          if (committing) return;
          if (!review || review.key !== key() || !$('merge-confirm').checked) { setStatus('必须审核通过并勾选混合确认。', 'warn'); return; }
          const note = $('merge-note').value.trim();
          if (!note) { setStatus('请填写合并说明。', 'warn'); return; }
          committing = true;
          document.querySelectorAll('#modal input, #modal select, #modal textarea, #modal button').forEach((node) => { node.disabled = true; });
          try {
            if (!state.user || state.user.id !== owner) throw Error('登录状态已改变，请重新审核。');
            const { data: resultId, error: mergeError } = await client.rpc('research_merge_runs', {
              p_run_ids: review.run_ids, p_after_position: review.after_position, p_note: note, p_expected_versions: review.versions,
            });
            if (mergeError) throw mergeError;
            if (!resultId) throw Error('未收到合并回执，请刷新核对。');
            closeModal(); await refresh(); committing = false;
            setStatus('合并成功：前置记录已锁定，请在共同阶段填写后续步骤。', 'ok');
            route('run', resultId);
          } catch (err) {
            review = null; $('merge-review').textContent = '合并未确认：' + (err.message || err) + '。请刷新核对合并结果后再重试。';
            document.querySelectorAll('#modal input, #modal select, #modal textarea, #modal button').forEach((node) => { node.disabled = false; });
            $('merge-confirm').checked = false; $('merge-confirm').disabled = true;
            updateSubmit();
          } finally { committing = false; }
        } },
      ]);
      document.querySelectorAll('[data-merge-choice], #merge-after').forEach((input) => input.addEventListener('change', invalidate));
      $('merge-confirm').addEventListener('change', updateSubmit);
      $('merge-note').addEventListener('input', updateSubmit);
      updateSubmit();
    } catch (err) { setStatus('无法合并：' + (err.message || err), 'error'); }
  }
  window.Merges = { refresh, decorate, context, diagram, bind, number, open, reviewLocal, card, completed, completionLog,
    busy: () => committing, ready: () => loaded && state.user && state.user.id === loadOwner };
})();
