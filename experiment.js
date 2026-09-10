'use strict';

/* SciHub · 实验模块
 * 方案（含 docx 导入）→ 按步执行（填数据 / 拍照 / 实时保存 / 跨天继续）→ 生成实验日志。
 *
 * 依赖 app.js 提供的全局：client / state / $ / esc / setStatus。
 */

(function () {
  const PLAN = 'experiment_plans';
  const STEP = 'plan_steps';
  const RUN = 'experiment_runs';
  const RUN_STEP = 'run_steps';
  const BUCKET = 'experiment-images';

  const $ = (id) => document.getElementById(id);
  const now = () => new Date();

  /* ══ 通用 ═══════════════════════════════════════════════ */

  function fmt(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function sinceText(from, to) {
    const ms = (to || now()) - new Date(from);
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' 小时 ' + (min % 60) + ' 分钟';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  }

  function el(tag, attrs, html) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => node.setAttribute(k, attrs[k]));
    if (html != null) node.innerHTML = html;
    return node;
  }

  /* ══ docx 解析 ═════════════════════════════════════════ */

  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error('JSZip 加载失败，请检查网络'));
      document.head.appendChild(s);
    });
  }

  /* Word 文档段落：<w:p> → <w:t> 文本 */
  function docxParagraphs(xml) {
    const decode = (s) => s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map((m) => decode([...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join('')))
      .map((s) => s.replace(/[ \t\u00a0]+/g, ' ').trim())
      .filter(Boolean);
  }

  /* 段落 → { title, steps:[{title, instruction, fields[]}] } */
  function parsePlan(title, paras) {
    const SECTION = /^([一二三四五六七八九十百]+)\s*[、.．]\s*(.+)$/;
    const FIELD = /([^：:，。；（）()]{2,28})\s*[：:]\s*[_＿]{2,}\s*([A-Za-z%℃°·\/]*)/g;
    const steps = [];
    let first = '';

    paras.forEach((p) => {
      const m = p.match(SECTION);
      if (m) {
        steps.push({ title: m[2].trim(), lines: [] });
        return;
      }
      if (steps.length) steps[steps.length - 1].lines.push(p);
      else if (p.length <= 40 && !first) first = p;
    });

    return {
      title: title || first || '未命名实验方案',
      steps: steps.map((s, i) => {
        const text = s.lines.join('\n');
        const fields = [];
        const seen = {};
        [...text.matchAll(FIELD)].forEach((f) => {
          const label = f[1].replace(/^[0-9.\s]+/, '').trim();
          const unit = f[2] || '';
          const key = label + '|' + unit;
          if (!label || seen[key]) return;
          seen[key] = 1;
          fields.push({ label: label, unit: unit });
        });
        return {
          position: i,
          title: s.title,
          instruction: text,
          fields: fields,
          duration_hint: guessDuration(text),
        };
      }),
    };
  }

  /* 从文本里猜时长提示（如「24 h」「过夜」「12 h」「4 h」） */
  function guessDuration(text) {
    const m = text.match(/(\d+(?:\.\d+)?)\s*(h|小时|min|分钟)/i);
    if (/过夜|不少于\s*12\s*h|overnight/i.test(text)) return '需隔夜等待';
    if (m) return '约 ' + m[1] + ' ' + (m[2].toLowerCase() === 'h' ? '小时' : m[2]);
    return '';
  }

  async function readDocx(file) {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file);
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('这不是有效的 .docx 文件');
    const xml = await entry.async('string');
    const name = (file.name || '').replace(/\.docx$/i, '');
    return parsePlan(name, docxParagraphs(xml));
  }

  /* ══ 方案列表 ═══════════════════════════════════════════ */

  async function listPlans() {
    const host = $('view-plans');
    host.innerHTML = '<div class="section-title">实验方案</div><div class="empty">加载中…</div>';

    const { data, error } = await client.from(PLAN).select('id,title,source,created_at').order('created_at', { ascending: false });
    if (error) {
      host.querySelector('.empty').textContent = '方案暂时无法加载，请稍后重试。';
      console.error('[SciHub] 方案读取失败：', error);
      return;
    }

    const cards = (data || []).map((p) => [
      '<article class="home-card">',
      '  <div class="hc-main">',
      '    <div class="hc-title">' + esc(p.title) + '</div>',
      '    <div class="hc-meta">' + (p.source ? esc(p.source) + ' · ' : '') + '创建于 ' + fmt(p.created_at) + '</div>',
      '  </div>',
      '  <div class="hc-actions">',
      '    <button type="button" class="primary" data-start="' + p.id + '">开始实验</button>',
      '    <button type="button" class="ghost" data-view="' + p.id + '">查看</button>',
      '    <button type="button" class="ghost del" data-del="' + p.id + '">删除</button>',
      '  </div>',
      '</article>',
    ].join('\n')).join('');

    host.innerHTML = [
      '<div class="section-title">实验方案</div>',
      '<div class="card" style="margin-bottom:14px">',
      '  <label>导入 Word 方案（.docx）',
      '    <input type="file" id="docx-input" accept=".docx">',
      '  </label>',
      '  <p class="hint small">导入后会自动拆成步骤与数据字段，你可以在下一步里修改。</p>',
      '</div>',
      cards || '<div class="empty">还没有实验方案，先导入一份 .docx 吧。</div>',
    ].join('\n');

    $('docx-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) startImport(f);
    });

    host.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => startRun(Number(b.dataset.start))));
    host.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => route('plan', Number(b.dataset.view))));
    host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm('删除这个方案？已生成的实验记录不受影响。')) return;
      await client.from(PLAN).delete().eq('id', Number(b.dataset.del));
      setStatus('方案已删除。', 'ok');
      listPlans();
    }));
  }

  /* ══ docx 导入 → 校对草稿 ═══════════════════════════════ */

  let draft = null;

  async function startImport(file) {
    setStatus('正在解析方案…');
    try {
      draft = await readDocx(file);
      draft.source = file.name;
      setStatus('解析完成，请核对步骤与字段。', 'ok');
      renderDraft();
      route('plan');
    } catch (err) {
      console.error('[SciHub] docx 解析失败：', err);
      setStatus(err.message || '解析失败，请确认是 Word（.docx）文件。', 'error');
    }
  }

  function renderDraft() {
    const host = $('view-plan');
    host.innerHTML = [
      '<div class="section-title">核对导入结果</div>',
      '<div class="card" style="margin-bottom:14px">',
      '  <label>方案名称<input id="draft-title" value="' + esc(draft.title) + '"></label>',
      '  <p class="hint small">共 ' + draft.steps.length + ' 个步骤。可修改标题、删掉不需要的步骤或字段，确认后保存。</p>',
      '</div>',
      draft.steps.map((s, si) => [
        '<div class="step-card" data-step="' + si + '">',
        '  <div class="step-head"><span class="step-no">' + (si + 1) + '</span>',
        '    <input class="step-title-text" data-title="' + si + '" value="' + esc(s.title) + '">',
        '    <button type="button" class="ghost" data-drop-step="' + si + '">删除步骤</button>',
        '  </div>',
        s.duration_hint ? '  <div class="step-instruction">时长提示：' + esc(s.duration_hint) + '</div>' : '',
        '  <div style="margin-top:8px">' + (s.fields.length ? s.fields.map((f, fi) => [
          '    <div class="field-row">',
          '      <input data-field-name="' + si + '-' + fi + '" value="' + esc(f.label) + '" placeholder="字段名">',
          '      <input data-field-unit="' + si + '-' + fi + '" value="' + esc(f.unit) + '" placeholder="单位，可空">',
          '    </div>',
        ].join('\n')).join('') : '<p class="hint small">这一节没有识别到填空字段（例如汇总表），可以手动添加或直接跳过。</p>') + '</div>',
        '  <button type="button" class="ghost" data-add-field="' + si + '" style="margin-top:6px">＋ 添加字段</button>',
        '</div>',
      ].join('\n')).join(''),
      '<div class="run-actions">',
      '  <button type="button" class="primary" id="draft-save">保存方案</button>',
      '  <button type="button" class="ghost" id="draft-cancel">取消</button>',
      '</div>',
    ].join('\n');
    bindDraft();
  }

  function collectDraft() {
    draft.title = $('draft-title').value.trim() || draft.title;
    draft.steps.forEach((s, si) => {
      const t = document.querySelector('[data-title="' + si + '"]');
      if (t) s.title = t.value.trim();
      s.fields.forEach((f, fi) => {
        const n = document.querySelector('[data-field-name="' + si + '-' + fi + '"]');
        const u = document.querySelector('[data-field-unit="' + si + '-' + fi + '"]');
        if (n) f.label = n.value.trim();
        if (u) f.unit = u.value.trim();
      });
      s.fields = s.fields.filter((f) => f.label);
    });
    draft.steps = draft.steps.filter((s) => s.title || s.instruction);
  }

  function bindDraft() {
    const host = $('view-plan');

    host.querySelectorAll('[data-drop-step]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      draft.steps.splice(Number(b.dataset.dropStep), 1);
      renderDraft();
    }));

    host.querySelectorAll('[data-add-field]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      draft.steps[Number(b.dataset.addField)].fields.push({ label: '新字段', unit: '' });
      renderDraft();
    }));

    $('draft-cancel').addEventListener('click', () => { draft = null; route('plans'); });

    $('draft-save').addEventListener('click', async () => {
      collectDraft();
      if (!draft.steps.length) { setStatus('至少保留一个步骤。', 'error'); return; }

      const btn = $('draft-save');
      btn.disabled = true;
      try {
        const { data: plan, error } = await client.from(PLAN).insert({
          title: draft.title, source: draft.source, user_id: state.user.id,
        }).select().single();
        if (error) throw error;

        const rows = draft.steps.map((s, i) => ({
          user_id: state.user.id,
          plan_id: plan.id,
          position: i,
          title: s.title || ('步骤 ' + (i + 1)),
          instruction: s.instruction || '',
          fields: s.fields,
          duration_hint: s.duration_hint || '',
        }));
        const { error: stepErr } = await client.from(STEP).insert(rows);
        if (stepErr) throw stepErr;

        draft = null;
        setStatus('方案已保存。', 'ok');
        route('plans');
      } catch (err) {
        console.error('[SciHub] 保存方案失败：', err);
        setStatus('保存失败，请稍后重试。', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ══ 方案查看 / 编辑 ════════════════════════════════════ */

  async function renderEditor(planId) {
    const host = $('view-plan');
    host.innerHTML = '<div class="section-title">实验方案</div><div class="empty">加载中…</div>';

    const { data: plan } = await client.from(PLAN).select('*').eq('id', planId).maybeSingle();
    const { data: steps } = await client.from(STEP).select('*').eq('plan_id', planId).order('position');
    if (!plan) { host.innerHTML = '<div class="empty">方案不存在。</div>'; return; }

    host.innerHTML = [
      '<div class="section-title">' + esc(plan.title) + '</div>',
      '  <p class="hint small" style="margin-bottom:12px">' + (plan.source ? '来源：' + esc(plan.source) + ' · ' : '') + '共 ' + (steps || []).length + ' 个步骤</p>',
      (steps || []).map((s) => [
        '<div class="step-card">',
        '  <div class="step-head"><span class="step-no">' + (s.position + 1) + '</span>',
        '    <span class="step-title-text">' + esc(s.title) + '</span>',
        s.duration_hint ? '    <span class="tag-mini">' + esc(s.duration_hint) + '</span>' : '',
        '  </div>',
        '  <div class="step-instruction">' + esc(s.instruction) + '</div>',
        (s.fields || []).length ? '  <div class="hc-meta" style="margin-top:8px">数据字段：' + (s.fields || []).map((f) => esc(f.label) + (f.unit ? '（' + esc(f.unit) + '）' : '')).join('、') + '</div>' : '',
        '</div>',
      ].join('\n')).join(''),
      '<div class="run-actions">',
      '  <button type="button" class="primary" id="plan-start">开始实验</button>',
      '  <button type="button" class="ghost" id="plan-back">返回方案列表</button>',
      '</div>',
    ].join('\n');

    $('plan-back').addEventListener('click', () => route('plans'));
    $('plan-start').addEventListener('click', () => startRun(planId));
  }

  /* ══ 开始一次实验（把方案快照进 run_steps）══════════════ */

  async function startRun(planId) {
    setStatus('正在准备实验…');
    try {
      const { data: plan } = await client.from(PLAN).select('*').eq('id', planId).maybeSingle();
      const { data: steps } = await client.from(STEP).select('*').eq('plan_id', planId).order('position');
      if (!plan || !steps || !steps.length) { setStatus('方案没有可用步骤。', 'error'); return; }

      const { data: run, error } = await client.from(RUN).insert({
        user_id: state.user.id,
        plan_id: plan.id,
        title: plan.title,
        status: 'running',
        current_step: 0,
      }).select().single();
      if (error) throw error;

      const rows = steps.map((s) => ({
        user_id: state.user.id,
        run_id: run.id,
        position: s.position,
        title: s.title,
        instruction: s.instruction,
        fields: s.fields,
        values: {},
        images: [],
        status: 'pending',
      }));
      const { error: stepErr } = await client.from(RUN_STEP).insert(rows);
      if (stepErr) throw stepErr;

      setStatus('实验已开始，随时可以继续。', 'ok');
      route('run', run.id);
    } catch (err) {
      console.error('[SciHub] 开始实验失败：', err);
      setStatus('无法开始实验，请稍后重试。', 'error');
    }
  }

  window.Plans = { list: listPlans, editor: renderEditor, start: startRun };

  /* ══ 执行界面 ═══════════════════════════════════════════ */

  const run = { id: null, data: null, steps: [], pos: 0, saveTimer: null, urls: {} };

  async function renderRun(runId) {
    const host = $('view-run');
    host.innerHTML = '<div class="empty">加载中…</div>';

    const { data: r } = await client.from(RUN).select('*').eq('id', runId).maybeSingle();
    const { data: steps } = await client.from(RUN_STEP).select('*').eq('run_id', runId).order('position');
    if (!r) { host.innerHTML = '<div class="empty">实验记录不存在。</div>'; return; }

    run.id = runId;
    run.data = r;
    run.steps = steps || [];
    run.pos = Math.min(r.current_step || 0, Math.max(0, run.steps.length - 1));
    run.urls = {};

    // 预取图片的签名地址（私有 bucket）
    for (const s of run.steps) {
      for (const img of (s.images || [])) {
        const { data: signed } = await client.storage.from(BUCKET).createSignedUrl(img.path, 60 * 60 * 24);
        if (signed) run.urls[img.path] = signed.signedUrl;
      }
    }

    drawRun();
  }

  function drawRun() {
    const host = $('view-run');
    const s = run.steps[run.pos];
    if (!s) { host.innerHTML = '<div class="empty">没有可执行的步骤。</div>'; return; }

    const done = run.steps.filter((x) => x.status === 'done').length;
    const pct = Math.round((done / run.steps.length) * 100);
    const isLast = run.pos === run.steps.length - 1;

    host.innerHTML = [
      '<div class="run-head">',
      '  <div><b>' + esc(run.data.title) + '</b>',
      '    <div class="hc-meta">开始于 ' + fmt(run.data.started_at) + ' · 已进行 ' + sinceText(run.data.started_at) + (run.data.status === 'done' ? ' · 已完成' : '') + '</div>',
      '  </div>',
      '  <div class="hc-actions"><button type="button" class="ghost" id="run-exit">返回主页</button></div>',
      '</div>',
      '<div class="progress"><i style="width:' + pct + '%"></i></div>',
      '<div class="hc-meta" style="margin-bottom:10px">第 ' + (run.pos + 1) + ' / ' + run.steps.length + ' 步 · 已完成 ' + done + ' 步</div>',
      '<div class="run-step-card">',
      '  <h2>第 ' + (run.pos + 1) + ' 步：' + esc(s.title) + '</h2>',
      s.duration_hint ? '  <span class="dur">时长提示：' + esc(s.duration_hint) + '</span>' : '',
      '  <div class="instr">' + esc(s.instruction) + '</div>',
      '  <div id="fields"></div>',
      '  <div style="margin-top:14px">',
      '    <div class="hc-meta">实验照片</div>',
      '    <div class="photos" id="photos"></div>',
      '    <input type="file" id="photo-input" accept="image/*" capture="environment" hidden>',
      '  </div>',
      '  <div class="run-actions">',
      '    <button type="button" class="ghost" id="run-prev" ' + (run.pos === 0 ? 'disabled' : '') + '>上一步</button>',
      '    <button type="button" class="primary" id="run-next">' + (isLast ? '完成实验' : '完成并下一步') + '</button>',
      '  </div>',
      '  <div class="autosave" id="autosave"></div>',
      '</div>',
    ].join('\n');

    drawFields(s);
    drawPhotos(s);

    $('run-exit').addEventListener('click', () => route('home'));
    $('run-prev').addEventListener('click', () => { run.pos--; drawRun(); });
    $('run-next').addEventListener('click', () => (isLast ? finishRun() : nextStep()));
    $('photo-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) uploadPhoto(f);
      e.target.value = '';
    });
  }

  function drawFields(s) {
    const host = $('fields');
    const fields = s.fields || [];
    if (!fields.length) {
      host.innerHTML = '<p class="hint small">这一步没有预设字段，可在下方备注里记录。</p>';
    } else {
      host.innerHTML = fields.map((f, i) => [
        '<div class="data-field">',
        '  <label>' + esc(f.label) + (f.unit ? '<span class="unit">(' + esc(f.unit) + ')</span>' : '') + '</label>',
        '  <input data-key="' + i + '" value="' + esc((s.values || {})[f.label] || '') + '">',
        '</div>',
      ].join('\n')).join('');
    }

    const note = el('div', { class: 'data-field' }, [
      '<label>备注</label>',
      '<textarea data-note rows="3" placeholder="补充说明、异常情况…">' + esc(s.note || '') + '</textarea>',
    ].join(''));
    host.appendChild(note);

    host.querySelectorAll('[data-key]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const f = fields[Number(inp.dataset.key)];
        s.values = s.values || {};
        s.values[f.label] = inp.value;
        scheduleSave(s);
      });
    });
    const nt = host.querySelector('[data-note]');
    nt.addEventListener('input', () => { s.note = nt.value; scheduleSave(s); });
  }

  function drawPhotos(s) {
    const host = $('photos');
    const images = s.images || [];
    host.innerHTML = images.map((img) => [
      '<div class="photo" data-path="' + esc(img.path) + '">',
      run.urls[img.path] ? '  <img src="' + esc(run.urls[img.path]) + '" alt="' + esc(img.name || '照片') + '">' : '<div style="display:grid;place-items:center;height:100%;color:var(--muted);font-size:11px">加载中</div>',
      '  <button type="button" data-drop="' + esc(img.path) + '" title="删除">×</button>',
      '</div>',
    ].join('\n')).join('');

    const add = el('button', { type: 'button', class: 'photo-add' }, '＋ 拍照 / 选图');
    add.addEventListener('click', () => $('photo-input').click());
    host.appendChild(add);

    host.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', async () => {
      const path = b.dataset.drop;
      if (!window.confirm('删除这张照片？')) return;
      await client.storage.from(BUCKET).remove([path]);
      s.images = (s.images || []).filter((x) => x.path !== path);
      await saveStep(s, true);
      drawPhotos(s);
    }));
  }

  /* ── 实时保存（输入停下 1 秒后写库）──────────────────── */

  function scheduleSave(s) {
    $('autosave').textContent = '编辑中…';
    if (run.saveTimer) clearTimeout(run.saveTimer);
    run.saveTimer = setTimeout(() => saveStep(s), 1000);
  }

  async function saveStep(s, immediate) {
    if (run.saveTimer && immediate) { clearTimeout(run.saveTimer); run.saveTimer = null; }
    const { error } = await client.from(RUN_STEP).update({
      values: s.values || {},
      note: s.note || '',
      images: s.images || [],
      status: s.status,
      started_at: s.started_at,
      finished_at: s.finished_at,
    }).eq('id', s.id);
    if (error) {
      console.error('[SciHub] 保存步骤失败：', error);
      $('autosave').textContent = '保存失败，请检查网络';
      return;
    }
    $('autosave').textContent = '已保存 · ' + fmt(now());
  }

  /* ── 图片上传 ─────────────────────────────────────────── */

  async function uploadPhoto(file) {
    const s = run.steps[run.pos];
    const stamp = Date.now();
    const safe = (file.name || 'photo.jpg').replace(/[^\w.\-]/g, '_');
    const path = state.user.id + '/' + run.id + '/' + s.position + '/' + stamp + '-' + safe;

    $('autosave').textContent = '照片上传中…';
    const { error } = await client.storage.from(BUCKET).upload(path, file, { upsert: false });
    if (error) {
      console.error('[SciHub] 上传失败：', error);
      $('autosave').textContent = '照片上传失败';
      return;
    }

    const { data: signed } = await client.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24);
    if (signed) run.urls[path] = signed.signedUrl;

    s.images = (s.images || []).concat([{ path: path, name: file.name || 'photo', at: new Date().toISOString() }]);
    await saveStep(s, true);
    drawPhotos(s);
  }

  /* ── 下一步 / 完成 ────────────────────────────────────── */

  async function nextStep() {
    const s = run.steps[run.pos];
    if (!s.started_at) s.started_at = new Date().toISOString();
    s.status = 'done';
    s.finished_at = new Date().toISOString();
    await saveStep(s, true);

    run.pos = Math.min(run.pos + 1, run.steps.length - 1);
    const ns = run.steps[run.pos];
    if (ns && !ns.started_at) {
      ns.started_at = new Date().toISOString();
      await saveStep(ns, true);
    }

    await client.from(RUN).update({
      current_step: run.pos,
      updated_at: new Date().toISOString(),
    }).eq('id', run.id);

    drawRun();
  }

  async function finishRun() {
    const s = run.steps[run.pos];
    if (!s.started_at) s.started_at = new Date().toISOString();
    s.status = 'done';
    s.finished_at = new Date().toISOString();
    await saveStep(s, true);

    if (!window.confirm('实验完成？会生成一份实验日志并保存到科研记录。')) return;

    const ended = new Date().toISOString();
    const summary = buildLog(run.data, run.steps, ended);

    await client.from(RUN).update({
      status: 'done',
      current_step: run.steps.length - 1,
      finished_at: ended,
      updated_at: ended,
    }).eq('id', run.id);

    await client.from('research_records').insert({
      user_id: state.user.id,
      title: run.data.title + ' · 实验日志',
      category: '实验日志',
      content: summary,
      tags: ['实验日志'],
      occurred_on: new Date().toISOString().slice(0, 10),
    });

    setStatus('实验已完成，日志已保存到科研记录。', 'ok');
    run.data.status = 'done';
    drawRun();
  }

  function buildLog(r, steps, ended) {
    const lines = [];
    lines.push('实验：' + r.title);
    lines.push('开始：' + fmt(r.started_at));
    lines.push('结束：' + fmt(ended));
    lines.push('总耗时：' + sinceText(r.started_at, new Date(ended)));
    lines.push('');

    steps.forEach((s, i) => {
      lines.push('【第 ' + (i + 1) + ' 步】' + s.title);
      if (s.started_at || s.finished_at) {
        lines.push('  时间：' + (s.started_at ? fmt(s.started_at) : '?') + ' → ' + (s.finished_at ? fmt(s.finished_at) : '?'));
      }
      const vals = s.values || {};
      Object.keys(vals).forEach((k) => {
        if (String(vals[k]).trim()) lines.push('  ' + k + '：' + vals[k]);
      });
      if ((s.note || '').trim()) lines.push('  备注：' + s.note);
      if ((s.images || []).length) lines.push('  照片：' + s.images.length + ' 张');
      lines.push('');
    });

    return lines.join('\n');
  }

  /* ── 进行中的实验（主页用）────────────────────────────── */

  async function runningRuns() {
    const { data } = await client.from(RUN).select('id,title,started_at,current_step,updated_at')
      .eq('status', 'running').order('updated_at', { ascending: false }).limit(5);
    return data || [];
  }

  window.Run = { render: renderRun, running: runningRuns };
})();
