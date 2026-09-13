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
          // 只有真的写了热解程序的步骤才会带上「热解板块」（马弗炉/管式炉的升温曲线）
          pyro_seq: detectPyroSeq(text),
        };
      }),
    };
  }

  /* 从一段文字里挑出可用的热解程序；没有或格式不像就返回空串 */
  function detectPyroSeq(text) {
    const seq = findPyroSeq(text);
    return (seq && looksLikePyro(seq)) ? seq : '';
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
        // 热解程序：AI 给了就用，否则从说明里识别；都没有就留空（不显示热解板块）
        pyro_seq: String((s && s.pyro_seq) || '').trim() || detectPyroSeq(s && s.instruction),
        fields: fields,
      };
    });

    return {
      title: String(raw.title || '未命名实验方案').trim(),
      steps: out,
    };
  }

  /* 把「同一道工序」被拆成的相邻步骤合并掉。
     解析器（尤其是规则解析）常把一个工序的几行拆成好几步，例如
     「950℃热解」与紧随其后的「热解后冷却、称量」。
     判定：相邻两步标题互为子串（忽略标点）；或后一步以「继续/随后/接着…」开头。
     合并时标题取较短的（更概括），说明按顺序拼接，字段/注意事项/热解程序一并合并。 */
  function mergeAdjacentSteps(steps) {
    if (!steps || steps.length < 2) return steps || [];

    const key = (s) => String(s || '').replace(/[\s（）()【】\[\]：:、，,。.·—\-]/g, '');
    // 再去掉括号里的补充说明，便于比对「950℃热解」与「950℃热解后冷却称量」
    const norm = (s) => key(s).replace(/[（(][^）)]*[）)]/g, '');
    const out = [];

    steps.forEach((s) => {
      const prev = out[out.length - 1];
      if (prev) {
        const a = key(prev.title);
        const b = key(s.title);
        const an = norm(prev.title);
        const bn = norm(s.title);
        const stem = 4;   // 开头若干个字相同即视为同一工序（如「950℃热解」）

        const related = (a && b && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1))
          || (an.length >= stem && bn.length >= stem && an.slice(0, stem) === bn.slice(0, stem))
          || /^(继续|随后|接着|然后|之后)/.test(String(s.title || ''));

        if (related) {
          if (b && (!a || b.length < a.length)) prev.title = s.title;
          prev.instruction = [prev.instruction, s.instruction].filter(Boolean).join('\n');
          if (s.notice) prev.notice = [prev.notice, s.notice].filter(Boolean).join('；');
          if (!prev.pyro_seq && s.pyro_seq) prev.pyro_seq = s.pyro_seq;
          if (!prev.duration_hint && s.duration_hint) prev.duration_hint = s.duration_hint;

          const have = new Set((prev.fields || []).map((f) => f.label));
          (s.fields || []).forEach((f) => {
            if (have.has(f.label)) return;
            have.add(f.label);
            prev.fields = (prev.fields || []).concat([f]);
          });
          return;
        }
      }
      out.push(Object.assign({}, s, { fields: (s.fields || []).slice() }));
    });

    // 合并后重新编号，保证 position 连续
    return out.map((s, i) => Object.assign({}, s, { position: i }));
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
       v4：步骤粒度按工序归并（同一工序的多行描述不再被拆成好几步）
     注：版本号只在内部用，不展示给用户。 */
  const PARSE_VERSION = 4;

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

    const { data, error } = await client.from(PLAN).select('id,title,source,created_at,parse_version').order('created_at', { ascending: false });
    if (error) {
      host.querySelector('.empty').textContent = '方案暂时无法加载，请稍后重试。';
      console.error('[SciHub] 方案读取失败：', error);
      return;
    }

    const cards = (data || []).map((p) => [
      '<article class="plan-card clickable" data-open="' + p.id + '" role="button" tabindex="0" title="查看方案详情">',
      '  <div class="hc-main">',
      '    <div class="hc-title">' + esc(p.title) + '</div>',
      '    <div class="hc-meta">' + (p.source ? esc(p.source) + ' · ' : '') + fmt(p.created_at) + '</div>',
      '  </div>',
      planNeedsUpgrade(p)
        ? '  <span class="ver-stale" title="这个方案还没用上最新的解析功能，可在详情页重新解析">可重新解析</span>'
        : '',
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

    // 整卡进详情。操作按钮一律不放在这里 —— 开始实验 / 编辑 / 重命名 / 删除 / 重新解析
    // 全部收在方案详情页，保证每个功能只有一个入口。
    host.querySelectorAll('[data-open]').forEach((card) => {
      const open = () => route('plan', Number(card.dataset.open));
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
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
      // 解析常把同一工序拆成多步（例如「950℃热解」+「热解后冷却称量」），这里自动合并一次，
      // 合并结果仍会展示在校对页，可以手动再调。
      draft.steps = mergeAdjacentSteps(draft.steps);
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

  /* 这一步的文字里是否提到热解相关工序 —— 用来决定要不要显示「热解程序」板块 */
  function isPyroText(s) {
    const hay = String((s && s.title) || '') + '\n' + String((s && s.instruction) || '');
    return /热解|碳化|煅烧|管式炉|程序升温|pyrolysis/i.test(hay);
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
        '  <div class="step-head">',
        // 拖动手柄：只有手柄可拖，免得在输入框里选文字时误触发拖动
        '    <span class="drag-handle" draggable="true" data-drag-step="' + si + '" title="拖动调整步骤顺序">⠿</span>',
        '    <span class="step-no">' + (si + 1) + '</span>',
        '    <input class="step-title-text" data-title="' + si + '" value="' + esc(s.title) + '" placeholder="步骤标题">',
        '    <button type="button" class="ghost" data-drop-step="' + si + '">删除步骤</button>',
        '  </div>',
        '  <input data-duration="' + si + '" value="' + esc(s.duration_hint || '') + '" placeholder="时长提示（如：约 24 小时）" style="margin-bottom:8px">',
        '  <textarea data-instruction="' + si + '" rows="3" placeholder="步骤说明">' + esc(s.instruction || '') + '</textarea>',

        // ── 板块：只渲染这一步实际拥有的。
        //    新增板块统一走底部的「＋ 添加板块」，每个板块也能单独移除。 ──

        s.fields.length ? [
          '  <div class="sub-block" data-fields-area="' + si + '">',
          '    <div class="sub-head"><span>数据字段</span><span class="sub-tools">',
          '      <button type="button" class="ghost tiny" data-add-field="' + si + '">＋ 加字段</button>',
          '      <button type="button" class="ghost tiny" data-drop-block="' + si + '-fields">移除板块</button>',
          '    </span></div>',
          s.fields.map((f, fi) => [
            '    <div class="field-row" data-field-row="' + si + '-' + fi + '">',
            '      <span class="drag-handle" draggable="true" data-drag-field="' + si + '-' + fi + '" title="拖动调整字段顺序">⠿</span>',
            '      <input data-field-name="' + si + '-' + fi + '" value="' + esc(f.label) + '" placeholder="字段名">',
            '      <input data-field-unit="' + si + '-' + fi + '" value="' + esc(f.unit || '') + '" placeholder="单位，可空">',
            '      <select data-field-type="' + si + '-' + fi + '" title="填写方式">',
            FIELD_TYPES.map((x) => '        <option value="' + x.value + '"' + (fieldTypeOf(f) === x.value ? ' selected' : '') + '>' + x.label + '</option>').join('\n'),
            '      </select>',
            '      <button type="button" class="icon-btn del" data-drop-field="' + si + '-' + fi + '" title="删除这个字段" aria-label="删除这个字段">×</button>',
            '    </div>',
          ].join('\n')).join(''),
          '  </div>',
        ].join('\n') : '',

        s.notice ? [
          '  <div class="sub-block" data-notices-area="' + si + '">',
          '    <div class="sub-head"><span>⚠ 注意事项</span><span class="sub-tools">',
          '      <button type="button" class="ghost tiny" data-add-notice="' + si + '">＋ 加一条</button>',
          '      <button type="button" class="ghost tiny" data-drop-block="' + si + '-notice">移除板块</button>',
          '    </span></div>',
          noticeLines(s).map((line, ni) => [
            '    <div class="line-row" data-line-row="' + si + '-' + ni + '">',
            '      <span class="drag-handle" draggable="true" data-drag-notice="' + si + '-' + ni + '" title="拖动调整顺序">⠿</span>',
            '      <input data-notice="' + si + '-' + ni + '" value="' + esc(line) + '" placeholder="如：出现沉淀即为异常">',
            '      <button type="button" class="icon-btn del" data-drop-notice="' + si + '-' + ni + '" title="删除这条" aria-label="删除这条">×</button>',
            '    </div>',
          ].join('\n')).join(''),
          '  </div>',
        ].join('\n') : '',

        (s.pyro_seq || isPyroText(s)) ? [
          '  <div class="sub-block">',
          '    <div class="sub-head"><span>🔥 热解程序</span><span class="sub-tools">',
          s.pyro_seq ? '      <button type="button" class="ghost tiny" data-drop-block="' + si + '-pyro">移除板块</button>' : '',
          '    </span></div>',
          // 生成/试算统一走右上角「小工具」里的热解计算器，这里只负责保存这一串程序
          '    <input class="pyro-input" data-pyro="' + si + '" value="' + esc(s.pyro_seq || '') + '" spellcheck="false" placeholder="粘贴程序串，或用右上角小工具算好再粘过来">',
          '  </div>',
        ].join('\n') : '',

        // 统一入口：加板块（已有的类型不再重复列出）
        '  <details class="add-block">',
        '    <summary>＋ 添加板块</summary>',
        '    <div class="add-block-menu">',
        s.fields.length ? '' : '      <button type="button" class="ghost tiny" data-add-block="' + si + '-fields">数据字段</button>',
        s.notice ? '' : '      <button type="button" class="ghost tiny" data-add-block="' + si + '-notice">注意事项</button>',
        s.pyro_seq ? '' : '      <button type="button" class="ghost tiny" data-add-block="' + si + '-pyro">热解程序</button>',
        '    </div>',
        '  </details>',

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

      // 注意事项：多行合并回一个「；」分隔的字符串；板块被移除时这里自然清空
      const rows = host.querySelectorAll('[data-notice^="' + si + '-"]');
      const lines = [];
      rows.forEach((inp) => { const v = inp.value.trim(); if (v) lines.push(v); });
      s.notice = lines.join('；');

      // 热解程序（方案里显式填的那一串；板块被移除时为 ''）
      const pyro = document.querySelector('[data-pyro="' + si + '"]');
      s.pyro_seq = pyro ? pyro.value.trim() : '';

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

  /* 通用拖动排序：只有手柄可拖（避免在输入框里选文字时误触发）。
     attr 指定读哪个 data-* 作为「位置键」；reorder(fromKey, toKey) 负责重排数据。 */
  function bindDragSort(host, attr, reorder) {
    let fromKey = null;

    const clear = () => host.querySelectorAll('.dragging, .over').forEach((n) => n.classList.remove('dragging', 'over'));

    host.querySelectorAll('[' + attr + ']').forEach((handle) => {
      const item = handle.closest('.step-card, .field-row, .line-row');
      if (!item) return;

      const keyOf = () => handle.getAttribute(attr);

      handle.addEventListener('dragstart', (e) => {
        fromKey = keyOf();
        item.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // Firefox 必须 setData 才会真正开始拖拽
          try { e.dataTransfer.setData('text/plain', 'x'); } catch (_e) { /* 忽略 */ }
        }
      });

      handle.addEventListener('dragend', () => { fromKey = null; clear(); });

      item.addEventListener('dragover', (e) => {
        if (fromKey == null) return;
        e.preventDefault();
        item.classList.add('over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('over'));

      item.addEventListener('drop', (e) => {
        if (fromKey == null) return;
        e.preventDefault();

        const toKey = keyOf();
        const from = fromKey;
        clear();
        fromKey = null;
        if (from === toKey) return;

        collectDraft();
        reorder(from, toKey);
        renderDraft();
      });
    });
  }

  function bindDraft() {
    const host = $('view-plan');

    // 步骤排序（位置键就是步骤序号）
    bindDragSort(host, 'data-drag-step', (a, b) => {
      const moved = draft.steps.splice(Number(a), 1)[0];
      if (moved) draft.steps.splice(Number(b), 0, moved);
    });

    // 数据字段排序（位置键是 "步骤-字段"，只允许同一步骤内排序）
    bindDragSort(host, 'data-drag-field', (a, b) => {
      const ai = Number(String(a).split('-')[0]);
      const af = Number(String(a).split('-')[1]);
      const bi = Number(String(b).split('-')[0]);
      const bf = Number(String(b).split('-')[1]);
      if (ai !== bi) return;

      const list = draft.steps[ai] && draft.steps[ai].fields;
      if (!list) return;
      const moved = list.splice(af, 1)[0];
      if (moved) list.splice(bf, 0, moved);
    });

    // 注意事项排序（同样只允许同一步骤内排序）
    bindDragSort(host, 'data-drag-notice', (a, b) => {
      const ai = Number(String(a).split('-')[0]);
      const an = Number(String(a).split('-')[1]);
      const bi = Number(String(b).split('-')[0]);
      const bn = Number(String(b).split('-')[1]);
      if (ai !== bi) return;

      const s = draft.steps[ai];
      if (!s) return;
      const lines = noticeLines(s);
      const moved = lines.splice(an, 1)[0];
      if (moved == null) return;
      lines.splice(bn, 0, moved);
      s.notice = lines.filter(Boolean).join('；');
    });

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

    // ── 板块：添加 / 移除 / 按温度生成热解程序 ──
    host.querySelectorAll('[data-add-block]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const parts = String(b.dataset.addBlock).split('-');
      const s = draft.steps[Number(parts[0])];
      const kind = parts[1];

      if (kind === 'fields' && !s.fields.length) s.fields = [{ label: '', unit: '', type: 'text' }];
      if (kind === 'notice' && !s.notice) s.notice = '；';   // 占位，渲染出来就是一行空输入
      if (kind === 'pyro' && !s.pyro_seq) s.pyro_seq = 'C30-T60-C30-T184-C950-T60-C950--121';
      renderDraft();
    }));

    host.querySelectorAll('[data-drop-block]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const parts = String(b.dataset.dropBlock).split('-');
      const s = draft.steps[Number(parts[0])];
      const kind = parts[1];

      if (kind === 'fields') s.fields = [];
      if (kind === 'notice') s.notice = '';
      if (kind === 'pyro') s.pyro_seq = '';
      renderDraft();
    }));

    // 数据字段：删除一行
    host.querySelectorAll('[data-drop-field]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const parts = String(b.dataset.dropField).split('-');
      draft.steps[Number(parts[0])].fields.splice(Number(parts[1]), 1);
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
        pyro_seq: s.pyro_seq || '',
        fields: s.fields,
        duration_hint: s.duration_hint || '',
      }));
      const { error: stepErr } = await client.from(STEP).insert(rows);
      if (stepErr) throw stepErr;

      draft = null;
      const doneMsg = wasEdit ? '方案已更新。' : '方案已保存。';
      setStatus(doneMsg, 'ok');

      // 方案改完后，把最新的步骤结构同步给正在做这个方案的实验（他们已填的数据会保留）
      try {
        const n = await syncPlanToRunningRuns(planId);
        if (n) setStatus(doneMsg + '已同步到 ' + n + ' 个进行中的步骤。', 'ok');
      } catch (err) {
        console.warn('[SciHub] 同步到进行中的实验失败：', err);
      }

      route('plans');
    } catch (err) {
      console.error('[SciHub] 保存方案失败：', err);
      setStatus('保存失败，请稍后重试。', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* 方案改完后，把最新的步骤结构同步到「正在使用这个方案」的实验。
     只更新结构（标题 / 说明 / 字段定义 / 注意事项 / 热解程序），
     已填的 values、备注、照片全部保留 —— 正在做实验的人不会丢数据。
     返回被更新的步骤数。 */
  async function syncPlanToRunningRuns(planId) {
    const { data: runs } = await client.from(RUN).select('id').eq('plan_id', planId).eq('status', 'running');
    if (!runs || !runs.length) return 0;

    const { data: planSteps } = await client.from(STEP).select('*').eq('plan_id', planId).order('position');
    if (!planSteps || !planSteps.length) return 0;

    const { data: runSteps } = await client.from(RUN_STEP).select('*').in('run_id', runs.map((r) => r.id));
    let changed = 0;

    for (const rs of (runSteps || [])) {
      const ps = planSteps.find((x) => x.position === rs.position);
      // 方案里已经没有这一步（步骤数变少了）→ 保持实验原样，不动别人正在进行的数据
      if (!ps) continue;

      const oldFields = rs.fields || [];
      const newFields = ps.fields || [];
      // 值是以字段名为键存的；字段改名/新增时用归一化匹配搬家，搬不走的旧值原样保留
      const values = migrateStepValues(oldFields, newFields, rs.values, null);

      const next = {
        title: ps.title || rs.title,
        instruction: ps.instruction || '',
        notice: ps.notice || '',
        pyro_seq: ps.pyro_seq || '',
        fields: newFields,
        values: values,
      };

      const before = JSON.stringify([rs.title, rs.instruction, rs.notice, rs.pyro_seq || '', oldFields, rs.values]);
      const after = JSON.stringify([next.title, next.instruction, next.notice, next.pyro_seq, next.fields, next.values]);
      if (before === after) continue;    // 没有实质变化就不写库

      const { error } = await client.from(RUN_STEP).update(next).eq('id', rs.id);
      if (error) throw error;
      changed += 1;
    }

    return changed;
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
        pyro_seq: s.pyro_seq || '',
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

      // 操作按钮放在标题下方（原来在页面最底部，要滚到底才点得到）
      '<div class="run-actions" style="margin-top:0;margin-bottom:16px;flex-wrap:wrap">',
      '  <button type="button" class="primary" id="plan-start">开始实验</button>',
      '  <button type="button" class="ghost" id="plan-edit">编辑方案</button>',
      canUpgrade ? '  <button type="button" class="fresh-btn" id="plan-upgrade">重新解析</button>' : '',
      '  <button type="button" class="ghost" id="plan-rename">重命名</button>',
      '  <button type="button" class="ghost" id="plan-back">返回方案列表</button>',
      '</div>',

      (steps || []).map((s) => [
        '<div class="step-card">',
        '  <div class="step-head"><span class="step-no">' + (s.position + 1) + '</span>',
        '    <span class="step-title-text">' + esc(s.title) + '</span>',
        s.duration_hint ? '    <span class="tag-mini">' + esc(s.duration_hint) + '</span>' : '',
        '  </div>',
        '  <div class="step-instruction">' + highlight(s.instruction) + '</div>',
        s.notice ? '  <div class="notice-mini"><em>⚠ 注意</em><div class="notice-items">'
          + noticeLines(s).map((line) => '<span class="notice-item">' + highlight(line) + '</span>').join('')
          + '</div></div>' : '',
        (s.fields || []).length ? '  <div class="hc-meta" style="margin-top:8px">数据字段：' + (s.fields || []).map((f) => esc(f.label) + (f.unit ? '（' + esc(f.unit) + '）' : '')).join('、') + '</div>' : '',
        '</div>',
      ].join('\n')).join(''),
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
        pyro_seq: s.pyro_seq || '',
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

  /* 这一步是否已经「有进展」：填了数据、附了照片、写了备注，或标记完成。
     用来算「实验进行位置」—— 它和「当前浏览位置」是两回事。 */
  function stepHasProgress(x) {
    if (!x) return false;
    if (x.status === 'done') return true;
    if ((x.images || []).length) return true;
    if (String(x.note || '').trim()) return true;
    const vals = x.values || {};
    return Object.keys(vals).some((k) => { const v = vals[k]; return v !== '' && v != null; });
  }

  function drawRun() {
    const host = $('view-run');
    const s = run.steps[run.pos];
    if (!s) { host.innerHTML = '<div class="empty">没有可执行的步骤。</div>'; return; }

    const total = run.steps.length;
    const done = run.steps.filter((x) => x.status === 'done').length;

    // 实验进行位置：最后一个「有数据 / 有照片 / 有备注 / 已完成」的步骤。
    // 翻看后面的步骤不会推进它 —— 进度由填写的数据决定，不由浏览位置决定。
    let reached = 0;
    run.steps.forEach((x, i) => { if (stepHasProgress(x)) reached = i; });

    const reachedPct = total > 1 ? Math.round((reached / (total - 1)) * 100) : 100;
    const posPct = total > 1 ? Math.round((run.pos / (total - 1)) * 100) : 100;

    const isLast = run.pos === total - 1;
    const resumed = (run.data.current_step || 0) === run.pos && run.pos > 0;
    const drift = (run.drift && run.drift.fields) || [];

    host.innerHTML = [
      '<div class="run-head">',
      '  <div><b>' + esc(run.data.title) + '</b>',
      '    <div class="hc-meta">开始于 ' + fmt(run.data.started_at) + ' · 已进行 ' + sinceText(run.data.started_at) + (run.data.status === 'done' ? ' · 已完成' : '') + '</div>',
      '  </div>',
      '  <div class="hc-actions">',
      // 导出统一放在主页的「进行中的实验」卡片上，这里不再重复一个入口
      '    <button type="button" class="ghost" id="run-exit">返回主页</button>',
      '  </div>',
      '</div>',

      // 进度条：绿色实心＝实验进行到的位置（按数据算）；空心圆环＝当前正在浏览的位置
      '<div class="progress">',
      '  <i style="width:' + reachedPct + '%"></i>',
      '  <span class="prog-mark prog-reached" style="left:' + reachedPct + '%" title="已进行到第 ' + (reached + 1) + ' 步"></span>',
      '  <span class="prog-mark prog-pos" style="left:' + posPct + '%" title="正在浏览第 ' + (run.pos + 1) + ' 步"></span>',
      '</div>',

      // 步骤节点：点任意一个直接跳过去，只是浏览，不会改变实验进度
      '<div class="step-nav">',
      run.steps.map((x, i) => {
        const cls = ['step-dot'];
        if (stepHasProgress(x)) cls.push('done');
        if (i === reached) cls.push('reached');
        if (i === run.pos) cls.push('cur');
        return '<button type="button" class="' + cls.join(' ') + '" data-goto="' + i + '"'
          + ' title="第 ' + (i + 1) + ' 步：' + esc(x.title) + '">' + (i + 1) + '</button>';
      }).join(''),
      '</div>',

      '<div class="hc-meta run-status">已进行到 <b>第 ' + (reached + 1) + ' 步</b> · 正在浏览 第 ' + (run.pos + 1) + ' 步 · 共 ' + total + ' 步 · 已完成 ' + done + ' 步'
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
        '    <div class="notice-body"><b>注意事项</b>',
        // 一条一行、带圆点 —— 之前用「；」连成一整句，扫读时容易串行
        noticeLines(s).map((line) => '      <span class="notice-item">' + highlight(line) + '</span>').join('\n'),
        '    </div>',
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

    // 步骤节点：点一下直接跳到那一步。只是浏览，不影响「已进行到第几步」。
    host.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.goto);
      if (i === run.pos) return;
      run.pos = i;
      drawRun();
    }));

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

  /* 按「初始温度 / 升温速率 / 最终温度」重算程序：
       ① 程序里所有等于原初始温度的温度点 → 换成输入的初始温度
       ② 程序里最高的那个温度点（最终温度）→ 换成输入的最终温度
       ③ 前后温度不同的段＝升温，耗时 = |Δ| ÷ 速率（覆盖程序里写死的旧值）
       ④ 温度相同＝保温，用程序里的原值
     返回 { segs, total, room, finalTemp, oldRoom, oldMax } */
  function calcPyro(seq, roomTemp, rate, finalTemp) {
    const parts = pyroParts(seq);
    const temps = parts.filter((p) => p.kind === 'temp');
    if (!temps.length) return null;

    const oldRoom = temps[0].value;                 // 程序里第一个温度点＝当初的初始温度
    const oldMax = Math.max.apply(null, temps.map((p) => p.value));

    const roomNum = Number(roomTemp);
    const finalNum = Number(finalTemp);
    const useRoom = Number.isFinite(roomNum) && roomNum !== 0;
    const useFinal = Number.isFinite(finalNum) && finalNum > 0;
    const room = useRoom ? roomNum : oldRoom;
    const finalT = useFinal ? finalNum : oldMax;

    // 初始温度在程序里往往出现多次（C30-T60-C30-… 开头一次、「回到室温」又一次），
    // 必须一起替换 —— 只换第一个的话前后温度对不上，保温段会被误判成升温。
    parts.forEach((p) => {
      if (p.kind !== 'temp') return;
      if (p.value === oldRoom) p.value = room;
      else if (p.value === oldMax) p.value = finalT;   // 最终温度（可能有多处，如升温到 950 与保温 950）
    });

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
      // 前后温度不同 → 升温段，耗时由温升与速率决定（覆盖程序里写死的旧值）
      if (from != null && to != null && to !== from && r > 0) {
        ramp = true;
        minutes = Math.round((Math.abs(to - from) / r) * 10) / 10;
      }
      segs.push({ from, to, minutes, ramp });
      total += minutes;
    });

    return { segs, total, room, finalTemp: finalT, oldRoom, oldMax };
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

  /* 这一步算不算「热解步骤」：
     ① 方案/快照里显式填了热解程序 → 算；
     ② 步骤说明里直接写了完整程序 → 算；
     ③ 否则看标题/说明里有没有热解相关字样（热解 / 碳化 / 煅烧 / 管式炉 / 程序升温…）。
        程序通常写在方案的另一处，所以这里只负责把计算器摆到正确的步骤上。 */
  function isPyroStep(s) {
    if (s && s.pyro_seq && looksLikePyro(s.pyro_seq)) return true;
    const own = findPyroSeq(s.instruction || '');
    if (own && looksLikePyro(own)) return true;
    const hay = String(s.title || '') + '\n' + String(s.instruction || '');
    return /热解|碳化|煅烧|管式炉|程序升温|pyrolysis/i.test(hay);
  }

  /* 取这一步要用的热解程序：
     ① 本步显式填的（建方案时定下来的）
     ② 本步说明里识别到的
     ③ 这条实验的其它步骤里能找到的（程序常写在别处） */
  function pyroSeqForStep(s) {
    if (s && s.pyro_seq && looksLikePyro(s.pyro_seq)) return String(s.pyro_seq).trim();
    const own = findPyroSeq(s.instruction || '');
    if (own && looksLikePyro(own)) return own;
    for (const x of (run.steps || [])) {
      if (x.pyro_seq && looksLikePyro(x.pyro_seq)) return String(x.pyro_seq).trim();
      const q = findPyroSeq(x.instruction || '');
      if (q && looksLikePyro(q)) return q;
    }
    return '';
  }

  /* 执行界面里那块可折叠的计算器（不是热解步骤就不渲染） */
  function pyroBlock(s) {
    if (!isPyroStep(s)) return '';
    // 找不到程序也照样渲染 —— 这样用户可以自己把程序粘进来。
    // （旧方案里那串程序常常根本没被解析进步骤说明，这时更需要一个能填的地方。）
    const seq = pyroSeqForStep(s);
    const parts = pyroParts(seq);
    const temps = parts.filter((p) => p.kind === 'temp').map((p) => p.value);
    const room = temps.length ? temps[0] : '';
    const maxT = temps.length ? Math.max.apply(null, temps) : '';
    const rate = seq ? guessPyroRate(seq) : 5;

    return [
      '<details class="pyro">',
      '  <summary>🔥 热解程序计算器</summary>',
      '  <div class="pyro-body">',
      '    <label class="pyro-field">热解程序<input id="pyro-seq" value="' + esc(seq) + '" spellcheck="false" placeholder="如 C30-T60-C30-T184-C950-T60-C950--121"></label>',
      '    <div class="pyro-grid">',
      '      <label class="pyro-field">初始温度（℃）<input type="number" step="any" inputmode="decimal" id="pyro-room" value="' + esc(room) + '" placeholder="如 30"></label>',
      '      <label class="pyro-field">升温速率（℃/min）<input type="number" step="any" inputmode="decimal" id="pyro-rate" value="' + esc(rate) + '"></label>',
      '      <label class="pyro-field">最终温度（℃）<input type="number" step="any" inputmode="decimal" id="pyro-final" value="' + esc(maxT) + '" placeholder="如 950"></label>',
      '    </div>',
      '    <div id="pyro-out"></div>',
      '  </div>',
      '</details>',
    ].join('\n');
  }

  function drawPyro() {
    const out = $('pyro-out');
    if (!out) return;

    const res = calcPyro($('pyro-seq').value, $('pyro-room').value, $('pyro-rate').value, $('pyro-final').value);
    if (!res || !res.segs.length) {
      out.innerHTML = '<p class="hint small">没识别出程序。示例：C30-T60-C30-T184-C950-T60-C950--121</p>';
      return;
    }

    out.innerHTML = renderPyroResult(res, $('pyro-rate').value);
  }

  /* 把计算结果渲染成逐段列表 + 合计（执行界面与右上角小工具共用） */
  function renderPyroResult(res, rateText) {
    return [
      '<div class="pyro-result">',
      res.segs.map((g) => {
        const from = g.from == null ? '—' : g.from + '℃';
        const to = g.to == null ? '—' : g.to + '℃';
        const what = g.ramp ? '升温' : (g.from === g.to ? '保温' : '降温');
        return '<div class="pyro-line"><b>' + what + '</b><span>' + esc(from + ' → ' + to) + '</span><em>' + g.minutes + ' min</em></div>';
      }).join(''),
      '<div class="pyro-total">合计 <b>' + Math.round(res.total * 10) / 10 + ' min</b>'
        + '（约 ' + (Math.round(res.total / 6) / 10) + ' h）· ' + res.room + ' → ' + res.finalTemp + '℃ · 速率 '
        + esc(String(rateText)) + ' ℃/min</div>',
      '</div>',
    ].join('');
  }

  /* 用现有程序当模板（保留各段保温时长与终止标记），把
     「初始温度 / 最终温度 / 升温速率」套进去，生成新的程序串：
       模板 C30-T60-C30-T184-C950-T60-C950--121
       + 初始 25℃、终温 1000℃、速率 5 → C25-T60-C25-T195-C1000-T60-C1000--121
     这样建方案时只要给定三个数，程序串就自动出来了。 */
  function buildPyroSeq(template, roomTemp, rate, finalTemp) {
    const parts = pyroParts(template);
    if (!parts.length) return '';

    const temps = parts.filter((p) => p.kind === 'temp').map((p) => p.value);
    const oldRoom = temps[0];
    const oldMax = Math.max.apply(null, temps);
    const roomNum = Number(roomTemp);
    const finalNum = Number(finalTemp);
    const room = Number.isFinite(roomNum) && roomNum !== 0 ? roomNum : oldRoom;
    const finalT = Number.isFinite(finalNum) && finalNum > 0 ? finalNum : oldMax;
    const r = Number(rate) > 0 ? Number(rate) : 0;

    // 第一趟：先算出每个温度点的新值（这一趟不碰时长）
    const newTemps = parts.map((p) => {
      if (p.kind !== 'temp') return null;
      if (p.value === oldRoom) return room;
      if (p.value === oldMax) return finalT;
      return p.value;
    });

    // 第二趟：组装。
    // 必须分两趟 —— 若在同一趟里边替换温度边算时长，「下一个温度点」会取到尚未替换的旧值，
    // 于是本该是保温的段会被误判成升温（实测把 T60 算成了 T1）。
    const out = [];
    let last = null;

    parts.forEach((p, i) => {
      if (p.kind === 'temp') {
        last = newTemps[i];
        out.push('C' + last);
        return;
      }
      if (p.kind === 'time') {
        let next = null;
        for (let j = i + 1; j < parts.length; j++) {
          if (parts[j].kind === 'temp') { next = newTemps[j]; break; }
        }
        let t = p.value;
        if (last != null && next != null && next !== last && r > 0) {
          t = Math.round((Math.abs(next - last) / r) * 10) / 10;
        }
        out.push('T' + t);
        return;
      }
      out.push('--' + (p.value || ''));
    });

    // 终止标记本身以 -- 开头，join 后会前后各有一个「-」，压回两个
    return out.join('-').replace(/---+/g, '--');
  }

  function bindPyro() {
    if (!$('pyro-seq')) return;
    drawPyro();

    // 初始温度/速率/最终温度改了 → 连同程序串一起重算；程序串本身改了 → 只按它算
    ['pyro-room', 'pyro-rate', 'pyro-final'].forEach((id) => {
      const node = $(id);
      if (node) {
        node.addEventListener('input', () => {
          const next = buildPyroSeq($('pyro-seq').value, $('pyro-room').value, $('pyro-rate').value, $('pyro-final').value);
          if (next) $('pyro-seq').value = next;
          drawPyro();
        });
      }
    });
    $('pyro-seq').addEventListener('input', drawPyro);
  }

  /* ── 右上角「小工具」：不依赖具体实验的独立面板 ────────── */

  function openPyroTool() {
    openModal('🔥 热解程序计算器', [
      '<label>热解程序<input id="tp-seq" value="C30-T60-C30-T184-C950-T60-C950--121" spellcheck="false"></label>',
      '<div class="pyro-grid" style="margin-top:10px">',
      '  <label>初始温度（℃）<input type="number" step="any" inputmode="decimal" id="tp-room" value="30"></label>',
      '  <label>升温速率（℃/min）<input type="number" step="any" inputmode="decimal" id="tp-rate" value="5"></label>',
      '  <label>最终温度（℃）<input type="number" step="any" inputmode="decimal" id="tp-final" value="950"></label>',
      '</div>',
      '<div id="tp-out" style="margin-top:12px"></div>',
    ].join(''), [{ label: '关闭', onClick: closeModal }]);

    const draw = (rebuild) => {
      const out = $('tp-out');
      if (!out) return;

      // 改了初始温度 / 速率 / 最终温度 → 先按模板把程序串重算出来（保留各段保温时长）
      if (rebuild) {
        const next = buildPyroSeq($('tp-seq').value, $('tp-room').value, $('tp-rate').value, $('tp-final').value);
        if (next) $('tp-seq').value = next;
      }

      const res = calcPyro($('tp-seq').value, $('tp-room').value, $('tp-rate').value, $('tp-final').value);
      out.innerHTML = (res && res.segs.length)
        ? renderPyroResult(res, $('tp-rate').value)
        : '<p class="hint small">没识别出程序。示例：C30-T60-C30-T184-C950-T60-C950--121</p>';
    };

    // 温度/速率变了 → 连程序串一起重算；程序串本身改了 → 只按它算
    ['tp-room', 'tp-rate', 'tp-final'].forEach((id) => {
      const node = $(id);
      if (node) node.addEventListener('input', () => draw(true));
    });
    $('tp-seq').addEventListener('input', () => draw(false));
    draw(false);
  }

  /* 供 app.js 的「小工具」入口调用 */
  window.Tools = { openPyroCalculator: openPyroTool };

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
        '<figure class="photo" data-path="' + esc(img.path) + '" data-media="' + idx + '" draggable="true" title="可拖动调整顺序">',
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

    // 拖动缩略图调整顺序；顺序会被保存，导出的 Word 文档也按这个顺序排照片
    let dragFrom = -1;
    host.querySelectorAll('[data-media]').forEach((fig) => {
      fig.addEventListener('dragstart', (e) => {
        dragFrom = Number(fig.dataset.media);
        fig.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          // Firefox 必须 setData 才会真正开始拖拽
          try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (_e) { /* 忽略 */ }
        }
      });
      fig.addEventListener('dragend', () => { fig.classList.remove('dragging'); });
      fig.addEventListener('dragover', (e) => { e.preventDefault(); fig.classList.add('over'); });
      fig.addEventListener('dragleave', () => fig.classList.remove('over'));
      fig.addEventListener('drop', async (e) => {
        e.preventDefault();
        fig.classList.remove('over');

        const to = Number(fig.dataset.media);
        if (dragFrom < 0 || dragFrom === to) { dragFrom = -1; return; }

        const list = (s.images || []).slice();
        const moved = list.splice(dragFrom, 1)[0];
        if (!moved) { dragFrom = -1; return; }
        list.splice(to, 0, moved);
        s.images = list;
        dragFrom = -1;

        await saveStep(s, true);
        drawPhotos(s);
      });
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

  /* ── 导出本次实验的数据（Word 文档）───────────────────── */

  /* 生成 .docx：docx 本质就是个 zip，里面放几个固定名字的 XML + 图片。
     paragraphs 里可以混入 { image: { data: ArrayBuffer, mime, w, h } } 这样的段落 ——
     图片会写进 word/media/ 并在 word/_rels/document.xml.rels 里登记关系。 */
  async function buildDocx(paragraphs) {
    const JSZip = await loadJSZip();
    const zip = new JSZip();

    const xml = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const media = [];   // 待写入 word/media 的文件
    const rels = [];    // 图片关系
    let picId = 1;

    // 正文可用宽度约 6.7 英寸；换算成 EMU（96dpi 下 1px = 9525 EMU）
    const MAX_W = 480 * 9525;

    const body = paragraphs.map((item) => {
      if (item && item.image) {
        const img = item.image;
        const idx = media.length + 1;
        const ext = /png/i.test(img.mime || '') ? 'png' : 'jpeg';
        const name = 'image' + idx + '.' + ext;
        media.push({ name: name, data: img.data, mime: img.mime || 'image/jpeg' });

        const rid = 'rIdImg' + idx;
        rels.push({ id: rid, target: 'media/' + name });

        // 等比缩放到最大宽度
        let cx = (img.w || 480) * 9525;
        let cy = (img.h || 320) * 9525;
        if (cx > MAX_W) { cy = Math.round(cy * (MAX_W / cx)); cx = MAX_W; }

        const id = picId++;
        return '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>'
          + '<wp:inline distT="0" distB="0" distL="0" distR="0">'
          + '<wp:extent cx="' + cx + '" cy="' + cy + '"/>'
          + '<wp:docPr id="' + id + '" name="Picture ' + id + '"/>'
          + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
          + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
          + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
          + '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr>'
          + '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
          + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
          + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
          + '</pic:pic></a:graphicData></a:graphic>'
          + '</wp:inline></w:drawing></w:r></w:p>';
      }

      const text = typeof item === 'string' ? item : item.text;
      const o = typeof item === 'string' ? {} : item;

      let rPr = '';
      if (o.bold) rPr += '<w:b/>';
      if (o.size) rPr += '<w:sz w:val="' + (o.size * 2) + '"/>';
      if (o.color) rPr += '<w:color w:val="' + o.color + '"/>';

      const pPr = o.align ? '<w:pPr><w:jc w:val="' + o.align + '"/></w:pPr>' : '';
      return '<w:p>' + pPr
        + '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '')
        + '<w:t xml:space="preserve">' + xml(text) + '</w:t></w:r></w:p>';
    }).join('');

    // Content_Types 里必须声明图片扩展名，否则 Word 会报「文件已损坏」
    const extTypes = {};
    media.forEach((m) => { extTypes[m.name.split('.').pop()] = m.mime; });

    zip.file('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + Object.keys(extTypes).map((e) => '<Default Extension="' + e + '" ContentType="' + extTypes[e] + '"/>').join('')
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>');

    zip.folder('_rels').file('.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>');

    if (rels.length) {
      zip.folder('word').folder('_rels').file('document.xml.rels',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + rels.map((r) => '<Relationship Id="' + r.id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + r.target + '"/>').join('')
        + '</Relationships>');
    }

    if (media.length) {
      const mf = zip.folder('word').folder('media');
      media.forEach((m) => mf.file(m.name, m.data));
    }

    zip.folder('word').file('document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document'
      + ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
      + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
      + '<w:body>' + body
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      + '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>'
      + '</w:body></w:document>');

    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  /* 触发浏览器下载 */
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  /* 取图片的二进制与原始尺寸，供 docx 嵌入 */
  async function fetchImageForDocx(path) {
    const url = run.urls[path];
    if (!url) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();

      let w = 480;
      let h = 320;
      try {
        const bmp = await createImageBitmap(new Blob([buf]));
        w = bmp.width;
        h = bmp.height;
        if (bmp.close) bmp.close();
      } catch (_e) { /* 取不到尺寸就用默认值，只影响显示大小 */ }

      return { data: buf, mime: res.headers.get('content-type') || 'image/jpeg', w: w, h: h };
    } catch (err) {
      console.warn('[SciHub] 图片读取失败，导出时跳过：', path, err);
      return null;
    }
  }

  /* 把一次实验的步骤、填写数据与照片导成 Word 文档。
     不传 runId 就导当前打开的那次；传了则按 id 读进来（主页的导出按钮用）。 */
  async function exportRunData(runId) {
    try {
      if (runId && (run.id !== runId || !run.data)) {
        setStatus('正在读取实验数据…');
        const { data: r } = await client.from(RUN).select('*').eq('id', runId).maybeSingle();
        const { data: steps } = await client.from(RUN_STEP).select('*').eq('run_id', runId).order('position');
        if (!r) { setStatus('找不到这次实验。', 'error'); return; }

        run.id = runId;
        run.data = r;
        run.steps = steps || [];
        run.urls = {};
        run.urlErrors = {};

        const paths = [];
        run.steps.forEach((s) => (s.images || []).forEach((img) => { if (img && img.path) paths.push(img.path); }));
        if (paths.length) {
          const { data: signedList } = await client.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 24);
          (signedList || []).forEach((it) => { if (it && it.path && it.signedUrl) run.urls[it.path] = it.signedUrl; });
        }
      }

      if (!run.data || !run.steps.length) { setStatus('还没有可导出的数据。', 'warn'); return; }

      // 只导出到「当前进行到的步骤」为止 —— 还没做到的那几步不写进文档。
      // 实验做完时 current_step 已是最后一步，所以等于全量导出。
      const cur = Math.min(Math.max(0, Number(run.data.current_step) || 0), run.steps.length - 1);
      const upto = run.steps.filter((s) => s.position <= cur);

      setStatus('正在生成 Word 文档…');
      const title = run.data.title || '实验';
      const paras = [
        { text: title, bold: true, size: 16, align: 'center' },
        {
          text: '开始于 ' + fmt(run.data.started_at)
            + (run.data.status === 'done' ? ' · 已完成' : ' · 进行中')
            + ' · 已做到第 ' + (cur + 1) + ' 步（共 ' + run.steps.length + ' 步）',
          size: 9, align: 'center',
        },
        '',
      ];

      let imgTotal = 0;

      for (const s of upto) {
        paras.push({ text: '第 ' + (s.position + 1) + ' 步　' + (s.title || ''), bold: true, size: 13, color: '0F766E' });
        if (s.pyro_seq) paras.push({ text: '热解程序：' + s.pyro_seq, size: 10 });
        if (s.duration_hint) paras.push({ text: '时长提示：' + s.duration_hint, size: 10 });
        // 注意事项用橙色标出，和界面里的警示条呼应
        noticeLines(s).filter(Boolean).forEach((line) => paras.push({ text: '⚠ ' + line, size: 10, color: 'C05621' }));
        if (s.instruction) paras.push({ text: s.instruction, size: 10 });

        const fields = s.fields || [];
        const vals = s.values || {};
        if (fields.length) {
          paras.push({ text: '填写数据', bold: true, size: 10 });
          fields.forEach((f) => {
            const v = vals[f.label];
            const shown = (v == null || v === '') ? '（未填）' : v;
            paras.push({ text: '　· ' + f.label + '：' + shown + (f.unit ? ' ' + f.unit : ''), size: 10 });
          });
        }
        if (s.note) paras.push({ text: '备注：' + s.note, size: 10 });

        // 照片按当前顺序嵌进文档（拖动排序后，这里也就是拖后的顺序）
        const imgs = s.images || [];
        let n = 0;
        for (const img of imgs) {
          if (isVideoFile(img)) continue;              // 视频无法嵌入文档
          const bin = await fetchImageForDocx(img.path);
          if (!bin) continue;
          n += 1;
          imgTotal += 1;
          paras.push({ text: '照片 ' + n + (img.caption ? '：' + img.caption : ''), size: 9, color: '666666' });
          paras.push({ image: bin });
        }
        const skipped = imgs.filter(isVideoFile).length;
        if (skipped) paras.push({ text: '（另有 ' + skipped + ' 个视频未嵌入文档）', size: 9, color: '666666' });

        paras.push('');
      }

      const blob = await buildDocx(paras);
      const safe = String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      downloadBlob(blob, safe + '-' + new Date().toISOString().slice(0, 10) + '.docx');
      setStatus('已导出到第 ' + (cur + 1) + ' 步（共 ' + upto.length + ' 个步骤'
        + (imgTotal ? '、' + imgTotal + ' 张照片' : '') + '）。', 'ok');
    } catch (err) {
      console.error('[SciHub] 导出失败：', err);
      setStatus('导出失败：' + errorText(err), 'error');
    }
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

  window.Run = { render: renderRun, running: runningRuns, rename: renameRun, remove: removeRun, export: exportRunData };

  // 通知 app.js：实验模块已就绪（两个脚本并行下载，首页靠这个信号补渲染）
  window.dispatchEvent(new CustomEvent('scihub:ready'));
})();
