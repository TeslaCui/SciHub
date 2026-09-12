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

  /* 从一段步骤文本里抽「需要现场记录」的字段（「xxx：____ g」这种填空）。
     同名字段不再合并，而是带上所在句子的试剂名：
     同一节里的两次「记录实际质量」→「2-MIM 记录实际质量」与「Fe(acac)₃ 记录实际质量」。
     抽成独立函数，是为了「重新解析已有方案」时能复用同一套规则。 */
  function detectFields(text) {
    const FIELD = /([^：:，。；（）()]{2,28})\s*[：:]\s*[_＿]{2,}\s*([A-Za-z%℃°·\/]*)/g;
    const fields = [];
    const used = new Set();

    [...String(text || '').matchAll(FIELD)].forEach((f) => {
      const label = f[1].replace(/^[0-9.\s]+/, '').trim();
      const unit = f[2] || '';
      if (!label) return;

      const at = f.index || 0;
      const agent = guessAgent(String(text).slice(Math.max(0, at - 60), at));
      const base = agent ? (agent + ' ' + label) : label;

      let finalLabel = base;
      let n = 2;
      while (used.has(finalLabel)) { finalLabel = base + '（' + n + '）'; n += 1; }
      used.add(finalLabel);

      fields.push({ label: finalLabel, unit: unit });
    });

    return fields;
  }

  /* 段落 → { title, steps:[{title, instruction, fields[]}] } */
  function parsePlan(title, paras) {
    const SECTION = /^([一二三四五六七八九十百]+)\s*[、.．]\s*(.+)$/;
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
        return {
          position: i,
          title: s.title,
          instruction: text,
          fields: detectFields(text),
          duration_hint: guessDuration(text),
          notice: extractNotice(text),
        };
      }),
    };
  }

  /* 挑出步骤里的「注意事项」：方案中「注意：… ⚠ … 切记…」这类句子。
     这些文字仍然保留在 instruction 里，这里只是再摘出一份，好在执行时醒目提醒。
     识别不了就返回空串，不会影响其它解析结果。 */
  function extractNotice(text) {
    const hits = [];
    String(text || '').split('\n').forEach((line) => {
      const t = line.trim();
      if (!t) return;
      if (!/注意|警告|提示|切记|务必|避免|严禁|小心|异常|风险|⚠|❗/.test(t)) return;

      const cleaned = t
        .replace(/^[\s0-9.、．()（）]*/, '')
        .replace(/^(注意|警告|提示|说明|备注)[：:]\s*/, '')
        .trim();

      if (cleaned && hits.indexOf(cleaned) === -1) hits.push(cleaned);
    });
    return hits.join('；');
  }

  /* 从「填空」前面那段文字里猜出涉及的试剂名（化学式 / 缩写），用来区分同名字段 */
  function guessAgent(context) {
    if (!context) return '';
    const patterns = [
      /[A-Z][A-Za-z]*\([^)]+\)[\w₀-₉·.\-]*/,
      /\b\d+-[A-Za-z]{2,}\b/,
      /\b[A-Z][a-z]?\d[\w₀-₉]*/,
    ];
    for (const re of patterns) {
      const m = context.match(re);
      if (m) return m[0];
    }
    return '';
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
    return { name: name, paras: docxParagraphs(xml) };
  }

  /* 用 AI（Edge Function 代理 DeepSeek，密钥只在服务端）把方案文本结构化；
     不可用时返回 null，由调用方回退到规则解析。 */
  async function parsePlanSmart(text) {
    if (!text || !text.trim()) return null;
    try {
      const { data, error } = await client.functions.invoke('parse-plan', { body: { text: text } });
      if (error) throw error;
      const plan = normalizePlan(data);
      if (!plan) throw new Error('AI 未返回有效步骤');
      return plan;
    } catch (err) {
      console.warn('[SciHub] AI 解析不可用，改用规则解析：', err);
      return null;
    }
  }

  /* 校验并规范化 AI 返回结构；保证字段名唯一（填写结果以字段名为键存储） */
  function normalizePlan(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const steps = Array.isArray(raw.steps) ? raw.steps : [];
    if (!steps.length) return null;

    const out = steps.map((s, i) => {
      const used = new Set();
      const fields = (Array.isArray(s && s.fields) ? s.fields : []).map((f) => {
        const label = String((f && f.label) || '').trim();
        if (!label) return null;
        let finalLabel = label;
        let n = 2;
        while (used.has(finalLabel)) { finalLabel = label + '（' + n + '）'; n += 1; }
        used.add(finalLabel);
        // AI 若给了填写方式就采纳；没给则留空，运行时由 fieldTypeOf 按字段名推断
        const type = String((f && f.type) || '').trim().toLowerCase();
        return {
          label: finalLabel,
          unit: String((f && f.unit) || '').trim(),
          type: FIELD_TYPES.some((x) => x.value === type) ? type : '',
        };
      }).filter(Boolean);

      return {
        title: String((s && s.title) || ('步骤 ' + (i + 1))).trim(),
        instruction: String((s && s.instruction) || '').trim(),
        duration_hint: String((s && s.duration_hint) || '').trim(),
        // AI 没单独给 notice 时，就从 instruction 里按关键词兜底提取
        notice: String((s && s.notice) || '').trim() || extractNotice(s && s.instruction),
        fields: fields,
      };
    });

    return {
      title: String(raw.title || '未命名实验方案').trim(),
      steps: out,
    };
  }

  /* ══ 方案列表 ═══════════════════════════════════════════ */

  /* 字段名归一化：AI 解析与规则解析对同一项常给出不同叫法
     （「2-MIM 实际称量质量」 vs 「2-MIM 记录实际质量」），
     去掉只起修饰作用的字词后再比较，避免把同一个字段误判成「新增」。 */
  function fieldKey(label) {
    return String(label || '')
      .replace(/\s+/g, '')
      .replace(/[（）()【】\[\]：:、，,。.]/g, '')
      .replace(/记录|实际|称取|称量|读取|填写|测量|测得|请输入|最终|数据/g, '');
  }

  /* ── 方案解析规则版本（内部判断用）──────────────────────
     每次改进解析能力就把这个数 +1。方案会记下「导入时用的是哪一版」；
     只要落后，就说明它没享受到后来新增的解析能力，界面会给出「重新解析」入口。
       v1：初版（只有基本字段识别）
       v2：注意事项提取 + 同名药品前缀区分
       v3：把热解程序完整保留进步骤说明（执行界面据此显示热解程序计算器）
           + 字段可指定填写方式
     注：版本号只在内部用，不展示给用户。 */
  const PARSE_VERSION = 3;

  /* 这个方案是不是用旧版解析规则导入的（没有记录的老方案视为 v1） */
  function planNeedsUpgrade(plan) {
    const version = Number(plan && plan.parse_version) || 1;
    return version < PARSE_VERSION;
  }

  /* 保留占位：按需求界面上不展示版本号，需要时把这里改回返回提示文本即可 */
  function planVersionNote() {
    return '';
  }

  async function listPlans() {
    const host = $('view-plans');
    host.innerHTML = '<div class="section-title">实验方案</div><div class="empty">加载中…</div>';

    // 卡片上的两个图标操作（行内 SVG，无外部依赖）
    const ICON_TAG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
    const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    const ICON_REFRESH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>';

    const { data, error } = await client.from(PLAN).select('id,title,source,created_at,parse_version').order('created_at', { ascending: false });
    if (error) {
      host.querySelector('.empty').textContent = '方案暂时无法加载，请稍后重试。';
      console.error('[SciHub] 方案读取失败：', error);
      return;
    }

    const cards = (data || []).map((p) => [
      '<article class="plan-card" data-open="' + p.id + '" title="点击查看与编辑">',
      '  <div class="hc-main">',
      '    <div class="hc-title">' + esc(p.title) + '</div>',
      '    <div class="hc-meta">' + (p.source ? esc(p.source) + ' · ' : '') + fmt(p.created_at) + '</div>',
      '  </div>',
      '  <div class="hc-actions">',
      '    <button type="button" class="plan-start" data-start="' + p.id + '">开始实验</button>',
      planNeedsUpgrade(p)
        ? '    <button type="button" class="icon-btn fresh" data-upgrade="' + p.id + '" title="这个方案还没用上最新的解析功能，点此重新解析（不影响已开始的实验）" aria-label="重新解析">' + ICON_REFRESH + '</button>'
        : '',
      '    <button type="button" class="icon-btn" data-rename="' + p.id + '" data-name="' + esc(p.title) + '" title="重命名" aria-label="重命名">' + ICON_TAG + '</button>',
      '    <button type="button" class="icon-btn del" data-del="' + p.id + '" title="删除" aria-label="删除">' + ICON_TRASH + '</button>',
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

    // 点卡片进详情（点按钮时不触发）
    host.querySelectorAll('[data-open]').forEach((card) => card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      route('plan', Number(card.dataset.open));
    }));

    host.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => startRun(Number(b.dataset.start))));
    host.querySelectorAll('[data-upgrade]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await upgradePlan(Number(b.dataset.upgrade));
        // 关键：重新读一遍方案并重绘列表。
        // 内容补齐后 planNeedsUpgrade 会返回 false，这个按钮也就随之消失。
        listPlans();
      } catch (err) {
        console.error('[SciHub] 更新方案失败：', err);
        setStatus('更新失败：' + errorText(err), 'error');
        b.disabled = false;
      }
    }));
    host.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => renamePlan(Number(b.dataset.rename), b.dataset.name)));
    host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm('删除这个方案？已生成的实验记录不受影响。')) return;
      await client.from(PLAN).delete().eq('id', Number(b.dataset.del));
      setStatus('方案已删除。', 'ok');
      listPlans();
    }));
  }

  /* 按当前解析规则「重建」方案内容：
       · 字段以最新解析结果为准（同义字段取最新命名，不再新旧并存）；
       · 旧字段里新规则认不出来的（通常是手工加的）保留在末尾，不丢；
       · 已有注意事项保留，缺失的按新规则补上；
       · plan_id 不变，已开始的实验仍指向同一个方案。
     若同时有进行中的实验在用这个方案，会先询问是否把已填数据迁移到新字段。
     返回发生变化的步骤数。 */
  async function upgradePlan(planId) {
    const { data: steps } = await client.from(STEP).select('*').eq('plan_id', planId).order('position');
    if (!steps || !steps.length) { setStatus('这个方案没有步骤可更新。', 'warn'); return 0; }

    let changedFields = 0;
    let addedNotices = 0;
    const nextByPosition = {};   // 供后面的数据迁移复用

    for (const s of steps) {
      const text = s.instruction || '';
      const fresh = detectFields(text);
      const freshKeys = new Set(fresh.map((f) => fieldKey(f.label)));
      // 新规则认不出来的旧字段（多为手工添加）保留在末尾
      const extras = (s.fields || []).filter((f) => !freshKeys.has(fieldKey(f.label)));
      const nextFields = fresh.concat(extras);
      nextByPosition[s.position] = nextFields;

      const currentNotice = s.notice || '';
      const nextNotice = currentNotice || extractNotice(text);

      const sameFields = JSON.stringify(nextFields) === JSON.stringify(s.fields || []);
      const sameNotice = nextNotice === currentNotice;
      if (!sameFields) changedFields += 1;
      if (!sameNotice) addedNotices += 1;
      if (sameFields && sameNotice) continue;

      const patch = {};
      if (!sameFields) patch.fields = nextFields;
      if (!sameNotice) patch.notice = nextNotice;

      const { error } = await client.from(STEP).update(patch).eq('id', s.id);
      if (error) throw error;
    }

    const migrated = await migrateRuns(planId, nextByPosition);

    // 标记为当前解析版本 —— 之后这个方案就不会再提示更新了
    const { error: markErr } = await client.from(PLAN).update({ parse_version: PARSE_VERSION }).eq('id', planId);
    if (markErr) throw markErr;

    if (!changedFields && !addedNotices && !migrated) {
      setStatus('解析规则已是最新（v' + PARSE_VERSION + '），内容没有需要补充的地方。', 'ok');
    } else {
      setStatus('已按最新规则重建（v' + PARSE_VERSION + '）：更新 ' + changedFields + ' 个步骤的字段、补 ' + addedNotices + ' 条注意事项'
        + (migrated ? '，并迁移了 ' + migrated + ' 个步骤的已填数据' : '') + '。', 'ok');
    }
    return changedFields + addedNotices;
  }

  /* 值是以「字段名」为键存的（如 values['Fe(acac)₃ 记录实际质量']）。
     方案重建后字段名可能变了，于是要按含义把旧值搬到新字段上：
       ① 名字完全相同      → 直接沿用
       ② AI 判定是同一参数  → 搬过去（aiMap 由 match-params 提供）
       ③ 归一化名相同      → 搬过去
     三层都匹配不上就原样保留 —— 宁可留着看不见，也不能丢数据。 */
  function migrateStepValues(oldFields, newFields, values, aiMap) {
    const src = values || {};
    const out = {};
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    newFields.forEach((nf) => {
      if (has(src, nf.label)) { out[nf.label] = src[nf.label]; return; }        // ① 同名

      const byAi = (oldFields || []).find((of) => aiMap && aiMap[of.label] === nf.label && has(src, of.label));
      if (byAi) { out[nf.label] = src[byAi.label]; return; }                    // ② AI 判定

      const nk = fieldKey(nf.label);
      const hit = (oldFields || []).find((of) => fieldKey(of.label) === nk && has(src, of.label));
      if (hit) out[nf.label] = src[hit.label];                                  // ③ 归一化名
    });

    Object.keys(src).forEach((k) => { if (out[k] === undefined) out[k] = src[k]; });   // 兜底：不丢旧值
    return out;
  }

  /* 请 AI 判断「旧字段 → 新字段」的对应关系（按参数含义，而不只是名字）。
     返回 { 旧字段名: 新字段名 }；不可用时返回 null，调用方回退到名称匹配。 */
  async function aiMatchFields(oldLabels, newLabels) {
    if (!oldLabels.length || !newLabels.length) return null;
    try {
      const { data, error } = await client.functions.invoke('match-params', {
        body: { old: oldLabels, new: newLabels },
      });
      if (error) throw error;

      const map = {};
      ((data && data.pairs) || []).forEach((p) => {
        if (p && p.from && p.to && oldLabels.indexOf(p.from) !== -1 && newLabels.indexOf(p.to) !== -1) {
          map[p.from] = p.to;
        }
      });
      return Object.keys(map).length ? map : null;
    } catch (err) {
      console.warn('[SciHub] AI 参数匹配不可用，改用名称匹配：', err);
      return null;
    }
  }

  /* 把方案的重建结果同步到正在进行的实验上（改别人的数据前先征得同意） */
  async function migrateRuns(planId, nextByPosition) {
    const { data: runs } = await client.from(RUN).select('id,status').eq('plan_id', planId);
    const running = (runs || []).filter((r) => r.status === 'running');
    if (!running.length) return 0;

    const ok = window.confirm(
      '有 ' + running.length + ' 个进行中的实验使用这个方案。\n\n'
      + '要把它们已填的数据迁移到新参数上吗？\n'
      + '（先按名称匹配，再由 AI 判断同义参数；匹配不到的会原样保留，不会丢失）'
    );
    if (!ok) return 0;

    const { data: runSteps } = await client.from(RUN_STEP).select('*').in('run_id', running.map((r) => r.id));
    const rows = runSteps || [];

    // 只把「名字对不上」的那部分交给 AI，减少 token 也降低误配概率
    const aiMaps = {};
    for (const rs of rows) {
      const nextFields = nextByPosition[rs.position];
      if (!nextFields) continue;

      const oldLabels = (rs.fields || []).map((f) => f.label);
      const newLabels = nextFields.map((f) => f.label);
      const unmatchedOld = oldLabels.filter((l) => newLabels.indexOf(l) === -1);
      const unmatchedNew = newLabels.filter((l) => oldLabels.indexOf(l) === -1);
      if (!unmatchedOld.length || !unmatchedNew.length) continue;

      const map = await aiMatchFields(unmatchedOld, unmatchedNew);
      if (map) aiMaps[rs.id] = map;
    }

    let migrated = 0;
    for (const rs of rows) {
      const nextFields = nextByPosition[rs.position];
      if (!nextFields) continue;

      const nextValues = migrateStepValues(rs.fields, nextFields, rs.values, aiMaps[rs.id]);
      const changed = JSON.stringify(nextFields) !== JSON.stringify(rs.fields || [])
        || JSON.stringify(nextValues) !== JSON.stringify(rs.values || {});
      if (!changed) continue;

      const { error } = await client.from(RUN_STEP).update({ fields: nextFields, values: nextValues }).eq('id', rs.id);
      if (error) throw error;
      migrated += 1;
    }
    return migrated;
  }

  /* ══ docx 导入 → 校对草稿 ═══════════════════════════════ */

  let draft = null;

  async function startImport(file) {
    setStatus('正在解析方案…');
    try {
      const { name, paras } = await readDocx(file);

      // 优先用 AI 解析（能区分同名药品、能读表格）；不可用时回退规则解析
      let plan = await parsePlanSmart(paras.join('\n'));
      if (plan) {
        setStatus('AI 解析完成，请核对步骤与字段。', 'ok');
      } else {
        plan = parsePlan(name, paras);
        setStatus('已用规则解析（AI 未启用或调用失败）：请重点核对字段是否齐全。', 'warn');
      }

      draft = plan;
      draft.source = file.name;
      renderDraft();
      route('plan');
    } catch (err) {
      console.error('[SciHub] docx 解析失败：', err);
      setStatus(err.message || '解析失败，请确认是 Word（.docx）文件。', 'error');
    }
  }

  /* 字段的填写方式 —— 决定执行界面用哪种输入控件 */
  const FIELD_TYPES = [
    { value: 'text', label: '文本' },
    { value: 'number', label: '数字' },
    { value: 'time', label: '时间' },
    { value: 'date', label: '日期' },
    { value: 'datetime', label: '日期 + 时间' },
  ];

  /* 取字段的填写方式：优先用显式设定的；老数据按字段名猜（与旧行为一致） */
  function fieldTypeOf(f) {
    const t = String((f && f.type) || '').toLowerCase();
    if (FIELD_TYPES.some((x) => x.value === t)) return t;
    const label = String((f && f.label) || '');
    if (/时间|时刻/.test(label)) return 'datetime';
    if (/日期/.test(label)) return 'date';
    return 'text';
  }

  /* 注意事项以一个字符串存储（多条用「；」分隔），编辑时拆成一行一条 */
  function noticeLines(s) {
    const raw = String((s && s.notice) || '').trim();
    if (!raw) return [''];
    const lines = raw.split(/[；;]\s*/).map((x) => x.trim()).filter(Boolean);
    return lines.length ? lines : [''];
  }

  function renderDraft() {
    const host = $('view-plan');
    const editing = !!draft.id;
    host.innerHTML = [
      '<div class="section-title">' + (editing ? '编辑方案' : '核对导入结果') + '</div>',
      '<div class="card" style="margin-bottom:14px">',
      '  <label>方案名称<input id="draft-title" value="' + esc(draft.title) + '"></label>',
      '  <p class="hint small">共 ' + draft.steps.length + ' 个步骤。' + (editing
        ? '保存后会更新这个方案；已经开始的实验用的是启动时的快照，不受影响。'
        : '可修改标题、增删步骤与字段，确认后保存。') + '</p>',
      '</div>',
      draft.steps.map((s, si) => [
        '<div class="step-card" data-step="' + si + '">',
        '  <div class="step-head"><span class="step-no">' + (si + 1) + '</span>',
        '    <input class="step-title-text" data-title="' + si + '" value="' + esc(s.title) + '" placeholder="步骤标题">',
        '    <button type="button" class="ghost" data-drop-step="' + si + '">删除步骤</button>',
        '  </div>',
        '  <input data-duration="' + si + '" value="' + esc(s.duration_hint || '') + '" placeholder="时长提示（如：约 24 小时）" style="margin-bottom:8px">',
        '  <textarea data-instruction="' + si + '" rows="3" placeholder="步骤说明">' + esc(s.instruction || '') + '</textarea>',

        // 注意事项：一行一条，可增可删（存库时仍合并成一个字符串）
        '  <div class="sub-block">',
        '    <div class="sub-head"><span>⚠ 注意事项</span>',
        '      <button type="button" class="ghost tiny" data-add-notice="' + si + '">＋ 添加一条</button>',
        '    </div>',
        noticeLines(s).map((line, ni) => [
        '    <div class="line-row">',
        '      <input data-notice="' + si + '-' + ni + '" value="' + esc(line) + '" placeholder="如：出现沉淀即为异常">',
        '      <button type="button" class="icon-btn del" data-drop-notice="' + si + '-' + ni + '" title="删除这条" aria-label="删除这条">×</button>',
        '    </div>',
        ].join('\n')).join(''),
        '  </div>',

        '  <div class="sub-block">',
        '    <div class="sub-head"><span>数据字段</span>',
        '      <button type="button" class="ghost tiny" data-add-field="' + si + '">＋ 添加字段</button>',
        '    </div>',
        (s.fields.length ? s.fields.map((f, fi) => [
          '    <div class="field-row">',
          '      <input data-field-name="' + si + '-' + fi + '" value="' + esc(f.label) + '" placeholder="字段名">',
          '      <input data-field-unit="' + si + '-' + fi + '" value="' + esc(f.unit || '') + '" placeholder="单位，可空">',
          '      <select data-field-type="' + si + '-' + fi + '" title="填写方式">',
          FIELD_TYPES.map((x) => '        <option value="' + x.value + '"' + (fieldTypeOf(f) === x.value ? ' selected' : '') + '>' + x.label + '</option>').join('\n'),
          '      </select>',
          '    </div>',
        ].join('\n')).join('') : '<p class="hint small">这一节还没有数据字段，可点上方添加。</p>'),
        '  </div>',
        '</div>',
      ].join('\n')).join(''),
      '<button type="button" class="ghost" id="draft-add-step" style="margin-bottom:10px">＋ 添加步骤</button>',
      '<div class="run-actions">',
      '  <button type="button" class="primary" id="draft-save">' + (editing ? '保存修改' : '保存方案') + '</button>',
      '  <button type="button" class="ghost" id="draft-cancel">取消</button>',
      '</div>',
    ].join('\n');
    bindDraft();
  }

  function collectDraft() {
    const host = $('view-plan');
    draft.title = $('draft-title').value.trim() || draft.title;
    draft.steps.forEach((s, si) => {
      const t = document.querySelector('[data-title="' + si + '"]');
      const d = document.querySelector('[data-duration="' + si + '"]');
      const ins = document.querySelector('[data-instruction="' + si + '"]');
      if (t) s.title = t.value.trim();
      if (d) s.duration_hint = d.value.trim();
      if (ins) s.instruction = ins.value;

      // 注意事项：把多行输入合并回一个「；」分隔的字符串，空行忽略
      const rows = host.querySelectorAll('[data-notice^="' + si + '-"]');
      if (rows.length) {
        const lines = [];
        rows.forEach((inp) => { const v = inp.value.trim(); if (v) lines.push(v); });
        s.notice = lines.join('；');
      }

      s.fields.forEach((f, fi) => {
        const n = document.querySelector('[data-field-name="' + si + '-' + fi + '"]');
        const u = document.querySelector('[data-field-unit="' + si + '-' + fi + '"]');
        const ty = document.querySelector('[data-field-type="' + si + '-' + fi + '"]');
        if (n) f.label = n.value.trim();
        if (u) f.unit = u.value.trim();
        if (ty) f.type = ty.value;
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
      draft.steps[Number(b.dataset.addField)].fields.push({ label: '', unit: '', type: 'text' });
      renderDraft();
    }));

    // 注意事项：添加一条 / 删除一条
    host.querySelectorAll('[data-add-notice]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const s = draft.steps[Number(b.dataset.addNotice)];
      s.notice = noticeLines(s).concat(['']).join('；');
      renderDraft();
    }));

    host.querySelectorAll('[data-drop-notice]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const parts = String(b.dataset.dropNotice).split('-');
      const s = draft.steps[Number(parts[0])];
      const lines = noticeLines(s);
      lines.splice(Number(parts[1]), 1);
      s.notice = lines.filter(Boolean).join('；');
      renderDraft();
    }));

    $('draft-add-step').addEventListener('click', () => {
      collectDraft();
      draft.steps.push({ title: '新步骤', instruction: '', duration_hint: '', notice: '', fields: [] });
      renderDraft();
    });

    $('draft-cancel').addEventListener('click', () => { draft = null; route('plans'); });

    $('draft-save').addEventListener('click', saveDraft);
  }

  /* 保存草稿：新建（来自 docx 导入）或更新（编辑已有方案） */
  async function saveDraft() {
    collectDraft();
    if (!draft.steps.length) { setStatus('至少保留一个步骤。', 'error'); return; }
    const title = draft.title.trim() || '未命名实验方案';
    const wasEdit = !!draft.id;

    const btn = $('draft-save');
    btn.disabled = true;
    try {
      let planId = draft.id;

      if (planId) {
        // 保存后内容就是「当前解析规则 + 手工改动」，因此标记为当前版本
        const { error } = await client.from(PLAN).update({ title: title, parse_version: PARSE_VERSION }).eq('id', planId);
        if (error) throw error;
        const { error: delErr } = await client.from(STEP).delete().eq('plan_id', planId);
        if (delErr) throw delErr;
      } else {
        const { data: plan, error } = await client.from(PLAN).insert({
          title: title, source: draft.source || '', user_id: state.user.id,
          parse_version: PARSE_VERSION,
        }).select().single();
        if (error) throw error;
        planId = plan.id;
      }

      const rows = draft.steps.map((s, i) => ({
        user_id: state.user.id,
        plan_id: planId,
        position: i,
        title: s.title || ('步骤 ' + (i + 1)),
        instruction: s.instruction || '',
        notice: s.notice || '',
        fields: s.fields,
        duration_hint: s.duration_hint || '',
      }));
      const { error: stepErr } = await client.from(STEP).insert(rows);
      if (stepErr) throw stepErr;

      draft = null;
      setStatus(wasEdit ? '方案已更新。' : '方案已保存。', 'ok');
      route('plans');
    } catch (err) {
      console.error('[SciHub] 保存方案失败：', err);
      setStatus('保存失败，请稍后重试。', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* 重命名（方案列表与详情页共用） */
  async function renamePlan(planId, currentTitle) {
    const name = window.prompt('新的方案名称', currentTitle || '');
    if (name == null) return;
    const title = name.trim();
    if (!title || title === currentTitle) return;

    const { error } = await client.from(PLAN).update({ title: title }).eq('id', planId);
    if (error) {
      console.error('[SciHub] 重命名失败：', error);
      setStatus('重命名失败，请稍后重试。', 'error');
      return;
    }
    setStatus('已重命名为「' + title + '」。', 'ok');
    if ($('view-plan').hidden) listPlans();
    else route('plan', planId);
  }

  /* 进入编辑模式：把已有方案载入可编辑草稿 */
  async function editPlan(planId) {
    const { data: plan } = await client.from(PLAN).select('*').eq('id', planId).maybeSingle();
    const { data: steps } = await client.from(STEP).select('*').eq('plan_id', planId).order('position');
    if (!plan) { setStatus('方案不存在。', 'error'); return; }

    draft = {
      id: plan.id,
      title: plan.title,
      source: plan.source || '',
      steps: (steps || []).map((s) => ({
        title: s.title || '',
        instruction: s.instruction || '',
        duration_hint: s.duration_hint || '',
        notice: s.notice || '',     // 少了这一行，编辑保存后注意事项会被清空
        fields: (s.fields || []).map((f) => ({ label: f.label, unit: f.unit || '', type: f.type || '' })),
      })),
    };
    renderDraft();
    showView('plan');
  }

  /* ══ 方案查看 / 编辑 ════════════════════════════════════ */

  async function renderEditor(planId) {
    const host = $('view-plan');
    host.innerHTML = '<div class="section-title">实验方案</div><div class="empty">加载中…</div>';

    const { data: plan } = await client.from(PLAN).select('*').eq('id', planId).maybeSingle();
    const { data: steps } = await client.from(STEP).select('*').eq('plan_id', planId).order('position');
    if (!plan) { host.innerHTML = '<div class="empty">方案不存在。</div>'; return; }

    // 按解析版本判断：落后于当前规则才显示「重新解析」
    const canUpgrade = planNeedsUpgrade(plan);

    host.innerHTML = [
      '<div class="section-title">' + esc(plan.title) + '</div>',
      '  <p class="hint small" style="margin-bottom:12px">' + (plan.source ? '来源：' + esc(plan.source) + ' · ' : '') + '共 ' + (steps || []).length + ' 个步骤</p>',
      (steps || []).map((s) => [
        '<div class="step-card">',
        '  <div class="step-head"><span class="step-no">' + (s.position + 1) + '</span>',
        '    <span class="step-title-text">' + esc(s.title) + '</span>',
        s.duration_hint ? '    <span class="tag-mini">' + esc(s.duration_hint) + '</span>' : '',
        '  </div>',
        '  <div class="step-instruction">' + highlight(s.instruction) + '</div>',
        s.notice ? '  <div class="notice-mini"><em>⚠ 注意</em><span>' + highlight(s.notice) + '</span></div>' : '',
        (s.fields || []).length ? '  <div class="hc-meta" style="margin-top:8px">数据字段：' + (s.fields || []).map((f) => esc(f.label) + (f.unit ? '（' + esc(f.unit) + '）' : '')).join('、') + '</div>' : '',
        '</div>',
      ].join('\n')).join(''),
      '<div class="run-actions">',
      '  <button type="button" class="primary" id="plan-start">开始实验</button>',
      '  <button type="button" class="ghost" id="plan-edit">编辑方案</button>',
      canUpgrade ? '  <button type="button" class="fresh-btn" id="plan-upgrade">重新解析</button>' : '',
      '  <button type="button" class="ghost" id="plan-rename">重命名</button>',
      '  <button type="button" class="ghost" id="plan-back">返回方案列表</button>',
      '</div>',
    ].join('\n');

    $('plan-back').addEventListener('click', () => route('plans'));
    $('plan-start').addEventListener('click', () => startRun(planId));
    $('plan-edit').addEventListener('click', () => editPlan(planId));
    const upBtn = $('plan-upgrade');
    if (upBtn) {
      upBtn.addEventListener('click', async () => {
        upBtn.disabled = true;
        try {
          await upgradePlan(planId);
          renderEditor(planId);
        } catch (err) {
          console.error('[SciHub] 更新方案失败：', err);
          setStatus('更新失败：' + errorText(err), 'error');
          upBtn.disabled = false;
        }
      });
    }
    $('plan-rename').addEventListener('click', () => renamePlan(planId, plan.title));
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
        notice: s.notice || '',
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

  const run = { id: null, data: null, steps: [], pos: 0, saveTimer: null, urls: {}, urlErrors: {}, drift: { fields: [] } };

  /* 对比「本次实验的快照」与「方案当前内容」，找出方案里新增的字段。
     用途：方案更新后提醒用户 —— 这些参数是实验开始之后才加进方案的，快照里没有。 */
  async function planDrift(r) {
    if (!r || !r.plan_id) return { fields: [] };
    const { data: planSteps } = await client.from(STEP).select('position,fields').eq('plan_id', r.plan_id).order('position');
    if (!planSteps || !planSteps.length) return { fields: [] };

    const runKeys = new Set();
    run.steps.forEach((s) => (s.fields || []).forEach((f) => runKeys.add(s.position + '::' + fieldKey(f.label))));

    const added = [];
    planSteps.forEach((ps) => {
      (ps.fields || []).forEach((f) => {
        if (runKeys.has(ps.position + '::' + fieldKey(f.label))) return;
        added.push({ position: ps.position, label: f.label, unit: f.unit || '' });
      });
    });
    return { fields: added };
  }

  /* 把方案里新增的字段补进本次实验 —— 只追加，已有填写数据一律不动 */
  async function syncRunFields() {
    const drift = (run.drift && run.drift.fields) || [];
    if (!drift.length) return;

    try {
      for (const item of drift) {
        const s = run.steps.find((x) => x.position === item.position);
        if (!s) continue;

        const have = new Set((s.fields || []).map((f) => fieldKey(f.label)));
        if (have.has(fieldKey(item.label))) continue;

        s.fields = (s.fields || []).concat([{ label: item.label, unit: item.unit }]);
        const { error } = await client.from(RUN_STEP).update({ fields: s.fields }).eq('id', s.id);
        if (error) throw error;
      }

      run.drift = { fields: [] };
      setStatus('已按最新方案补齐参数，原有数据未改动。', 'ok');
      drawRun();
    } catch (err) {
      console.error('[SciHub] 补齐参数失败：', err);
      setStatus('补齐失败：' + errorText(err), 'error');
    }
  }

  async function renderRun(runId) {
    const host = $('view-run');
    host.innerHTML = '<div class="empty">加载中…</div>';

    const { data: r } = await client.from(RUN).select('*').eq('id', runId).maybeSingle();
    const { data: steps } = await client.from(RUN_STEP).select('*').eq('run_id', runId).order('position');
    if (!r) { host.innerHTML = '<div class="empty">实验记录不存在。</div>'; return; }

    run.id = runId;
    run.data = r;
    run.steps = steps || [];
    // 「继续」时回到上次所在的那一步（current_step 是存在云端的，换设备也一致）
    run.pos = Math.min(r.current_step || 0, Math.max(0, run.steps.length - 1));
    run.urls = {};
    run.urlErrors = {};
    run.drift = { fields: [] };

    // 预取图片的签名地址（私有 bucket）：一次批量签名，并记录失败原因给缩略图提示
    const paths = [];
    run.steps.forEach((s) => (s.images || []).forEach((img) => { if (img && img.path) paths.push(img.path); }));

    if (paths.length) {
      const { data: signedList, error: signError } = await client.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 24);
      (signedList || []).forEach((item) => {
        if (item && item.path && item.signedUrl) run.urls[item.path] = item.signedUrl;
        else if (item && item.path) run.urlErrors[item.path] = errorText(item.error) || '无法读取';
      });
      if (signError) {
        console.warn('[SciHub] 图片签名失败：', signError);
        const msg = errorText(signError);
        paths.forEach((p) => { if (!run.urls[p]) run.urlErrors[p] = msg; });
      }
    }

    // 方案后续被更新过？记录差异，供界面提醒用户手动补参数
    try { run.drift = await planDrift(r); } catch (err) { console.warn('[SciHub] 差异检查失败：', err); }

    subscribeRun(runId);   // 多端实时同步
    drawRun();
  }

  /* ── 多端实时同步：订阅这条实验的 run_steps 变化 ───────── */

  let runChannel = null;

  function subscribeRun(runId) {
    unsubscribeRun();
    try {
      runChannel = client
        .channel('run-steps-' + runId)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'run_steps', filter: 'run_id=eq.' + runId,
        }, (payload) => {
          // 本机正在输入时不打断（避免把他端推来的内容盖到用户光标上）
          if (run.saveTimer) return;
          const row = payload.new || payload.old;
          if (!row || row.id == null) return;

          const idx = run.steps.findIndex((x) => x.id === row.id);
          if (idx === -1) return;

          run.steps[idx] = Object.assign({}, run.steps[idx], row);
          if (idx === run.pos) drawRun();
        })
        .subscribe();
    } catch (err) {
      console.warn('[SciHub] 实时同步不可用（不影响保存）：', err);
    }
  }

  function unsubscribeRun() {
    if (!runChannel) return;
    try { client.removeChannel(runChannel); } catch (_error) { /* 忽略 */ }
    runChannel = null;
  }

  function drawRun() {
    const host = $('view-run');
    const s = run.steps[run.pos];
    if (!s) { host.innerHTML = '<div class="empty">没有可执行的步骤。</div>'; return; }

    const done = run.steps.filter((x) => x.status === 'done').length;
    const pct = Math.round((done / run.steps.length) * 100);
    const isLast = run.pos === run.steps.length - 1;
    const resumed = (run.data.current_step || 0) === run.pos && run.pos > 0;
    const drift = (run.drift && run.drift.fields) || [];

    host.innerHTML = [
      '<div class="run-head">',
      '  <div><b>' + esc(run.data.title) + '</b>',
      '    <div class="hc-meta">开始于 ' + fmt(run.data.started_at) + ' · 已进行 ' + sinceText(run.data.started_at) + (run.data.status === 'done' ? ' · 已完成' : '') + '</div>',
      '  </div>',
      '  <div class="hc-actions"><button type="button" class="ghost" id="run-exit">返回主页</button></div>',
      '</div>',
      '<div class="progress"><i style="width:' + pct + '%"></i></div>',
      '<div class="hc-meta" style="margin-bottom:10px">第 ' + (run.pos + 1) + ' / ' + run.steps.length + ' 步 · 已完成 ' + done + ' 步'
        + (resumed ? ' · <b>上次停在这里</b>' : '')
        + (run.data.updated_at ? ' · 上次保存 ' + fmt(run.data.updated_at) : '') + '</div>',
      drift.length ? [
        '<div class="drift">',
        '  <div class="drift-body">',
        '    <b>方案已更新：' + drift.length + ' 个参数不在本次实验里</b>',
        '    <span>' + drift.map((d) => '第 ' + (d.position + 1) + ' 步「' + esc(d.label) + (d.unit ? '（' + esc(d.unit) + '）' : '') + '」').join('、') + '</span>',
        '    <em>本次实验沿用开始时的版本，已填数据不受影响。可点右侧「补齐参数」把它们加进来，再手动填写数值。</em>',
        '  </div>',
        '  <button type="button" class="ghost" id="run-sync-fields">补齐参数</button>',
        '</div>',
      ].join('\n') : '',
      '<div class="run-step-card">',
      '  <h2>第 ' + (run.pos + 1) + ' 步：' + esc(s.title) + '</h2>',
      s.duration_hint ? '  <span class="dur">时长提示：' + highlight(s.duration_hint) + '</span>' : '',
      s.notice ? [
        '  <div class="notice">',
        '    <span class="notice-icon" aria-hidden="true">⚠</span>',
        '    <div class="notice-body"><b>注意事项</b><span>' + highlight(s.notice) + '</span></div>',
        '  </div>',
      ].join('\n') : '',
      '  <div class="instr">' + highlight(s.instruction) + '</div>',
      pyroBlock(s),
      '  <div id="fields"></div>',
      '  <div style="margin-top:14px">',
      '    <div class="hc-meta">实验照片 / 视频</div>',
      '    <div class="photos" id="photos"></div>',
      // 不加 capture：否则手机上只会直接开相机，无法从相册里选已有视频
      '    <input type="file" id="photo-input" accept="image/*,video/*" hidden>',
      '    <input type="file" id="photo-gallery" accept="image/*,video/*" multiple hidden>',
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
    bindPyro(s);

    $('run-exit').addEventListener('click', () => route('home'));
    $('run-prev').addEventListener('click', () => { run.pos--; drawRun(); });
    $('run-next').addEventListener('click', () => (isLast ? finishRun() : nextStep()));
    const syncBtn = $('run-sync-fields');
    if (syncBtn) syncBtn.addEventListener('click', syncRunFields);

    $('photo-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      const target = run.steps[run.pos];   // 记下「此刻」是哪一步，避免上传完成时串到下一步
      if (f) uploadPhotos([f], target);
      e.target.value = '';
    });

    $('photo-gallery').addEventListener('change', (e) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      const target = run.steps[run.pos];
      if (files.length) uploadPhotos(files, target);
      e.target.value = '';
    });
  }

  /* 兼容旧数据：字段名里带「时间 / 时刻 / 日期」时按时间类处理（新方案走 fieldTypeOf） */
  function isTimeField(label) {
    return /时间|时刻|日期/.test(String(label || ''));
  }

  /* 从已存的自由文本里尽量拆出日期与时间（兼容 "2026-09-11 15:44"、"15:44"、"2026-09-11"） */
  function splitDateTime(value) {
    const text = String(value == null ? '' : value).trim();
    const dm = text.match(/\d{4}-\d{2}-\d{2}/);
    const tm = text.match(/(\d{1,2}):(\d{2})/);
    return {
      date: dm ? dm[0] : '',
      time: tm ? (String(tm[1]).padStart(2, '0') + ':' + tm[2]) : '',
    };
  }

  /* ── 热解程序计算器 ───────────────────────────────────────
     程序写法：
       C<温度>   温度点（程序里第一个 C 就是室温）
       T<时长>   该段耗时，描述「上一个温度点 → 下一个温度点」这一段
       --<数字>  终止标记
     例：C30-T60-C30-T184-C950-T60-C950--121
       30℃ 保温 60 min → 30℃→950℃ 升温（184 min）→ 950℃ 保温 60 min → 终止
     升温段的耗时由「温升 ÷ 速率」决定，所以室温一变就要重算 —— 这就是计算器的用处。 */

  /* 从步骤文字里找出热解程序（识别不到就返回空串） */
  function findPyroSeq(text) {
    const m = String(text || '').match(/C-?\d+(?:\.\d+)?(?:\s*[-–—,，]?\s*[CT]-?\d+(?:\.\d+)?)+(?:\s*[-–—]+\s*\d*)?/i);
    return m ? m[0].replace(/\s+/g, '').replace(/[–—，,]/g, '-') : '';
  }

  /* 拆成 [{kind:'temp'|'time'|'end', value}] */
  function pyroParts(seq) {
    const text = String(seq || '').replace(/\s+/g, '');
    const out = [];
    // 程序各段用「-」相连（C30-T60-C30-T184-…--121），所以不能先按「-」切分再逐段解析 ——
    // 那样每段都会带上一个前导「-」，^C\d / ^T\d 全都匹配不上。
    // 这里改成整体扫描，遇到 C / T / -- 就取一个。
    const re = /C(-?\d+(?:\.\d+)?)|T(-?\d+(?:\.\d+)?)|--(\d*)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1] !== undefined) out.push({ kind: 'temp', value: Number(m[1]) });
      else if (m[2] !== undefined) out.push({ kind: 'time', value: Number(m[2]) });
      else out.push({ kind: 'end', value: Number(m[3]) || 0 });
    }
    return out;
  }

  /* 按室温与升温速率重算，返回 { segs, total, oldRoom, room } */
  function calcPyro(seq, roomTemp, rate) {
    const parts = pyroParts(seq);
    const temps = parts.filter((p) => p.kind === 'temp');
    if (!temps.length) return null;

    const oldRoom = temps[0].value;                 // 程序里第一个温度点＝当初的室温
    const room = Number(roomTemp);
    const useRoom = Number.isFinite(room) && room !== 0;

    // 关键：室温在程序里往往出现多次（C30-T60-C30-… 里开头一次、「回到室温」又一次），
    // 必须一起替换 —— 只换第一个的话，前后温度对不上，保温段会被误判成升温段。
    if (useRoom) {
      parts.forEach((p) => { if (p.kind === 'temp' && p.value === oldRoom) p.value = room; });
    }

    const r = Number(rate) > 0 ? Number(rate) : 0;
    const segs = [];
    let total = 0;
    let last = null;

    parts.forEach((p, i) => {
      if (p.kind === 'temp') { last = p.value; return; }
      if (p.kind !== 'time') return;                // end 标记不参与计算

      const next = (parts.slice(i + 1).find((x) => x.kind === 'temp') || {}).value;
      const from = last;
      const to = next;

      let minutes = p.value;
      let ramp = false;
      // 前后温度不同 → 这是升温段，耗时由温升与速率决定（覆盖程序里写死的旧值）
      if (from != null && to != null && to !== from && r > 0) {
        ramp = true;
        minutes = Math.round((Math.abs(to - from) / r) * 10) / 10;
      }
      segs.push({ from, to, minutes, ramp });
      total += minutes;
    });

    return { segs, total, oldRoom, room: useRoom ? room : oldRoom };
  }

  /* 从程序反推升温速率（取第一个升温段） */
  function guessPyroRate(seq) {
    const parts = pyroParts(seq);
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.kind === 'temp') { last = p.value; continue; }
      if (p.kind !== 'time' || last == null) continue;
      const next = (parts.slice(i + 1).find((x) => x.kind === 'temp') || {}).value;
      if (next != null && next !== last && p.value > 0) {
        return Math.round((Math.abs(next - last) / p.value) * 100) / 100;
      }
    }
    return 5;
  }

  /* 判断这段文字是不是「完整的热解程序」。
     必须够严格 —— 普通步骤里偶尔出现 C30、T60 这类字样不能算，
     否则每一步都会冒出个计算器。判定依据：
       · 至少 3 个温度点 + 2 段时长（真正的程序都是多段的）
       · 温度跨度 ≥ 100℃（热解必然大幅升温）
       · 且带终止标记（--N），或最高温 ≥ 300℃ */
  function looksLikePyro(seq) {
    const parts = pyroParts(seq);
    const temps = parts.filter((p) => p.kind === 'temp').map((p) => p.value);
    const times = parts.filter((p) => p.kind === 'time');
    if (times.length < 2 || temps.length < 3) return false;

    const maxT = Math.max.apply(null, temps);
    const minT = Math.min.apply(null, temps);
    if (maxT - minT < 100) return false;

    return parts.some((p) => p.kind === 'end') || maxT >= 300;
  }

  /* 执行界面里那块可折叠的计算器（不是热解程序就不渲染） */
  function pyroBlock(s) {
    const seq = findPyroSeq(s.instruction || '');
    if (!seq || !looksLikePyro(seq)) return '';

    const parts = pyroParts(seq);
    const room = (parts.find((p) => p.kind === 'temp') || {}).value;
    const rate = guessPyroRate(seq);

    return [
      '<details class="pyro">',
      '  <summary>🔥 热解程序计算器</summary>',
      '  <div class="pyro-body">',
      '    <label class="pyro-field">热解程序<input id="pyro-seq" value="' + esc(seq) + '" spellcheck="false"></label>',
      '    <div class="pyro-grid">',
      '      <label class="pyro-field">室温（℃）<input type="number" step="any" inputmode="decimal" id="pyro-room" value="' + esc(room) + '"></label>',
      '      <label class="pyro-field">升温速率（℃/min）<input type="number" step="any" inputmode="decimal" id="pyro-rate" value="' + esc(rate) + '"></label>',
      '    </div>',
      '    <div id="pyro-out"></div>',
      '  </div>',
      '</details>',
    ].join('\n');
  }

  function drawPyro() {
    const out = $('pyro-out');
    if (!out) return;

    const res = calcPyro($('pyro-seq').value, $('pyro-room').value, $('pyro-rate').value);
    if (!res || !res.segs.length) {
      out.innerHTML = '<p class="hint small">没识别出程序。示例：C30-T60-C30-T184-C950-T60-C950--121</p>';
      return;
    }

    out.innerHTML = [
      '<div class="pyro-result">',
      res.segs.map((g) => {
        const from = g.from == null ? '—' : g.from + '℃';
        const to = g.to == null ? '—' : g.to + '℃';
        const what = g.ramp ? '升温' : (g.from === g.to ? '保温' : '降温');
        return '<div class="pyro-line"><b>' + what + '</b><span>' + esc(from + ' → ' + to) + '</span><em>' + g.minutes + ' min</em></div>';
      }).join(''),
      '<div class="pyro-total">合计 <b>' + Math.round(res.total * 10) / 10 + ' min</b>'
        + '（约 ' + (Math.round(res.total / 6) / 10) + ' h）· 室温 ' + res.room + '℃ · 速率 ' + esc(String($('pyro-rate').value)) + ' ℃/min</div>',
      '</div>',
    ].join('');
  }

  function bindPyro() {
    if (!$('pyro-seq')) return;
    drawPyro();
    ['pyro-seq', 'pyro-room', 'pyro-rate'].forEach((id) => {
      const node = $(id);
      if (node) node.addEventListener('input', drawPyro);
    });
  }

  function drawFields(s) {
    const host = $('fields');
    const fields = s.fields || [];
    if (!fields.length) {
      host.innerHTML = '<p class="hint small">这一步没有预设字段，可在下方备注里记录。</p>';
    } else {
      host.innerHTML = fields.map((f, i) => {
        const value = (s.values || {})[f.label] || '';
        const type = fieldTypeOf(f);
        const head = '<label>' + esc(f.label) + (f.unit ? '<span class="unit">(' + esc(f.unit) + ')</span>' : '') + '</label>';
        const parts = splitDateTime(value);

        // 时间 / 日期 / 日期+时间：用原生选择器，避免手打出格式错误
        if (type === 'datetime' || type === 'date' || type === 'time') {
          const cells = [];
          if (type !== 'time') cells.push('<input type="date" data-key="' + i + '" data-part="date" value="' + esc(parts.date) + '">');
          if (type !== 'date') cells.push('<input type="time" data-key="' + i + '" data-part="time" value="' + esc(parts.time) + '">');
          return [
            '<div class="data-field">',
            '  ' + head,
            '  <div class="dt-row">',
            '    ' + cells.join('\n    '),
            '  </div>',
            '</div>',
          ].join('\n');
        }

        // 数字：用 number 控件，手机上会弹数字键盘，也能挡住非数字输入
        if (type === 'number') {
          return [
            '<div class="data-field">',
            '  ' + head,
            '  <input type="number" step="any" inputmode="decimal" data-key="' + i + '" value="' + esc(value) + '">',
            '</div>',
          ].join('\n');
        }

        return [
          '<div class="data-field">',
          '  ' + head,
          '  <input data-key="' + i + '" value="' + esc(value) + '">',
          '</div>',
        ].join('\n');
      }).join('');
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

        if (inp.dataset.part) {
          // 日期与时间分两个控件，合并成 "YYYY-MM-DD HH:mm" 存库
          let date = '';
          let time = '';
          host.querySelectorAll('[data-key="' + inp.dataset.key + '"]').forEach((node) => {
            if (node.dataset.part === 'date') date = node.value;
            if (node.dataset.part === 'time') time = node.value;
          });
          s.values[f.label] = (date + ' ' + time).trim();
        } else {
          s.values[f.label] = inp.value;
        }

        scheduleSave(s);
      });
    });
    const nt = host.querySelector('[data-note]');
    nt.addEventListener('input', () => { s.note = nt.value; scheduleSave(s); });
  }

  /* 判断一条媒体是不是视频（上传时记了 type；老数据按扩展名兜底） */
  function isVideoFile(img) {
    if (!img) return false;
    if (/^video\//.test(img.type || '')) return true;
    return /\.(mp4|mov|m4v|webm|avi|3gp)$/i.test(String(img.path || ''));
  }

  function drawPhotos(s) {
    const host = $('photos');
    const images = s.images || [];

    host.innerHTML = images.map((img, idx) => {
      const video = isVideoFile(img);
      const url = run.urls[img.path];
      let inner;

      if (!url) {
        inner = '<span class="photo-loading">'
          + ((run.urlErrors || {})[img.path] ? '⚠️ ' + esc(run.urlErrors[img.path]) : '准备中…')
          + '</span>';
      } else if (video) {
        // preload=metadata 只取首帧当封面，不会把整个视频下载下来
        inner = '<video src="' + esc(url) + '" muted preload="metadata" playsinline></video>'
          + '<span class="media-play" aria-hidden="true">▶</span>';
      } else {
        inner = '<img src="' + esc(url) + '" alt="' + esc(img.caption || img.name || '照片') + '">';
      }

      return [
        '<figure class="photo" data-path="' + esc(img.path) + '">',
        '  <button type="button" class="photo-open" data-zoom="' + idx + '" title="' + (video ? '点击播放' : '点击放大查看') + '">',
        '    ' + inner,
        '  </button>',
        '  <button type="button" class="photo-drop" data-drop="' + esc(img.path) + '" title="删除">×</button>',
        '  <input class="photo-caption" data-caption="' + esc(img.path) + '" value="' + esc(img.caption || '') + '" placeholder="加个注解…" maxlength="120">',
        '</figure>',
      ].join('\n');
    }).join('');

    const camera = el('button', { type: 'button', class: 'photo-add' }, '📷<br>拍照 / 录像');
    camera.addEventListener('click', () => $('photo-input').click());
    host.appendChild(camera);

    const gallery = el('button', { type: 'button', class: 'photo-add' }, '🖼️<br>相册多选');
    gallery.addEventListener('click', () => $('photo-gallery').click());
    host.appendChild(gallery);

    // 点缩略图放大
    host.querySelectorAll('[data-zoom]').forEach((b) => {
      b.addEventListener('click', () => openLightbox(s, Number(b.dataset.zoom)));
    });

    // 注解：停手 1 秒后随其它字段一起存库
    host.querySelectorAll('[data-caption]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const target = (s.images || []).find((x) => x.path === inp.dataset.caption);
        if (!target) return;
        target.caption = inp.value;
        scheduleSave(s);
      });
    });

    host.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', async () => {
      const path = b.dataset.drop;
      if (!window.confirm('删除这张照片？')) return;
      await client.storage.from(BUCKET).remove([path]);
      s.images = (s.images || []).filter((x) => x.path !== path);
      await saveStep(s, true);
      drawPhotos(s);
    }));
  }

  /* ── 灯箱：放大查看 / 播放 / 存到设备 ─────────────────── */

  /* 浏览器出于安全限制不能静默写入系统相册，所以这里优先调「系统分享面板」
     （手机上会弹出「存储图像 / 视频」，点一下就进相册），不支持时退化为下载。 */
  async function saveMediaToDevice(item) {
    const url = run.urls[item.path];
    if (!url) { setStatus('这个文件还没准备好，稍后再试。', 'warn'); return; }

    try {
      const video = isVideoFile(item);
      const res = await fetch(url);
      const blob = await res.blob();
      const name = String(item.name || (video ? 'video.mp4' : 'photo.jpg')).replace(/[^\w.\-]/g, '_');
      const file = new File([blob], name, { type: blob.type || item.type || '' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        setStatus('已弹出系统面板，选「存储图像 / 视频」即可存进相册。', 'ok');
        return;
      }

      // 桌面浏览器或旧版：落到「下载」文件夹
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      setStatus('已保存到「下载」文件夹。', 'ok');
    } catch (err) {
      if (err && err.name === 'AbortError') return;      // 用户取消分享，不算失败
      console.error('[SciHub] 保存失败：', err);
      setStatus('保存失败：' + errorText(err), 'error');
    }
  }

  function openLightbox(s, start) {
    const images = s.images || [];
    if (!images.length) return;

    let pos = Math.max(0, Math.min(start || 0, images.length - 1));
    const many = images.length > 1;

    const box = el('div', { class: 'lightbox' }, [
      '<button type="button" class="lb-btn lb-close" data-lb="close" title="关闭（Esc）">×</button>',
      many ? '<button type="button" class="lb-btn lb-prev" data-lb="prev" title="上一个（←）">‹</button>' : '',
      '<figure class="lb-stage">',
      '  <div id="lb-media"></div>',
      '  <figcaption id="lb-cap"></figcaption>',
      '</figure>',
      many ? '<button type="button" class="lb-btn lb-next" data-lb="next" title="下一个（→）">›</button>' : '',
      '<div class="lb-foot">',
      many ? '  <div class="lb-count" id="lb-count"></div>' : '',
      '  <button type="button" class="ghost" id="lb-save" title="会弹出系统面板供你存储到相册">⬇ 存到相册</button>',
      '</div>',
    ].join(''));

    function paint() {
      const item = images[pos];
      const host = box.querySelector('#lb-media');
      const url = run.urls[item.path] || '';

      // 每次切换都重建节点：视频切走时才不会在后台继续播放
      host.innerHTML = isVideoFile(item)
        ? '<video src="' + esc(url) + '" controls playsinline preload="metadata"></video>'
        : '<img src="' + esc(url) + '" alt="' + esc(item.caption || item.name || '照片') + '">';

      box.querySelector('#lb-cap').textContent = item.caption || '';
      const counter = box.querySelector('#lb-count');
      if (counter) counter.textContent = (pos + 1) + ' / ' + images.length;
    }

    function close() {
      document.removeEventListener('keydown', onKey);
      box.remove();
    }

    function move(delta) {
      pos = (pos + delta + images.length) % images.length;
      paint();
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === 'ArrowRight') move(1);
    }

    box.addEventListener('click', (e) => {
      const act = e.target.closest('[data-lb]');
      if (act) {
        const what = act.dataset.lb;
        if (what === 'close') close();
        else if (what === 'prev') move(-1);
        else if (what === 'next') move(1);
        return;
      }
      if (e.target === box) close();   // 点空白处也关闭
    });

    // 存到相册/设备（存的是当前正在看的这一张或这一段）
    box.querySelector('#lb-save').addEventListener('click', () => saveMediaToDevice(images[pos]));

    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
    paint();
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

  /* ── 图片上传（支持一次多张）─────────────────────────── */

  /* 手机原图动辄 5~10 MB，先缩到长边 1600px 再上传：成功率高、省流量、加载也快。
     任何一步失败都回退成原图，绝不因为压缩而让用户传不了照片。 */
  async function compressImage(file) {
    if (!/^image\//.test(file.type || '') || /gif|svg/i.test(file.type || '')) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const maxSide = 1600;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      if (scale >= 1 && file.size < 2 * 1024 * 1024) { if (bitmap.close) bitmap.close(); return file; }

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      const name = String(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
      return new File([blob], name, { type: 'image/jpeg' });
    } catch (err) {
      console.warn('[SciHub] 图片压缩失败，改为上传原图：', err);
      return file;
    }
  }

  /* 把各种形态的错误统一成一句人能看懂的话 */
  function errorText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    if (err.error) return String(err.error);
    if (err.statusCode) return 'HTTP ' + err.statusCode;
    try { return JSON.stringify(err); } catch (_e) { return String(err); }
  }

  /* targetStep：上传按钮被点击时所在的那一步。
     必须显式传入 —— 上传要压缩 + 走网络，期间用户完全可能已经翻到下一步，
     若在这里读 run.steps[run.pos]，照片就会挂到错误的步骤上。 */
  async function uploadPhotos(files, targetStep) {
    const list = Array.from(files || []);
    const s = targetStep || run.steps[run.pos];
    if (!list.length || !s) return;

    let ok = 0;
    let lastError = '';
    for (let i = 0; i < list.length; i++) {
      $('autosave').textContent = '上传中… ' + (i + 1) + ' / ' + list.length;
      const result = await uploadPhoto(list[i], true, s);
      if (result === true) ok++;
      else if (typeof result === 'string') lastError = result;
    }

    $('autosave').textContent = (ok === list.length)
      ? ('已上传 ' + ok + ' 个 · ' + fmt(now()))
      : ('已上传 ' + ok + ' / ' + list.length + ' 个' + (lastError ? '：' + lastError : ''));
    // 只有还停在这一步时才重绘，否则会把用户当前看的步骤界面刷掉
    if (run.steps[run.pos] === s) drawPhotos(s);
  }

  async function uploadPhoto(file, silent, targetStep) {
    const s = targetStep || run.steps[run.pos];
    const say = (txt) => { $('autosave').textContent = txt; };

    if (!silent) say('上传中…');

    try {
      const payload = await compressImage(file);
      const stamp = Date.now() + '-' + Math.floor(Math.random() * 100000);
      const safe = String(payload.name || 'photo.jpg').replace(/[^\w.\-]/g, '_');
      // 第一段目录必须是当前用户 id，才符合 Storage 的「只能读写自己目录」策略
      const path = state.user.id + '/' + run.id + '/' + s.position + '/' + stamp + '-' + safe;

      const { error } = await client.storage.from(BUCKET).upload(path, payload, {
        upsert: false,
        contentType: payload.type || 'image/jpeg',
      });
      if (error) throw error;

      const { data: signed } = await client.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24);
      if (signed) run.urls[path] = signed.signedUrl;

      s.images = (s.images || []).concat([{
        path: path,
        name: file.name || 'photo',
        type: payload.type || file.type || '',   // 用来区分照片与视频
        caption: '',
        at: new Date().toISOString(),
      }]);
      await saveStep(s, true);
      if (!silent) drawPhotos(s);
      return true;
    } catch (err) {
      console.error('[SciHub] 上传失败：', err, '| 文件：', file && file.name, file && file.size);
      const msg = errorText(err);
      say('上传失败：' + msg);
      return msg;
    }
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

  /* 把「数值 + 单位」标成醒目样式：药品用量、温度、时间、转速等关键参数 */
  const KEY_UNIT = 'g|mg|kg|mL|μL|L|mol|mmol|M|h|min|s|rpm|℃|°C|%|V|mA|mV';

  function highlight(text) {
    const safe = esc(text == null ? '' : text);
    const re = new RegExp('(\\d+(?:\\.\\d+)?(?:\\s*[–—~-]\\s*\\d+(?:\\.\\d+)?)?)\\s*(' + KEY_UNIT + ')(?![0-9A-Za-z])', 'g');
    return safe.replace(re, '<span class="key-num">$1 $2</span>');
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

  /* 重命名一次实验（只改实验标题，不动方案） */
  async function renameRun(runId, currentTitle) {
    const name = window.prompt('新的实验名称', currentTitle || '');
    if (name == null) return;
    const title = name.trim();
    if (!title || title === currentTitle) return;

    const { error } = await client.from(RUN).update({ title: title }).eq('id', runId);
    if (error) {
      console.error('[SciHub] 重命名实验失败：', error);
      setStatus('重命名失败，请稍后重试。', 'error');
      return;
    }
    setStatus('已重命名为「' + title + '」。', 'ok');
    route('home');
  }

  /* 删除一次实验：连同它的照片一起清理（Storage 不随表级联删除） */
  async function removeRun(runId) {
    if (!window.confirm('删除这次实验？它的所有填写数据与照片都会被永久删除，无法恢复。')) return;

    try {
      const { data: steps } = await client.from(RUN_STEP).select('images').eq('run_id', runId);
      const paths = [];
      (steps || []).forEach((s) => {
        (s.images || []).forEach((img) => { if (img && img.path) paths.push(img.path); });
      });
      if (paths.length) await client.storage.from(BUCKET).remove(paths);

      const { error } = await client.from(RUN).delete().eq('id', runId); // run_steps 随之级联删除
      if (error) throw error;

      setStatus('实验已删除。', 'ok');
      route('home');
    } catch (err) {
      console.error('[SciHub] 删除实验失败：', err);
      setStatus('删除失败，请稍后重试。', 'error');
    }
  }

  window.Run = { render: renderRun, running: runningRuns, rename: renameRun, remove: removeRun };

  // 通知 app.js：实验模块已就绪（两个脚本并行下载，首页靠这个信号补渲染）
  window.dispatchEvent(new CustomEvent('scihub:ready'));
})();
