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
          fields: withChecklistFields(detectFields(text), guessDuration(text) ? [] : checklistOf(null, text)),
          duration_hint: guessDuration(text),
          notice: extractNotice(text),
          // 只有真的写了热解程序的步骤才会带上「热解板块」（马弗炉/管式炉的升温曲线）
          pyro_seq: detectPyroSeq(text),
          // 「已完成勾选」已并入数据字段：上面用 withChecklistFields 转成 check 字段了
          checklist: [],
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
    const t = String(text || '');
    const m = t.match(/(\d+(?:\.\d+)?)\s*(h|小时|min|分钟)/i);
    if (m) return '约 ' + m[1] + ' ' + (m[2].toLowerCase() === 'h' ? '小时' : m[2]);
    // 没有数字的常见写法，折算成能用来算结束时间的话
    if (/过夜|隔夜|整夜|一夜|一晚|overnight/i.test(t)) return '约 12 小时（过夜）';
    if (/隔天|第二天|次日|一整天|整天|全天/.test(t)) return '约 24 小时（隔天）';
    if (/半天|半日/.test(t)) return '约 12 小时（半天）';
    if (/一周|整周|一个星期/.test(t)) return '约 7 天（一周）';
    if (/半小时|半个小时/.test(t)) return '约 30 分钟';
    return '';
  }

  /* 已完成勾选条目：优先用 AI/已有数组；否则按规则从说明里识别，
     如「第一次抽滤（ ）、第二次抽滤（ ）」→ ['第一次抽滤','第二次抽滤']。 */
  function checklistOf(given, text) {
    const arr = Array.isArray(given)
      ? given.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
      : [];
    if (arr.length) {
      const seen = new Set();
      return arr.filter((x) => { const k = x; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
    }

    const t = String(text || '');
    const out = [];
    const seen = new Set();
    // ①「第N次/第N遍/第N批 + 动作」：第一次抽滤、第二次抽滤…
    const re = /第\s*[一二三四五六七八九十\d]+\s*[次遍批轮]\s*[，,、]?\s*([^\s，,、。；;()（）]{2,20}?)(?=[（(]|$|[，,、。；;\s]|第)/g;
    let m;
    while ((m = re.exec(t))) {
      const item = (m[1] || '').trim();
      if (item && !seen.has(item)) { seen.add(item); out.push(item); }
    }
    // ② 明显带勾选框的短句：「抽滤（ ）、洗涤（ ）」→ 把动作拆成条目
    if (!out.length) {
      const box = /([^\s，,、。；;（）()]{2,20}?)[（(]\s*[）)]/g;
      while ((m = box.exec(t))) {
        const item = (m[1] || '').trim();
        if (item && !seen.has(item)) { seen.add(item); out.push(item); }
      }
    }
    return out.slice(0, 20);
  }

  /* 「已完成勾选」已并入「数据字段」：勾选条目统一变成 type='check' 的字段。
     解析结果 / 旧方案里的 checklist 都用它转成字段，之后编辑器只认字段。 */
  function checklistAsFields(list) {
    return (list || [])
      .map((c) => ({ label: String(c == null ? '' : c).trim(), unit: '', type: 'check' }))
      .filter((f) => f.label);
  }
  /* 把勾选条目并进字段列表，同名的不重复加 */
  function withChecklistFields(fields, checklist) {
    const out = (fields || []).slice();
    const have = new Set(out.map((f) => String((f && f.label) || '').trim()));
    checklistAsFields(checklist).forEach((f) => {
      if (have.has(f.label)) return;
      have.add(f.label);
      out.push(f);
    });
    return out;
  }
  /* 这一步是否还有任何内容（空白行清完后，用来决定要不要保留这个步骤） */
  function stepHasContent(s) {
    if (!s) return false;
    if (String(s.title || '').trim() || String(s.instruction || '').trim()) return true;
    if (String(s.duration_hint || '').trim() || String(s.pyro_seq || '').trim()) return true;
    if ((s.fields || []).some((f) => String((f && f.label) || '').trim())) return true;
    if ((s.noticeRows || []).some((x) => String(x || '').trim())) return true;
    if ((s.checklist || []).some((x) => String(x || '').trim())) return true;
    return false;
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
        // 已完成勾选已并入数据字段：AI 给的 checklist / 规则识别出的条目都转成 check 字段
        fields: withChecklistFields(fields, checklistOf(s && s.checklist, s && s.instruction)),
        checklist: [],
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

          // 勾选条目已并入字段（check 类型）：旧数据里的 checklist 也一并并进 fields
          (s.checklist || []).forEach((c) => {
            const k = String(c || '').trim();
            if (!k || have.has(k)) return;
            have.add(k);
            prev.fields = (prev.fields || []).concat([{ label: k, unit: '', type: 'check' }]);
          });
          return;
        }
      }
      out.push(Object.assign({}, s, {
        fields: (s.fields || []).slice(),
        checklist: [],
      }));
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

    const cards = (data || []).map((p) => {
      const stale = planNeedsUpgrade(p);
      return [
        '<article class="plan-card clickable" data-open="' + p.id + '" role="button" tabindex="0" title="查看方案详情">',
        '  <div class="hc-main">',
        '    <div class="hc-title">' + esc(p.title) + '</div>',
        '    <div class="hc-meta">' + (p.source ? esc(p.source) + ' · ' : '') + fmt(p.created_at) + '</div>',
        '  </div>',
        // 有新版本时，像页脚那个版本号提示一样标出来，更新按钮就放在提示旁边
        stale ? [
          '  <div class="plan-stale">',
          '    <span class="ver-stale" title="这个方案是用旧版解析规则导入的">有新版本</span>',
          '    <button type="button" class="ver-update" data-upgrade="' + p.id + '" title="按最新规则重新解析（不影响已开始的实验）">更新</button>',
          '  </div>',
        ].join('\n') : '',
        '</article>',
      ].join('\n');
    }).join('');

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

    // 「更新」按钮：就地按最新规则重建，然后刷新列表（补齐后提示与按钮会一起消失）
    host.querySelectorAll('[data-upgrade]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();   // 别让这次点击冒泡成「进详情」
      b.disabled = true;
      try {
        await upgradePlan(Number(b.dataset.upgrade));
        listPlans();
      } catch (err) {
        console.error('[SciHub] 更新方案失败：', err);
        setStatus('更新失败：' + errorText(err), 'error');
        b.disabled = false;
      }
    }));

    // 卡片其余区域（以及键盘 Enter / 空格）进详情。
    // 开始实验 / 编辑 / 重命名 / 删除 仍只放在方案详情页。
    host.querySelectorAll('[data-open]').forEach((card) => {
      const open = () => route('plan', Number(card.dataset.open));
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;   // 点按钮时不跳转
        open();
      });
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
      const original = (oldFields || []).find((field) => field.label === nf.label);
      if (original && String(original.unit || '').trim() !== String(nf.unit || '').trim() && has(src, nf.label) && src[nf.label] !== '') throw new Error('字段「' + nf.label + '」已有数据且单位改变，不能自动迁移；请保留原实验快照并新建实验。');
      if (has(src, nf.label)) { out[nf.label] = src[nf.label]; return; }        // ① 同名

      const byAi = (oldFields || []).find((of) => aiMap && aiMap[of.label] === nf.label && String(of.unit || '').trim() === String(nf.unit || '').trim() && has(src, of.label));
      if (byAi) { out[nf.label] = src[byAi.label]; return; }                    // ② AI 判定

      const nk = fieldKey(nf.label);
      const hit = (oldFields || []).find((of) => fieldKey(of.label) === nk && String(of.unit || '').trim() === String(nf.unit || '').trim() && has(src, of.label));
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
      const usedNew = new Set();
      ((data && data.pairs) || []).forEach((p) => {
        if (p && p.from && p.to && !Object.prototype.hasOwnProperty.call(map, p.from) && !usedNew.has(p.to) && oldLabels.indexOf(p.from) !== -1 && newLabels.indexOf(p.to) !== -1) {
          map[p.from] = p.to;
          usedNew.add(p.to);
        }
      });
      return Object.keys(map).length ? map : null;
    } catch (err) {
      console.warn('[SciHub] AI 参数匹配不可用，改用名称匹配：', err);
      return null;
    }
  }

  /* 上传新版本时的「智能合并」：新解析的步骤和现有方案逐项对齐，
     用户改过的部分尽量保留，只有新文档里确实变了的才更新。

     步骤对齐：标题归一化后互相包含 / 前 4 字相同 → 视为同一步。
     对齐后的合并规则：
       · 标题：沿用旧的（用户可能改过措辞）；新旧确实不像时才用新的
       · instruction：用新文档的（操作要点以新版本为准）
       · duration_hint / notice / pyro_seq / checklist：新的有就用新的，否则保留旧的（用户手填的不丢）
       · fields：新旧字段按「同名 → 归一化同名 → AI 同义」搬家；新解析认不出的旧字段
         （多为用户手工添加）保留在末尾，不丢
     旧方案里用户自己加的步骤（新文档里没有）追加到最后 —— 用户删过的步骤不在旧方案里，
     自然不会再出现。返回合并后的步骤数组（字段形如 {label,unit,type}）。 */
  async function mergePlanVersions(oldSteps, newSteps) {
    const tkey = (s) => String(s || '').replace(/[\s（）()【】\[\]：:、，,。.·—\-]/g, '');
    const stem = 4;
    const oldUsed = new Set();
    const out = [];
    let newCount = 0;
    let keptCount = 0;

    for (const ns of newSteps) {
      const nk = tkey(ns.title);
      let old = null;
      let oi = -1;
      oldSteps.forEach((os, i) => {
        if (oldUsed.has(i)) return;
        const ok = tkey(os.title);
        const related = (nk && ok && (nk.indexOf(ok) !== -1 || ok.indexOf(nk) !== -1))
          || (nk.length >= stem && ok.length >= stem && nk.slice(0, stem) === ok.slice(0, stem));
        if (related) { old = os; oi = i; }
      });
      if (old != null) { oldUsed.add(oi); keptCount += 1; } else { newCount += 1; }

      const oldFields = (old && old.fields) || [];
      const newFields = (ns.fields || []).map((f) => ({ label: String(f.label || '').trim(), unit: String(f.unit || '').trim(), type: String(f.type || '').trim() })).filter((f) => f.label);

      // 字段对齐：先用名字匹配，匹配不上的交给 AI 判同义
      const byNew = new Set();
      const usedOldLabels = new Set();
      const mergedFields = [];
      for (const nf of newFields) {
        const of = oldFields.find((x) => !usedOldLabels.has(x.label)
          && (x.label === nf.label || fieldKey(x.label) === fieldKey(nf.label)));
        if (of) {
          usedOldLabels.add(of.label);
          byNew.add(nf.label);
          mergedFields.push({ label: of.label, unit: of.unit || nf.unit, type: of.type || nf.type });   // 用户改过的名称/单位保留
        } else {
          mergedFields.push(nf);
        }
      }
      const unmatchedOld = oldFields.filter((x) => !usedOldLabels.has(x.label));
      const unmatchedNew = newFields.filter((x) => !byNew.has(x.label));
      const aiMap = await aiMatchFields(unmatchedOld.map((x) => x.label), unmatchedNew.map((x) => x.label));
      if (aiMap) {
        for (const nf of unmatchedNew) {
          const from = Object.keys(aiMap).find((k) => aiMap[k] === nf.label && !usedOldLabels.has(k));
          if (from == null) continue;
          const of = unmatchedOld.find((x) => x.label === from);
          if (!of) continue;
          usedOldLabels.add(of.label);
          byNew.add(nf.label);
          const index = mergedFields.findIndex((field) => field.label === nf.label);
          if (index !== -1) mergedFields[index] = { label: of.label, unit: of.unit || nf.unit, type: of.type || nf.type };
        }
      }
      // 用户手工添加、新解析认不出的旧字段保留在末尾
      const extras = oldFields.filter((x) => !usedOldLabels.has(x.label));
      extras.forEach((x) => mergedFields.push({ label: x.label, unit: x.unit || '', type: x.type || '' }));

      out.push({
        title: old ? (old.title || ns.title) : ns.title,
        instruction: ns.instruction || (old && old.instruction) || '',
        duration_hint: ns.duration_hint || (old && old.duration_hint) || '',
        notice: ns.notice || (old && old.notice) || '',
        pyro_seq: ns.pyro_seq || (old && old.pyro_seq) || '',
        checklist: [],
        fields: withChecklistFields(mergedFields, (ns.checklist && ns.checklist.length) ? ns.checklist : (old && old.checklist)),
        _mark: old ? 'kept' : 'new',
      });
    }

    // 用户自己加的步骤（新文档里没有）按原顺序追加到最后，不丢
    oldSteps.forEach((os, i) => {
      if (oldUsed.has(i)) return;
      out.push({
        title: os.title || '',
        instruction: os.instruction || '',
        duration_hint: os.duration_hint || '',
        notice: os.notice || '',
        pyro_seq: os.pyro_seq || '',
        checklist: [],
        fields: withChecklistFields((os.fields || []).map((f) => ({ label: f.label, unit: f.unit || '', type: f.type || '' })), os.checklist),
        _mark: 'user',
      });
    });

    return {
      steps: out,
      stats: { newCount: newCount, keptCount: keptCount, userKept: oldSteps.length - oldUsed.size },
    };
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
      // 编辑器用「行数组」表示注意事项，这里把解析出来的字符串转一次
      draft.steps.forEach((s) => { s.noticeRows = noticeRowsOf(s); });
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
    { value: 'check', label: '勾选已完成' },   // 执行时是一个勾选框：勾上=完成（存 '✓'，取消存空）
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

  /* 编辑器内部用「行数组」表示注意事项：保留空白行（刚点「＋ 注意事项」还没填内容时就是一行空）。
     渲染 / 拖动 / 删除都基于它；保存时再用 noticeText() 去掉空白行写库。 */
  function noticeRowsOf(s) {
    const raw = String((s && s.notice) || '');
    if (!raw) return (s && s.noticeRows) ? s.noticeRows.slice() : [];
    return raw.split(/[；;]/).map((x) => x.trim());
  }
  function noticeText(rows) {
    return (rows || []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join('；');
  }
  /* 空白行统计：没填内容的字段 / 注意事项（保存前提示用） */
  function countBlankRows(steps) {
    let n = 0;
    (steps || []).forEach((s) => {
      (s.fields || []).forEach((f) => { if (!String((f && f.label) || '').trim()) n += 1; });
      (s.noticeRows || []).forEach((x) => { if (!String(x || '').trim()) n += 1; });
    });
    return n;
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
        ? '保存后会更新这个方案；能安全对应的内容会同步到进行中实验；步骤结构改变时保留原实验快照。'
        : '可修改标题、增删步骤与字段，确认后保存。') + '</p>',
      '</div>',
      draft.steps.map((s, si) => [
        '<div class="step-card" data-step="' + si + '">',
        '  <div class="step-head">',
        // 拖动手柄：只有手柄可拖，免得在输入框里选文字时误触发拖动
        '    <span class="drag-handle" draggable="true" data-drag-step="' + si + '" title="拖动调整步骤顺序">⠿</span>',
        '    <span class="step-no">' + (si + 1) + '</span>',
        '    <input class="step-title-text" data-title="' + si + '" value="' + esc(s.title) + '" placeholder="步骤标题">',
        (s._mark === 'new' ? '    <span class="tag-mini">新增</span>'
          : s._mark === 'kept' ? '    <span class="tag-mini">保留（有你的手动修改）</span>'
          : s._mark === 'user' ? '    <span class="tag-mini">你之前加的</span>' : ''),
        '    <button type="button" class="ghost" data-drop-step="' + si + '">删除步骤</button>',
        '  </div>',
        '  <input data-duration="' + si + '" value="' + esc(s.duration_hint || '') + '" placeholder="时长提示（如：约 24 小时）" style="margin-bottom:8px">',
        '  <textarea data-instruction="' + si + '" rows="3" placeholder="步骤说明">' + esc(s.instruction || '') + '</textarea>',

        // ── 板块：只渲染这一步实际拥有的。
        //    板块按固定顺序渲染（数据字段 → 注意事项 → 已完成勾选 → 热解程序），同类永远连在一起；
        //    加内容统一走底部唯一的「＋ 添加板块」（点类型就追加一条）；
        //    删内容用每行右侧的 ×（把某类型的行删空，板块自然消失）。 ──

        s.fields.length ? [
          '  <div class="sub-block" data-fields-area="' + si + '">',
          '    <div class="sub-head"><span>数据字段</span></div>',
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

        (s.noticeRows || []).length ? [
          '  <div class="sub-block" data-notices-area="' + si + '">',
          '    <div class="sub-head"><span>⚠ 注意事项</span></div>',
          (s.noticeRows || []).map((line, ni) => [
            '    <div class="line-row" data-line-row="' + si + '-' + ni + '">',
            '      <span class="drag-handle" draggable="true" data-drag-notice="' + si + '-' + ni + '" title="拖动调整顺序">⠿</span>',
            '      <input data-notice="' + si + '-' + ni + '" value="' + esc(line) + '" placeholder="如：出现沉淀即为异常">',
            '      <button type="button" class="icon-btn del" data-drop-notice="' + si + '-' + ni + '" title="删除这条" aria-label="删除这条">×</button>',
            '    </div>',
          ].join('\n')).join(''),
          '  </div>',
        ].join('\n') : '',

        // （「已完成勾选」已并入「数据字段」：在字段行的填写方式里选「勾选已完成」即可）

        // 热解程序板块：标题里提到热解相关工序时自动出现；点右侧 × 移除。
        // × 与其它类型一样放在内容行的最右侧（用 .line-row 布局对齐）。
        ((s.pyro_seq || isPyroText(s)) && !s.pyro_hidden) ? [
          '  <div class="sub-block">',
          '    <div class="sub-head"><span>🔥 热解程序</span></div>',
          '    <div class="line-row">',
          '      <span></span>',
          // 生成/试算统一走右上角「小工具」里的热解计算器，这里只负责保存这一串程序
          '      <input class="pyro-input" data-pyro="' + si + '" value="' + esc(s.pyro_seq || '') + '" spellcheck="false" placeholder="粘贴程序串，或用右上角小工具算好再粘过来">',
          '      <button type="button" class="icon-btn del" data-drop-block="' + si + '-pyro" title="移除「热解程序」板块" aria-label="移除「热解程序」板块">×</button>',
          '    </div>',
          '  </div>',
        ].join('\n') : '',

        // 每个步骤只有这一个「＋ 添加板块」入口：点某个类型 = 追加一条该类型的内容
        // （没有该类型就先建板块）。类型顺序固定，所以同类永远连在一起。
        // 下拉展开状态存在草稿里：点「＋ 某类型」后不自动收起，可以连着点；想收起点一下标题。
        '  <details class="add-block"' + (s._addOpen ? ' open' : '') + '>',
        '    <summary>＋ 添加板块</summary>',
        '    <div class="add-block-menu">',
        '      <button type="button" class="ghost tiny" data-add-block="' + si + '-fields">＋ 数据字段</button>',
        '      <button type="button" class="ghost tiny" data-add-block="' + si + '-notice">＋ 注意事项</button>',
        ((s.pyro_seq || isPyroText(s)) && !s.pyro_hidden) ? '' : '      <button type="button" class="ghost tiny" data-add-block="' + si + '-pyro">＋ 热解程序</button>',
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

      // 注意事项：编辑器按「行数组」收集（**保留空白行**），保存时再用 noticeText() 去空写库。
      // 保留空白行，是为了"点了添加还没填内容"的行不被下一次 collect 吃掉。
      const noticeRows = [];
      host.querySelectorAll('[data-notice^="' + si + '-"]').forEach((inp) => { noticeRows.push(inp.value.trim()); });
      if (noticeRows.length || !(s.noticeRows || []).length) s.noticeRows = noticeRows;

      // 热解程序（方案里显式填的那一串；板块被移除时为 ''）
      const pyro = document.querySelector('[data-pyro="' + si + '"]');
      s.pyro_seq = pyro ? pyro.value.trim() : '';

      // 字段行保留空白行（不在这里过滤，保存前统一提示清理）；
      // 「勾选已完成」现在是字段的一种填写方式，不再有独立板块
      s.checklist = [];

      s.fields.forEach((f, fi) => {
        const n = document.querySelector('[data-field-name="' + si + '-' + fi + '"]');
        const u = document.querySelector('[data-field-unit="' + si + '-' + fi + '"]');
        const ty = document.querySelector('[data-field-type="' + si + '-' + fi + '"]');
        if (n) f.label = n.value.trim();
        if (u) f.unit = u.value.trim();
        if (ty) f.type = ty.value;
      });
      // 字段行也保留空白行（不在这里过滤，保存前统一提示清理）
    });
    // 只丢掉「真的一点内容都没有」的步骤：标题/说明/字段/注意事项/勾选/热解任一有内容都保留
    draft.steps = draft.steps.filter(stepHasContent);
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
      const lines = s.noticeRows || (s.noticeRows = noticeRowsOf(s));
      const moved = lines.splice(an, 1)[0];
      if (moved == null) return;
      lines.splice(bn, 0, moved);
    });

    host.querySelectorAll('[data-drop-step]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      draft.steps.splice(Number(b.dataset.dropStep), 1);
      renderDraft();
    }));

    // ── 板块：整步唯一的「＋ 添加板块」下拉；点某类型 = 追加一条该类型的内容 ──
    host.querySelectorAll('[data-add-block]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const parts = String(b.dataset.addBlock).split('-');
      const s = draft.steps[Number(parts[0])];
      const kind = parts[1];

      // 已有该类型就再追加一条，没有就先建板块（板块按类型聚合渲染，两条会连在一起）
      if (kind === 'fields') s.fields = (s.fields || []).concat([{ label: '', unit: '', type: 'text' }]);
      if (kind === 'notice') s.noticeRows = (s.noticeRows || noticeRowsOf(s)).concat(['']);
      if (kind === 'pyro') {
        s.pyro_hidden = false;                               // 之前被 × 移除过，这里重新放出来
        if (!s.pyro_seq) s.pyro_seq = 'C30-T60-C30-T184-C950-T60-C950--121';
      }
      s._addOpen = true;    // 下拉保持展开，方便接着加下一条（想收起点一下标题）
      renderDraft();
    }));

    // 板块级 × ：目前只有「热解程序」这种单条板块需要（列表型板块靠删空各行消失）
    host.querySelectorAll('[data-drop-block]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const parts = String(b.dataset.dropBlock).split('-');
      const s = draft.steps[Number(parts[0])];
      const kind = parts[1];

      if (kind === 'fields') s.fields = [];
      if (kind === 'notice') s.noticeRows = [];
      if (kind === 'pyro') { s.pyro_seq = ''; s.pyro_hidden = true; }   // 标题含「热解」时别自动又冒出来
      renderDraft();
    }));

    // 数据字段：删除一行
    host.querySelectorAll('[data-drop-field]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const parts = String(b.dataset.dropField).split('-');
      draft.steps[Number(parts[0])].fields.splice(Number(parts[1]), 1);
      renderDraft();
    }));

    // 注意事项：删除一条（添加走底部的「＋ 添加板块」）
    host.querySelectorAll('[data-drop-notice]').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      const parts = String(b.dataset.dropNotice).split('-');
      const s = draft.steps[Number(parts[0])];
      const lines = s.noticeRows || (s.noticeRows = noticeRowsOf(s));
      lines.splice(Number(parts[1]), 1);
      renderDraft();
    }));

    // 「＋ 添加板块」下拉的手动展开 / 收起也记进草稿，重绘后保持原状态
    host.querySelectorAll('.add-block').forEach((d, i) => {
      d.addEventListener('toggle', () => {
        const st = draft.steps[i];
        if (st) st._addOpen = d.open;
      });
    });

    $('draft-add-step').addEventListener('click', () => {
      collectDraft();
      draft.steps.push({
        title: '新步骤', instruction: '', duration_hint: '',
        notice: '', noticeRows: [], checklist: [], fields: [],
      });
      renderDraft();
    });

    $('draft-cancel').addEventListener('click', () => { draft = null; route('plans'); });

    $('draft-save').addEventListener('click', saveDraft);
  }

  /* 保存草稿：新建（来自 docx 导入）或更新（编辑已有方案） */
  /* 给「没写时长」的步骤补时长提示：先用规则从说明里抓（含「过夜」这类词），
     规则抓不到的再交给 AI（parse-plan 的 duration 模式）一次性补上。
     补的结果写进方案里，之后待办 / 执行界面都走确定性路径，不必每次再调 AI。
     AI 不可用（函数没更新 / 没部署 / 断网）就静默跳过，不影响保存。 */
  async function fillStepDurations(steps) {
    const todo = [];
    (steps || []).forEach((x, i) => {
      if (String(x.duration_hint || '').trim()) return;
      const byRule = guessDuration(x.instruction || '');
      if (byRule) { x.duration_hint = byRule; return; }
      if (String(x.instruction || '').trim()) todo.push(i);
    });
    if (!todo.length) return 0;

    try {
      const { data, error } = await client.functions.invoke('parse-plan', {
        body: {
          mode: 'duration',
          steps: todo.map((i) => ({ title: steps[i].title || '', instruction: steps[i].instruction || '' })),
        },
      });
      if (error || !data || !Array.isArray(data.durations)) {
        console.warn('[SciHub] 时长 AI 解析不可用（parse-plan 未更新 / 未部署？），已跳过：', error);
        return 0;
      }
      let n = 0;
      todo.forEach((i, k) => {
        const d = String(data.durations[k] || '').trim();
        if (d) { steps[i].duration_hint = d; n += 1; }
      });
      return n;
    } catch (err) {
      console.warn('[SciHub] 时长 AI 解析调用失败，已跳过：', err);
      return 0;
    }
  }

  /* 方案与步骤在数据库事务内保存；不再用多次 HTTP 写入模拟事务。 */
  let savingDraft = false;
  async function saveDraft() {
    if (savingDraft || !draft) return;
    collectDraft();
    if (!draft.steps.length) { setStatus('至少保留一个步骤。', 'error'); return; }
    try { SciHubSafety.validateFields(draft.steps); }
    catch (err) { setStatus(errorText(err), 'error'); return; }
    const blanks = countBlankRows(draft.steps);
    if (blanks && !window.confirm('检测到 ' + blanks + ' 处空白行。继续保存会忽略这些空白行，是否继续？')) return;

    savingDraft = true;
    const btn = $('draft-save');
    btn.disabled = true;
    const currentDraft = draft;
    try {
      await fillStepDurations(currentDraft.steps);
      const versionLog = (currentDraft.versionLog || []).concat([currentDraft.versionEntry || {
        at: new Date().toISOString(), type: currentDraft.id ? '编辑' : '导入',
        source: currentDraft.source || '', summary: currentDraft.id ? '手工编辑保存' : '导入方案',
      }]);
      const { data: planId, error } = await client.rpc('research_save_plan', {
        p_id: currentDraft.id || null,
        p_title: currentDraft.title.trim() || '未命名实验方案',
        p_source: currentDraft.source || '',
        p_parse_version: PARSE_VERSION,
        p_expected_updated_at: currentDraft.updatedAt || null,
        p_version_log: versionLog,
        p_steps: currentDraft.steps.map((step, index) => ({
          title: String(step.title || '').trim() || ('步骤 ' + (index + 1)),
          instruction: String(step.instruction || ''),
          notice: noticeText(step.noticeRows || noticeRowsOf(step)),
          pyro_seq: step.pyro_seq || '', duration_hint: step.duration_hint || '',
          fields: (step.fields || []).filter((field) => String(field.label || '').trim()),
        })),
      });
      if (error) throw error;
      if (!planId) throw new Error('没有收到保存回执，请核对后重试');
      if (draft === currentDraft) draft = null;
      const doneMsg = currentDraft.id ? '方案已更新。' : '方案已保存。';
      setStatus(doneMsg, 'ok');
      try {
        const result = await syncPlanToRunningRuns(planId);
        if (result.failed.length) setStatus(doneMsg + '以下实验保留原快照：' + result.failed.map((item) => item.title + '：' + item.reason).join('；'), 'warn');
        else if (result.updated || result.added) setStatus(doneMsg + '进行中的实验已同步。', 'ok');
      } catch (err) {
        setStatus(doneMsg + '本次实验保留原快照：' + errorText(err), 'warn');
      }
      savingDraft = false;
      route('plans');
    } catch (err) {
      console.error('[SciHub] 保存方案失败：', err);
      setStatus('保存未确认：' + errorText(err) + '。草稿仍保留；请核对后重试。', 'error');
    } finally {
      savingDraft = false;
      btn.disabled = false;
    }
  }

  /* 方案改完后，把最新的步骤结构同步到「正在使用这个方案」的实验 —— 真同步：
       · 方案里还存在的步骤：更新标题 / 说明 / 字段定义 / 注意事项 / 热解程序
       · 方案里新增的步骤：补进实验
       · 方案里已删的步骤：从实验里也删掉（会连带删掉那一步已填的数据，所以先弹窗确认）
     已填的 values、备注、照片在「没被删掉」的步骤上原样保留。
     返回 { updated, added, removed }。 */
  async function syncPlanToRunningRuns(planId) {
    const none = { updated: 0, added: 0, removed: 0, failed: [] };
    const { data: runs, error: runsError } = await client
      .from(RUN).select('id,title,current_step').eq('plan_id', planId).eq('status', 'running');
    if (runsError) throw runsError;
    if (!runs || !runs.length) return none;

    const { data: planSteps, error: planError } = await client.from(STEP).select('*').eq('plan_id', planId).order('position');
    if (planError) throw planError;
    if (!planSteps || !planSteps.length) return none;   // 方案一步不剩时不动实验，避免把实验清空

    const { data: runSteps, error: stepsError } = await client.from(RUN_STEP).select('*').in('run_id', runs.map((r) => r.id));
    if (stepsError) throw stepsError;
    const rows = runSteps || [];
    runs.forEach((item) => SciHubSafety.assertSafeStepSync(planSteps, rows.filter((step) => step.run_id === item.id)));

    // ── 先处理「删」：方案里已经没有的 position，实验里也去掉 ──
    const planPositions = new Set(planSteps.map((p) => p.position));
    const doomed = rows.filter((rs) => !planPositions.has(rs.position));

    if (doomed.length) {
      const withData = doomed.filter((rs) => stepHasProgress(rs));
      const list = doomed.map((rs) => '· 第 ' + (rs.position + 1) + ' 步：' + (rs.title || '')).join('\n');
      const warn = withData.length
        ? '\n\n⚠ 其中 ' + withData.length + ' 个步骤已经填过数据 / 传过照片，会一并丢失：\n'
          + withData.map((rs) => '· 第 ' + (rs.position + 1) + ' 步：' + (rs.title || '')).join('\n')
        : '';
      const ok = window.confirm(
        '方案里已经删掉了下面 ' + doomed.length + ' 个步骤，要从 ' + runs.length + ' 个进行中的实验里也删掉吗？\n\n'
        + list + warn
      );
      if (!ok) return none;

      const { error } = await client.from(RUN_STEP).delete().in('id', doomed.map((rs) => rs.id));
      if (error) throw error;
    }

    // ── 再处理「改」和「增」 ──
    let updated = 0;
    let added = 0;
    const failed = [];

    for (const run of runs) {
      try {
      const byPos = {};
      rows.forEach((rs) => { if (rs.run_id === run.id && planPositions.has(rs.position)) byPos[rs.position] = rs; });

      for (const ps of planSteps) {
        const rs = byPos[ps.position];
        const newFields = ps.fields || [];

        // 方案新增的步骤 → 补进这次实验
        if (!rs) {
          const ins = {
            user_id: state.user.id,
            run_id: run.id,
            position: ps.position,
            title: ps.title,
            instruction: ps.instruction || '',
            notice: ps.notice || '',
            pyro_seq: ps.pyro_seq || '',
            duration_hint: ps.duration_hint || '',
            fields: newFields,
            values: {},
            images: [],
            status: 'pending',
            checks: Object.fromEntries((ps.checklist || []).map((c) => [String(c), false])),
          };
          let { error } = await client.from(RUN_STEP).insert(ins);
          if (error && /checks/.test(String(error.message || ''))) {
            const slim = Object.assign({}, ins); delete slim.checks;
            ({ error } = await client.from(RUN_STEP).insert(slim));
          }
          if (error) throw error;
          added += 1;
          continue;
        }

        // 已存在的步骤：值以字段名为键，字段改名/新增时按含义搬家，搬不走的旧值原样保留。
        // 旧方案把「勾选」存在 checks 里，现在勾选是字段（type='check'）——
        // 这里把已勾过的状态搬成字段值 '✓'，用户之前的进度不会丢。
        const oldChecks = rs.checks || {};
        const seed = {};
        Object.keys(oldChecks).forEach((k) => { if (oldChecks[k]) seed[k] = '✓'; });
        const oldFields = rs.fields || [];
        const values = migrateStepValues(oldFields, newFields, Object.assign({}, seed, rs.values), null);
        const next = {
          title: ps.title || rs.title,
          instruction: ps.instruction || '',
          notice: ps.notice || '',
          pyro_seq: ps.pyro_seq || '',
            duration_hint: ps.duration_hint || '',
          fields: newFields,
          values: values,
          checks: {},        // 勾选状态已迁移进字段值
        };

        const before = JSON.stringify([rs.title, rs.instruction, rs.notice, rs.pyro_seq || '', rs.duration_hint || '', oldFields, rs.values, oldChecks]);
        const after = JSON.stringify([next.title, next.instruction, next.notice, next.pyro_seq, next.duration_hint, next.fields, next.values, next.checks]);
        if (before === after) continue;    // 没有实质变化就不写库

        const { data: saved, error } = await client.from(RUN_STEP).update(next).eq('id', rs.id).eq('updated_at', rs.updated_at).select('id').maybeSingle();
        if (!error && !saved) throw new Error('步骤已在其他设备修改，本次不覆盖其数据');
        if (error) throw error;
        updated += 1;
      }

      // 当前进行到的那一步可能正好被删掉了 → 指针挪回最后一步，避免指向不存在的步骤
      const last = planSteps.length - 1;
      const want = Math.min(Math.max(0, Number(run.current_step) || 0), last);
      if (want !== run.current_step) {
        await client.from(RUN).update({ current_step: want }).eq('id', run.id);
      }
      } catch (err) {
        console.warn('[SciHub] 同步方案到实验失败（' + (run.title || run.id) + '）：', err);
        failed.push({ runId: run.id, title: run.title || ('实验 #' + run.id), reason: errorText(err) });
      }
    }

    return { updated: updated, added: added, removed: doomed.length, failed: failed };
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
        updatedAt: plan.updated_at,
      title: plan.title,
      source: plan.source || '',
      versionLog: (plan.version_log || []).slice(),
      steps: (steps || []).map((s) => ({
        title: s.title || '',
        instruction: s.instruction || '',
        duration_hint: s.duration_hint || '',
        notice: s.notice || '',     // 少了这一行，编辑保存后注意事项会被清空
        noticeRows: noticeRowsOf(s),  // 编辑器用的行数组（保留空白行）
        pyro_seq: s.pyro_seq || '',
        checklist: [],   // 「已完成勾选」已并入数据字段：把旧条目转成 check 类型字段
        fields: withChecklistFields((s.fields || []).map((f) => ({ label: f.label, unit: f.unit || '', type: f.type || '' })), s.checklist),
      })),
    };
    renderDraft();
    showView('plan');
  }

  /* 抢救：方案步骤被清空后，从「用这个方案开过的实验」里把步骤快照搬回编辑器。
     实验的 run_steps 是起跑时的快照（之后改方案也会同步更新），标题 / 说明 / 字段 /
     注意事项 / 热解程序 / 时长都在，所以能照着重建一份。
     只把内容填进编辑器、不直接写库 —— 你核对无误后自己点「保存方案」，
     走的是非破坏性保存，不会再出现「一保存就清空」。 */
  async function restorePlanFromRun(planId) {
    setStatus('正在找这个方案的实验快照…');
    try {
      const { data: plan } = await client.from(PLAN).select('*').eq('id', planId).maybeSingle();
      if (!plan) { setStatus('方案不存在。', 'error'); return; }

      const { data: runs } = await client.from(RUN)
        .select('id, title, started_at').eq('plan_id', planId)
        .order('started_at', { ascending: false });
      if (!runs || !runs.length) {
        setStatus('这个方案还没有开过实验，没有可用的快照 —— 请用「上传新版本」重新导入原来的 docx。', 'warn');
        return;
      }

      // 取步骤最多的那个实验：同一方案做过多次时它最完整
      let best = null;
      for (const r of runs) {
        const { count } = await client.from(RUN_STEP)
          .select('id', { count: 'exact', head: true }).eq('run_id', r.id);
        const n = count || 0;
        if (!best || n > best.count) best = { run: r, count: n };
      }
      if (!best.count) {
        setStatus('这个方案名下的实验里也没有步骤快照，无法恢复 —— 请用「上传新版本」重新导入原来的 docx。', 'warn');
        return;
      }

      const { data: steps } = await client.from(RUN_STEP)
        .select('*').eq('run_id', best.run.id).order('position');
      if (!steps || !steps.length) { setStatus('没读到实验快照里的步骤。', 'warn'); return; }

      draft = {
        id: plan.id,
        updatedAt: plan.updated_at,
        title: plan.title,
        source: plan.source || '',
        versionLog: (plan.version_log || []).slice(),
        versionEntry: {
          at: new Date().toISOString(),
          type: '恢复',
          source: best.run.title || '',
          summary: '从实验快照恢复 ' + steps.length + ' 个步骤',
        },
        steps: steps.map((s) => ({
          title: s.title || '',
          instruction: s.instruction || '',
          duration_hint: s.duration_hint || '',
          notice: s.notice || '',
          noticeRows: noticeRowsOf(s),
          pyro_seq: s.pyro_seq || '',
          checklist: [],   // 勾选已是字段（type='check'），run_steps 的勾选状态不搬回方案
          fields: (s.fields || []).map((f) => ({ label: f.label, unit: f.unit || '', type: f.type || '' })),
        })),
      };
      renderDraft();
      showView('plan');
      setStatus('已从实验「' + (best.run.title || '未命名实验') + '」搬回 ' + steps.length
        + ' 个步骤（步骤内容，不含当时填的数据）。请核对后点「保存方案」。', 'ok');
    } catch (err) {
      console.error('[SciHub] 从实验快照恢复方案失败：', err);
      setStatus('恢复失败：' + errorText(err), 'error');
    }
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

    // 更新日志：按「上传/保存日期」标识版本（方案名不变，用日期区分新旧）
    const vlog = (plan.version_log || []).slice().reverse();
    const versionLogHtml = vlog.length ? [
      '<div class="card" style="margin-bottom:14px">',
      '  <div class="sub-head"><span>🕓 更新日志（按日期区分版本）</span></div>',
      vlog.map((e, i) => {
        const dateTxt = e.at ? fmt(e.at) : '未知日期';
        const badge = i === 0 ? '<b class="tag-mini">当前 · ' + dateTxt + '</b>' : '<span class="tag-mini">旧版本 · ' + dateTxt + '</span>';
        return '  <div class="hc-meta" style="margin:6px 0">' + badge
          + ' ' + esc(e.type || '更新') + (e.source ? ' · ' + esc(e.source) : '')
          + (e.summary ? ' · ' + esc(e.summary) : '') + '</div>';
      }).join('\n'),
      '</div>',
    ].join('\n') : '';

    host.innerHTML = [
      '<div class="section-title">' + esc(plan.title) + '</div>',
      '  <p class="hint small" style="margin-bottom:12px">' + (plan.source ? '来源：' + esc(plan.source) + ' · ' : '') + '共 ' + (steps || []).length + ' 个步骤</p>',

      // 步骤被清空时（v1.0.1 及更早的保存会「先删后写」，写入失败就清空）给一条明路
      (steps || []).length ? '' : [
        '<div class="card" style="margin-bottom:14px;border-left:3px solid #d97706">',
        '  <div class="sub-head"><span>⚠ 这个方案现在有 0 个步骤</span></div>',
        '  <p class="hint small">v1.0.1 及更早版本的保存是「先把旧步骤删掉、再写新步骤」，写入失败或被刷新打断就会清空步骤，而更新日志仍会记一条「已保存」。现已改成先写新步骤、成功后再删旧步骤。</p>',
        '  <p class="hint small">恢复：这个方案开过实验 → 点「从实验快照恢复步骤」核对后保存；没开过实验 → 用「上传新版本」重新导入原来的 docx。</p>',
        '</div>',
      ].join('\n'),
      versionLogHtml,

      // 操作按钮放在标题下方（原来在页面最底部，要滚到底才点得到）
      '<div class="run-actions" style="margin-top:0;margin-bottom:16px;flex-wrap:wrap">',
      '  <button type="button" class="primary" id="plan-start">开始实验</button>',
      '  <button type="button" class="ghost" id="plan-edit">编辑方案</button>',
      (steps || []).length ? '' : '  <button type="button" class="fresh-btn" id="plan-restore" title="从用这个方案开过的实验里，把步骤快照搬回编辑器">从实验快照恢复步骤</button>',
      '  <button type="button" class="ghost" id="plan-upload-ver">上传新版本</button>',
      '  <input type="file" id="ver-input" accept=".docx" hidden>',
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
          + noticeLines(s).filter(Boolean).map((line) => '<span class="notice-item">' + highlight(line) + '</span>').join('')
          + '</div></div>' : '',
        (s.fields || []).length ? '  <div class="hc-meta" style="margin-top:8px">数据字段：' + (s.fields || []).map((f) => esc(f.label) + (f.unit ? '（' + esc(f.unit) + '）' : '')).join('、') + '</div>' : '',
        (s.checklist || []).length ? '  <div class="hc-meta" style="margin-top:8px">☑ 已完成勾选：' + (s.checklist || []).map((c) => esc(c)).join('、') + '</div>' : '',
        '</div>',
      ].join('\n')).join(''),
    ].join('\n');

    $('plan-back').addEventListener('click', () => route('plans'));
    $('plan-start').addEventListener('click', () => startRun(planId));
    $('plan-edit').addEventListener('click', () => editPlan(planId));
    if ($('plan-restore')) $('plan-restore').addEventListener('click', () => restorePlanFromRun(planId));

    // 「上传新版本」：选一份新 .docx → AI 解析（失败回退规则）→ 打开「核对导入结果」
    // 界面让你确认；保存时会把变化同步到进行中的实验并迁移数据（见 saveDraft）。
    const verInput = $('ver-input');
    $('plan-upload-ver').addEventListener('click', () => verInput.click());
    verInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';   // 允许连续选同一个文件
      if (!f) return;
      setStatus('正在解析新版本…');
      try {
        const { name, paras } = await readDocx(f);
        const text = paras.join('\n');
        let parsed = await parsePlanSmart(text);
        if (!parsed) parsed = parsePlan(name, paras);
        parsed.title = parsed.title || plan.title || name;

        // 智能合并：没改的部分和用户手动编辑过的部分（字段名/单位/类型/注意事项/
        // 热解程序/勾选条目/自己加的步骤）都保留，只有新文档里确实变了的才更新。
        const merged = await mergePlanVersions(steps || [], parsed.steps);
        draft = {
          id: plan.id,
        updatedAt: plan.updated_at,
          title: parsed.title,
          source: name,
          versionLog: (plan.version_log || []).slice(),
          versionEntry: {
            at: new Date().toISOString(),
            type: '上传新版本',
            source: name,
            summary: '新增 ' + merged.stats.newCount + ' 步、保留并更新 ' + merged.stats.keptCount + ' 步、保留你之前加的 ' + merged.stats.userKept + ' 步',
          },
          steps: merged.steps.map((s) => ({
            title: s.title || '',
            instruction: s.instruction || '',
            duration_hint: s.duration_hint || '',
            notice: s.notice || '',
            noticeRows: noticeRowsOf(s),   // 编辑器用的行数组（保留空白行）
            pyro_seq: s.pyro_seq || '',
            checklist: s.checklist || [],
            fields: (s.fields || []).map((fl) => ({ label: fl.label, unit: fl.unit || '', type: fl.type || '' })),
            _mark: s._mark || '',
          })),
        };
        renderDraft();
        showView('plan');
        setStatus('已解析出新版本，并保留了你之前的手动修改；请核对后保存（保存时会同步到进行中的实验并迁移数据）。', 'ok');
      } catch (err) {
        console.error('[SciHub] 解析新版本失败：', err);
        setStatus('解析新版本失败：' + errorText(err), 'error');
      }
    });

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

  let startingRun = false;
  async function startRun(planId) {
    if (startingRun) return;
    startingRun = true;
    setStatus('正在准备实验…');
    try {
      const { data: plan } = await client.from(PLAN).select('*').eq('id', planId).maybeSingle();
      const { data: steps } = await client.from(STEP).select('*').eq('plan_id', planId).order('position');
      if (!plan || !steps || !steps.length) { setStatus('方案没有可用步骤。', 'error'); return; }

      // 同一个方案常常要做很多次：已有实验时给标题加序号，
      // 否则主页 / 待办里会出现一串同名实验，分不清是哪一次。
      const { count } = await client
        .from(RUN)
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', plan.id);
      const nth = (count || 0) + 1;
      const runTitle = nth > 1 ? plan.title + '（第 ' + nth + ' 次）' : plan.title;

      const { data: run, error } = await client.from(RUN).insert({
        user_id: state.user.id,
        plan_id: plan.id,
        title: runTitle,
        status: 'aborted',
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
        duration_hint: s.duration_hint || '',   // 一并快照方案里的「时长提示」（列见 supabase_schema.sql）
        fields: s.fields,
        values: {},
        images: [],
        status: 'pending',
        // 已完成勾选：把方案的条目快照成「{条目: false}」，执行时逐个打勾
        checks: Object.fromEntries((s.checklist || []).map((c) => [String(c), false])),
      }));
      let stepErr = (await client.from(RUN_STEP).insert(rows)).error;
      if (stepErr && /duration_hint|checks/.test(String(stepErr.message || ''))) {
        // Supabase 里还没执行那段加列的 SQL → 去掉新字段重试，别让实验开不出来
        console.warn('[SciHub] run_steps 还没有 duration_hint / checks 列，本次不带它们写入：', stepErr.message);
        const slim = rows.map((x) => {
          const o = Object.assign({}, x);
          delete o.duration_hint;
          delete o.checks;
          return o;
        });
        stepErr = (await client.from(RUN_STEP).insert(slim)).error;
      }
      if (stepErr) throw stepErr;

      const { error: activationError } = await client.from(RUN).update({ status: 'running' }).eq('id', run.id);
      if (activationError) throw activationError;
      setStatus('实验已开始，随时可以继续。', 'ok');
      startingRun = false;
      route('run', run.id);
    } catch (err) {
      console.error('[SciHub] 开始实验失败：', err);
      setStatus('实验准备未完成：' + errorText(err) + '。未完成的准备记录已保留，不会出现在进行中列表。', 'error');
    } finally { startingRun = false; }
  }

  window.Plans = { list: listPlans, editor: renderEditor, start: startRun };

  /* ══ 执行界面 ═══════════════════════════════════════════ */

  const run = { id: null, data: null, steps: [], pos: 0, urls: {}, urlErrors: {}, drift: { fields: [] } };

  /* 对比「本次实验」与「方案当前内容」，给出步骤级差异 —— 用来实时提示「是否与方案同步」。
     覆盖五种情况：方案新增的步骤、方案已删的步骤、内容改过的步骤、
     新增的数据字段，以及「方案删掉了某个字段、但实验里已经填了值」。
     返回 { same, added:[], removed:[], changed:[], fieldAdded:[], fieldRemoved:[] } */
  async function planDiff(r) {
    const snapshot = run.steps.slice();
    const empty = { same: true, added: [], removed: [], changed: [], fieldAdded: [], fieldRemoved: [] };
    if (!r || !r.plan_id) return empty;

    const { data: planSteps, error } = await client.from(STEP).select('*').eq('plan_id', r.plan_id).order('position');
    if (error) throw error;
    if (!planSteps || !planSteps.length) return empty;   // 方案一步不剩时不当成「不同步」

    const byPos = {};
    snapshot.forEach((s) => { byPos[s.position] = s; });
    const planByPos = {};
    planSteps.forEach((p) => { planByPos[p.position] = p; });

    // 方案有、实验没有 → 需要补
    const added = planSteps.filter((p) => !byPos[p.position])
      .map((p) => ({ position: p.position, title: p.title }));
    // 实验有、方案没有 → 方案里删掉了
    const removed = snapshot.filter((s) => !planByPos[s.position])
      .map((s) => Object.assign({}, s));

    const changed = [];
    const fieldAdded = [];
    planSteps.forEach((p) => {
      const s = byPos[p.position];
      if (!s) return;

      const what = [];
      if (String(s.title || '') !== String(p.title || '')) what.push('标题');
      if (String(s.instruction || '') !== String(p.instruction || '')) what.push('说明');
      if (String(s.notice || '') !== String(p.notice || '')) what.push('注意事项');
      if (String(s.pyro_seq || '') !== String(p.pyro_seq || '')) what.push('热解程序');
      if (String(s.duration_hint || '') !== String(p.duration_hint || '')) what.push('时长提示');
      if (JSON.stringify(s.fields || []) !== JSON.stringify(p.fields || [])) what.push('字段定义');
      if (what.length) changed.push({ position: p.position, title: p.title, what: what.join('、') });

      const keys = new Set((s.fields || []).map((f) => fieldKey(f.label)));
      (p.fields || []).forEach((f) => {
        if (keys.has(fieldKey(f.label))) return;
        fieldAdded.push({ position: p.position, label: f.label, unit: f.unit || '' });
      });
    });

    // 方案里删掉了某个字段、但实验里已经填过值 → 值还在，只是方案不再有这个字段。
    // 必须提醒用户：否则他会以为数据丢了，或者继续照旧字段填。
    const fieldRemoved = [];
    snapshot.forEach((s) => {
      const ps = planByPos[s.position];
      if (!ps) return;                                    // 整步被删的情况另有提示，这里不重复
      const planKeys = new Set((ps.fields || []).map((f) => fieldKey(f.label)));
      const vals = s.values || {};
      (s.fields || []).forEach((f) => {
        if (planKeys.has(fieldKey(f.label))) return;
        const v = vals[f.label];
        if (v == null || String(v).trim() === '') return;  // 没填过值的静默去掉，不必打扰
        fieldRemoved.push({ position: s.position, label: f.label, value: String(v) });
      });
    });

    return {
      same: !added.length && !removed.length && !changed.length
        && !fieldAdded.length && !fieldRemoved.length,
      added: added, removed: removed, changed: changed,
      fieldAdded: fieldAdded, fieldRemoved: fieldRemoved,
    };
  }

  /* 立即把本次实验与方案对齐：补上方案新增的步骤与字段、更新改过的内容。
     （方案里已删的步骤不在这里删 —— 那要丢数据，得在保存方案时确认，避免这里误删正在填的内容。） */
  let syncingRun = false;
  async function syncRunNow() {
    if (syncingRun) return;
    syncingRun = true;
    try { await performSyncRunNow(); }
    finally { syncingRun = false; }
  }

  async function performSyncRunNow() {
    const r = run.data;
    if (!r || !r.plan_id || r.status !== 'running') return;
    if (!await flushSaves()) return;

    setStatus('正在与方案同步…');
    try {
      const { data: planSteps, error: planError } = await client.from(STEP).select('*').eq('plan_id', r.plan_id).order('position');
      if (planError) throw planError;
      if (!planSteps || !planSteps.length) { setStatus('这个方案没有步骤，无法同步。', 'warn'); return; }

      SciHubSafety.assertSafeStepSync(planSteps, run.steps);
      const byPos = {};
      run.steps.forEach((s) => { byPos[s.position] = s; });
      let n = 0;

      for (const ps of planSteps) {
        const s = byPos[ps.position];

        // 方案新增的步骤 → 补进本次实验
        if (!s) {
          const { data: made, error } = await client.from(RUN_STEP).insert({
            user_id: state.user.id,
            run_id: run.id,
            position: ps.position,
            title: ps.title,
            instruction: ps.instruction || '',
            notice: ps.notice || '',
            pyro_seq: ps.pyro_seq || '',
            duration_hint: ps.duration_hint || '',
            fields: ps.fields || [],
            values: {},
            images: [],
            status: 'pending',
          }).select().single();
          if (error) throw error;
          run.steps.push(made);
          n += 1;
          continue;
        }

        const newFields = ps.fields || [];
        const values = migrateStepValues(s.fields || [], newFields, s.values, null);
        const next = {
          title: ps.title || s.title,
          instruction: ps.instruction || '',
          notice: ps.notice || '',
          pyro_seq: ps.pyro_seq || '',
            duration_hint: ps.duration_hint || '',
          fields: newFields,
          values: values,
        };

        const before = JSON.stringify([s.title, s.instruction, s.notice, s.pyro_seq || '', s.duration_hint || '', s.fields || [], s.values]);
        const after = JSON.stringify([next.title, next.instruction, next.notice, next.pyro_seq, next.duration_hint, next.fields, next.values]);
        if (before === after) continue;

        const { data: saved, error } = await client.from(RUN_STEP).update(next).eq('id', s.id).eq('updated_at', s.updated_at).select('updated_at').maybeSingle();
        if (!error && !saved) throw new Error('步骤已在他端修改，请重新核对');
        if (saved) next.updated_at = saved.updated_at;
        if (error) throw error;
        Object.assign(s, next);
        n += 1;
      }

      run.steps.sort((a, b) => a.position - b.position);
      run.drift = await planDiff(r);
      setStatus(n ? ('已与方案同步，更新了 ' + n + ' 处。') : '已经和方案一致，无需改动。', 'ok');
      drawRun();
    } catch (err) {
      console.error('[SciHub] 同步失败：', err);
      setStatus('同步失败：' + errorText(err), 'error');
    }
  }

  /* 实验里还留着「方案里已经删掉的步骤」时，从这里清掉。
     这种残留是这么来的：同步只按 position 配对，方案里少掉的步骤不会被实验自动删掉 ——
     保存方案时的确认框一旦被点「取消」，或者用的是早期「只增改、不删」的同步逻辑，
     实验里就会多出末尾一步，内容和上一步一样，而方案里已经没有它。
     表现：执行界面一直显示「方案已删 N 步（实验里还有）」，点「立即同步」怎么都不消失。 */
  async function dropExtraSteps() {
    if (syncingRun) return;
    syncingRun = true;
    try { await performDropExtraSteps(); }
    finally { syncingRun = false; }
  }

  async function performDropExtraSteps() {
    const r = run.data;
    if (!r || !r.plan_id || r.status !== 'running') return;
    if (!await flushSaves()) return;
    const { data: planSteps, error: planError } = await client.from(STEP).select('*').eq('plan_id', r.plan_id).order('position');
    if (planError) { setStatus('无法核对方案，已取消清理。', 'error'); return; }
    try { SciHubSafety.assertSafeStepSync(planSteps || [], run.steps); }
    catch (err) { setStatus(errorText(err), 'warn'); return; }

    // 动手前把差异重新算一遍：别的设备刚改过方案时，界面上那份旧差异可能已经过时，
    // 拿它去删就可能删掉方案里其实还在的步骤。核对失败就直接不动手。
    let fresh = null;
    try {
      fresh = await planDiff(r);
    } catch (err) {
      console.error('[SciHub] 重新核对方案失败，已取消删除：', err);
      setStatus('无法重新核对方案（' + errorText(err) + '），已取消删除。', 'error');
      return;
    }
    run.drift = fresh;
    const list = (fresh && fresh.removed) || [];
    if (!list.length) { setStatus('没有方案里已删掉的步骤，不用清理。', 'ok'); drawRun(); return; }

    const withData = list.filter((x) => stepHasProgress(x));
    const lines = list.map((x) => '· 第 ' + (x.position + 1) + ' 步：' + (x.title || '')).join('\n');
    const warn = withData.length
      ? '\n\n⚠ 其中 ' + withData.length + ' 步已经填过数据 / 传过照片，会一起永久删除，无法恢复：\n'
        + withData.map((x) => '· 第 ' + (x.position + 1) + ' 步：' + (x.title || '')).join('\n')
      : '';
    const ok = window.confirm(
      '这次实验里还留着下面 ' + list.length + ' 个「方案里已经删掉的步骤」，要从实验里删掉吗？\n\n'
      + lines + warn
    );
    if (!ok) return;

    setStatus('正在删除多余的步骤…');
    try {
      const ids = list.map((x) => x.id).filter((v) => v != null);
      // position 在 run_steps 里是唯一的，所以按 id 删、按 position 删结果一样
      const del = (ids.length === list.length)
        ? client.from(RUN_STEP).delete().in('id', ids)
        : client.from(RUN_STEP).delete().eq('run_id', r.id).in('position', list.map((x) => x.position));
      const { error } = await del;
      if (error) throw error;

      const { data: steps, error: loadErr } = await client
        .from(RUN_STEP).select('*').eq('run_id', r.id).order('position');
      if (loadErr) throw loadErr;
      run.steps = steps || [];

      // 删掉的正好是「上次停在这里」那一步时，把指针夹回最后一步，避免指向不存在的步骤
      const last = Math.max(0, run.steps.length - 1);
      const want = Math.min(Math.max(0, Number(r.current_step) || 0), last);
      if (want !== r.current_step) {
        const { error: ptrErr } = await client.from(RUN).update({ current_step: want }).eq('id', r.id);
        if (ptrErr) throw ptrErr;
        r.current_step = want;
      }

      if (run.pos > last) run.pos = last;          // 浏览位置夹回可见范围（drawRun 里还会再夹一次）
      run.drift = await planDiff(r);
      drawRun();
      setStatus('已删掉 ' + list.length + ' 个多余的步骤。', 'ok');
    } catch (err) {
      console.error('[SciHub] 删除多余步骤失败：', err);
      setStatus('删除失败：' + errorText(err), 'error');
      drawRun();
    }
  }

  /* 方案里删掉的字段、而实验里已经填过值 → 弹一次提醒，点「知道了」后记住，不再重复弹。
     数据本身还在（导出时照样写进 Word），只是方案里已经没有这个字段了。 */
  function maybeWarnRemovedFields() {
    const list = (run.drift && run.drift.fieldRemoved) || [];
    if (!list.length) return;

    const sig = list.map((x) => x.position + ':' + x.label).sort().join('|');
    const key = 'scihub.removedFields.' + run.id;
    let seen = '';
    try { seen = window.localStorage.getItem(key) || ''; } catch (_e) { /* 隐私模式下忽略 */ }
    if (seen === sig) return;      // 同一批字段已经提醒过，不再打扰

    openModal('方案里删掉了这些数据字段', [
      '<p class="hint small">下面这些字段在方案里已经被删除，但本次实验里还留着当时填的值。</p>',
      '<div class="lost-list">',
      list.map((x) => '<div class="lost-row">'
        + '<b>第 ' + (x.position + 1) + ' 步 · ' + esc(x.label) + '</b>'
        + '<span>已填：' + esc(x.value) + '</span>'
        + '</div>').join(''),
      '</div>',
      '<p class="hint small">数据不会丢 —— 导出实验记录时这些字段仍会照常写进 Word。只是方案里没有它们了，以后新建的实验也不会再有这几项。</p>',
    ].join(''), [
      {
        label: '知道了',
        primary: true,
        onClick: () => {
          try { window.localStorage.setItem(key, sig); } catch (_e) { /* 忽略 */ }
          closeModal();
        },
      },
    ]);
  }

  let runRenderSequence = 0;
  async function renderRun(runId) {
    const sequence = ++runRenderSequence;
    const isCurrent = () => sequence === runRenderSequence && !host.hidden && state.user && state.user.id === ownerId;
    const host = $('view-run');
    host.innerHTML = '<div class="empty">加载中…</div>';

    const ownerId = state.user && state.user.id;
    const { data: r, error: runError } = await client.from(RUN).select('*').eq('id', runId).maybeSingle();
    const { data: steps, error: stepsError } = await client.from(RUN_STEP).select('*').eq('run_id', runId).order('position');
    if (!isCurrent()) return;
    if (runError || stepsError) { host.innerHTML = '<div class="empty">实验加载失败，请稍后重试。</div>'; return; }
    if (!r) { host.innerHTML = '<div class="empty">实验记录不存在。</div>'; return; }

    const mergeInfo = window.Merges ? await window.Merges.context(runId) : null;
    if (!isCurrent()) return;
    if (window.Merges) window.Merges.decorate([r]);
    run.mergeInfo = mergeInfo;
    run.id = runId;
    run.data = r;
    run.steps = steps || [];
    // 「继续」时回到上次所在的那一步（current_step 是存在云端的，换设备也一致）
    run.pos = Math.min(r.current_step || 0, Math.max(0, run.steps.length - 1));
    run.urls = {};
    run.urlErrors = {};
    run.drift = { same: true, added: [], removed: [], changed: [], fieldAdded: [], fieldRemoved: [] };

    // 步骤上关联到的其它实验：把标题一次性查出来，界面上直接显示名字
    run.linked = {};
    const linkIds = [...new Set(run.steps.map((s) => s.link_run_id).filter(Boolean))];
    if (linkIds.length) {
      const { data: linkedRuns } = await client.from(RUN).select('id,title').in('id', linkIds);
      if (!isCurrent()) return;
      (linkedRuns || []).forEach((x) => { run.linked[x.id] = x.title; });
    }

    // 预取图片的签名地址（私有 bucket）：一次批量签名，并记录失败原因给缩略图提示
    const paths = [];
    run.steps.forEach((s) => (s.images || []).forEach((img) => { if (img && img.path) paths.push(img.path); }));

    if (paths.length) {
      const { data: signedList, error: signError } = await client.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 24);
      if (!isCurrent()) return;
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

    // 我是不是某个合并组里的「子实验」？—— 别的实验的某一步 link 到我，就说明是。
    // 那种情况只看合并点之前的步骤：合并点之后的事是和大家一起做的，不该各看各的。
    run.mergeCut = null;
    run.mergedFrom = [];
    try {
      const { data: intoMe } = await client.from(RUN_STEP).select('run_id,position').eq('link_run_id', runId);
      if (!isCurrent()) return;
      if (intoMe && intoMe.length) {
        run.mergeCut = Math.max.apply(null, intoMe.map((x) => x.position));
        run.mergedFrom = intoMe.map((x) => x.run_id);
      }
    } catch (err) {
      console.warn('[SciHub] 合并点检查失败：', err);
    }

    // 关联组信息：合并点 linkAt + 组内可切换查看的实验 peers。
    // 我发起的关联：linkAt 取我这边第一个 link_run_id 的 position；
    // 别人 link 到我：linkAt 取 mergeCut。合并点之后的步骤在步骤条上标黄。
    run.linkAt = null;
    run.peers = [{ id: run.id, title: run.data.title }];
    const selfLinkPos = (run.steps || []).filter((s) => s.link_run_id).map((s) => s.position);
    if (selfLinkPos.length) {
      run.linkAt = Math.min.apply(null, selfLinkPos);
      Object.keys(run.linked || {}).forEach((k) => {
        const id = Number(k);
        if (run.peers.some((p) => p.id === id)) return;
        run.peers.push({ id: id, title: run.linked[k] });
      });
    }
    if (run.mergeCut != null) {
      if (run.linkAt == null) run.linkAt = run.mergeCut;
      const needTitles = (run.mergedFrom || []).filter((id) => !run.peers.some((p) => p.id === id));
      if (needTitles.length) {
        const { data: mergedRuns } = await client.from(RUN).select('id,title').in('id', needTitles);
        if (!isCurrent()) return;
        (mergedRuns || []).forEach((x) => run.peers.push({ id: x.id, title: x.title }));
      }
    }

    if (mergeInfo && mergeInfo.isParent) run.mergeCut = mergeInfo.group.after_position + 1;

    // 与方案对齐检查：方案后来增/删/改过步骤就会记下差异，界面顶部实时提示
    try {
      const drift = mergeInfo ? run.drift : await planDiff(r);
      if (!isCurrent()) return;
      run.drift = drift;
    } catch (err) { console.warn('[SciHub] 方案差异检查失败：', err); }
    if (!isCurrent()) return;

    subscribeRun(runId);          // 多端实时同步（本实验的填写内容）
    subscribePlan(mergeInfo ? null : r.plan_id); // 合并后只使用已审核并锁定的快照
    drawRun();
    // 方案里删掉的字段、而实验里已经填过值 → 弹一次提醒（点过「知道了」就不再弹）
    maybeWarnRemovedFields();
  }

  /* ── 多端实时同步：订阅这条实验的 run_steps 变化 ───────── */

  let runChannel = null;

  function subscribeRun(runId) {
    unsubscribeRun();
    try {
      runChannel = client.channel('run-steps-' + runId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'run_steps', filter: 'run_id=eq.' + runId }, (payload) => {
          if (Number(run.id) !== Number(runId)) return;
          const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
          if (!row || row.id == null) return;
          const index = run.steps.findIndex((step) => step.id === row.id);
          if (index !== -1 && saveQueue.isDirty(run.steps[index])) {
            // Preserve local input. The timestamp condition will detect conflicts.
            return;
          }
          if (payload.eventType === 'DELETE') {
            if (index !== -1) run.steps.splice(index, 1);
          } else if (index === -1) run.steps.push(row);
          else Object.assign(run.steps[index], row);
          run.steps.sort((a, b) => a.position - b.position);
          const host = $('view-run');
          if (host && !host.hidden) drawRun();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'experiment_runs', filter: 'id=eq.' + runId }, (payload) => {
          if (Number(run.id) !== Number(runId) || !payload.new || !payload.new.id) return;
          Object.assign(run.data, payload.new);
          if (!saveQueue.hasPending() && !$('view-run').hidden) drawRun();
        }).subscribe();
    } catch (err) { console.warn('[SciHub] 实时同步不可用：', err); }
  }

  function unsubscribeRun() {
    if (!runChannel) return;
    try { client.removeChannel(runChannel); } catch (_error) { /* 忽略 */ }
    runChannel = null;
  }

  /* 订阅「方案步骤」的变化：方案（别的端或本端保存）改了步骤时，
     立刻重做一次对齐检查 —— 界面上的「是否同步」提示就能实时更新。 */
  let planChannel = null;

  function subscribePlan(planId) {
    unsubscribePlan();
    if (!planId) return;
    try {
      planChannel = client
        .channel('plan-steps-' + planId)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'plan_steps', filter: 'plan_id=eq.' + planId,
        }, async () => {
          if (!run.data || run.data.plan_id !== planId) return;
          if (saveQueue.hasPending()) return;          // 本机正在输入时先不打扰
          const activeId = run.id, sequence = runRenderSequence;
          try {
            const { data: steps } = await client.from(RUN_STEP).select('*').eq('run_id', activeId).order('position');
            if (run.id !== activeId || runRenderSequence !== sequence || saveQueue.hasPending()) return;
            if (steps) run.steps = steps;
            const drift = await planDiff(run.data);
            if (run.id !== activeId || runRenderSequence !== sequence || saveQueue.hasPending()) return;
            run.drift = drift;
            drawRun();
            setStatus(
              run.drift.same ? '已与方案同步。' : '方案有改动，与本次实验不一致 —— 点上方「立即同步」即可对齐。',
              run.drift.same ? 'ok' : 'warn'
            );
          } catch (err) {
            console.warn('[SciHub] 方案变化后重新检查失败：', err);
          }
        })
        .subscribe();
    } catch (err) {
      console.warn('[SciHub] 方案订阅失败：', err);
    }
  }

  function unsubscribePlan() {
    if (!planChannel) return;
    try { client.removeChannel(planChannel); } catch (_error) { /* 忽略 */ }
    planChannel = null;
  }

  /* 这一步是否已经「有进展」：填了数据、附了照片、写了备注，或标记完成。
     用来算「实验进行位置」—— 它和「当前浏览位置」是两回事。 */
  function stepHasProgress(x) {
    if (!x) return false;
    if (x.status === 'done') return true;
    if ((x.images || []).length) return true;
    if (String(x.note || '').trim()) return true;
    const checks = x.checks || {};
    if (Object.keys(checks).some((k) => !!checks[k])) return true;   // 勾选过也算做过
    const vals = x.values || {};
    return Object.keys(vals).some((k) => { const v = vals[k]; return v !== '' && v != null; });
  }

  /* 已完成勾选：把 run_steps.checks 渲染成可勾选清单；勾选/取消直接写库，
     勾过任意一条就算这一步有进展（进度条、待办、日历会跟着动）。 */
  function drawChecks(s) {
    const host = $('checks');
    if (!host) return;
    const checks = s.checks || {};
    const keys = Object.keys(checks);
    if (!keys.length) { host.innerHTML = ''; return; }

    const done = keys.filter((k) => !!checks[k]).length;
    host.innerHTML = [
      '<div class="sub-block" style="margin-top:12px">',
      '  <div class="sub-head"><span>☑ 已完成勾选</span><span class="sub-tools">' + done + '/' + keys.length + '</span></div>',
      keys.map((k, i) => [
        '    <label class="check-row" data-check-row="' + i + '">',
        '      <input type="checkbox" data-check-toggle="' + i + '"' + (checks[k] ? ' checked' : '') + '>',
        '      <span>' + esc(k) + '</span>',
        '    </label>',
      ].join('\n')).join(''),
      '</div>',
    ].join('\n');

    host.querySelectorAll('[data-check-toggle]').forEach((cb) => cb.addEventListener('change', async () => {
      const k = keys[Number(cb.dataset.checkToggle)];
      const nextChecks = Object.assign({}, s.checks || {}, { [k]: cb.checked });
      s.checks = nextChecks;
      scheduleSave(s);
      drawChecks(s);
    }));
  }

  function drawRun() {
    const host = $('view-run');
    const stepNumber = (position) => window.Merges ? window.Merges.number(run.data, position) : position + 1;
    if (run.mergeInfo) {
      const member = run.mergeInfo.runs.find((item) => item.id === run.data.id);
      if (member) Object.assign(member, run.data);
    }

    // 关联子实验：只看合并点之前的步骤（合并点之后是和大家一起做的，不该各看各的）
    const cut = run.mergeCut;
    const total = cut == null ? run.steps.length : Math.max(1, Math.min(cut, run.steps.length));
    if (run.pos > total - 1) run.pos = total - 1;      // 浏览位置也夹进可见范围

    const s = run.steps[run.pos];
    if (!s) { host.innerHTML = '<div class="empty">没有可执行的步骤。</div>'; return; }

    const readOnly = (run.data.status !== 'running' || !!run.data._mergedInto);
    const done = run.steps.slice(0, total).filter((x) => x.status === 'done').length;

    // 实验进行位置：最后一个「有数据 / 有照片 / 有备注 / 已完成」的步骤（只在可见范围内看）。
    // 翻看后面的步骤不会推进它 —— 进度由填写的数据决定，不由浏览位置决定。
    let reached = 0;
    run.steps.slice(0, total).forEach((x, i) => { if (stepHasProgress(x)) reached = i; });

    const reachedPct = total > 1 ? Math.round((reached / (total - 1)) * 100) : 100;
    const posPct = total > 1 ? Math.round((run.pos / (total - 1)) * 100) : 100;

    const isLast = run.pos === total - 1;
    const resumed = (run.data.current_step || 0) === run.pos && run.pos > 0;
    const d = run.drift || { same: true, added: [], removed: [], changed: [], fieldAdded: [], fieldRemoved: [] };

    // 与方案的同步状态：不一致时把差异逐条列出来，配一个「立即同步」
    const diffRows = [];
    if (d.added.length) diffRows.push('方案新增 ' + d.added.length + ' 步：' + d.added.map((x) => '第 ' + (x.position + 1) + ' 步「' + esc(x.title) + '」').join('、'));
    if (d.removed.length) diffRows.push('方案已删 ' + d.removed.length + ' 步（实验里还有）：' + d.removed.map((x) => '第 ' + (x.position + 1) + ' 步「' + esc(x.title) + '」').join('、'));
    if (d.changed.length) diffRows.push('内容有改动 ' + d.changed.length + ' 步：' + d.changed.map((x) => '第 ' + (x.position + 1) + ' 步（' + esc(x.what) + '）').join('、'));
    if (d.fieldAdded.length) {
      const show = d.fieldAdded.slice(0, 6).map((x) => '第 ' + (x.position + 1) + ' 步「' + esc(x.label) + '」').join('、');
      diffRows.push('方案新增 ' + d.fieldAdded.length + ' 个数据字段：' + show + (d.fieldAdded.length > 6 ? ' 等' : ''));
    }
    if (d.fieldRemoved.length) {
      const show = d.fieldRemoved.slice(0, 6).map((x) => '第 ' + (x.position + 1) + ' 步「' + esc(x.label) + '」').join('、');
      diffRows.push('方案已删 ' + d.fieldRemoved.length + ' 个字段（已填的值仍保留）：' + show + (d.fieldRemoved.length > 6 ? ' 等' : ''));
    }

    host.innerHTML = [
      '<div class="run-head">',
      '  <div><b>' + esc(run.data.title) + '</b>',
      '    <div class="hc-meta">开始于 ' + fmt(run.data.started_at) + (run.data._mergedInto ? ' · 已合并（支路只读）' : ' · 已进行 ' + sinceText(run.data.started_at)) + (run.data.status === 'done' ? ' · 已完成（只读）' : '') + '</div>',
      '  </div>',
      '  <div class="hc-actions">',
      // 导出统一放在主页的「进行中的实验」卡片上，这里不再重复一个入口
      '    <button type="button" class="ghost" id="run-exit">返回主页</button>',
      '    <button type="button" class="ghost" id="run-export">导出 Word</button>',
      '  </div>',
      '</div>',

      window.Merges ? window.Merges.diagram(run.mergeInfo, run.id) : '',

      // 进度条：绿色实心＝实验进行到的位置（按数据算）；空心圆环＝当前正在浏览的位置
      '<div class="progress">',
      '  <i style="width:' + reachedPct + '%"></i>',
      '  <span class="prog-mark prog-reached" style="left:' + reachedPct + '%" title="已进行到第 ' + stepNumber(reached) + ' 步"></span>',
      '  <span class="prog-mark prog-pos" style="left:' + posPct + '%" title="正在浏览第 ' + stepNumber(run.pos) + ' 步"></span>',
      '</div>',

      // 步骤节点：点任意一个直接跳过去，只是浏览，不会改变实验进度
      // （关联子实验只画到合并点为止）
      '<div class="step-nav">',
      run.steps.slice(0, total).map((x, i) => {
        const cls = ['step-dot'];
        if (stepHasProgress(x)) cls.push('done');
        if (i === reached) cls.push('reached');
        if (i === run.pos) cls.push('cur');
        if (run.linkAt != null && i >= run.linkAt) cls.push('linked');   // 合并点之后：共同做的步骤，标黄
        return '<button type="button" class="' + cls.join(' ') + '" data-goto="' + i + '"'
          + ' title="第 ' + stepNumber(i) + ' 步：' + esc(x.title)
          + (run.linkAt != null && i >= run.linkAt ? '（合并后共同做）' : '') + '">' + stepNumber(i) + '</button>';
      }).join(''),
      '</div>',

      '<div class="hc-meta run-status">已进行到 <b>第 ' + stepNumber(reached) + ' 步</b> · 正在浏览 第 ' + stepNumber(run.pos) + ' 步 · 共 ' + total + ' 步 · 已完成 ' + done + ' 步'
        + (resumed ? ' · <b>上次停在这里</b>' : '')
        + (run.data.updated_at ? ' · 上次保存 ' + fmt(run.data.updated_at) : '') + '</div>',

      // 进度与「正在浏览」不一致时，给一个一键改正的入口：
      // current_step 只在点「完成并下一步」时前进，点快了就会落在没真正做的步骤上，
      // 待办跟着显示错（v5 显示到第 9 步就是这么来的）。
      run.pos !== (run.data.current_step || 0)
        ? '<div class="run-status"><button type="button" class="ghost tiny" id="set-progress"'
            + ' title="把「进行到这里」改成你现在浏览的这一步">记为我做到这里（第 ' + stepNumber(run.pos) + ' 步）</button></div>'
        : '',
      // 关联子实验：说清楚为什么只看到这里
      cut != null
        ? [
            '<div class="merge-note">',
            '  <b>⇄ 独立支路（共同阶段从第 ' + (cut + 1) + ' 步）</b>',
            '  <span>第 ' + (cut + 1) + ' 步及之后只在共同阶段记录，这条支路显示前 ' + total + ' 步；合并后的完整数据在主页那一栏查看 / 导出。</span>',
            '</div>',
          ].join('\n')
        : '',
      // 实时同步状态：一致 → 一行淡字；不一致 → 提示条 + 逐条差异 + 「立即同步」
      d.same
        ? '<div class="sync-ok">' + (run.mergeInfo ? '✓ 合并时的步骤快照已锁定' : '✓ 与方案一致') + '</div>'
        : [
            '<div class="sync-diff">',
            '  <div class="sync-body">',
            '    <b>⚠ 与方案不一致</b>',
            diffRows.map((t) => '    <span>' + t + '</span>').join('\n'),
            '    <em>点「立即同步」把方案的新增步骤 / 新字段补进本次实验，已填的数据不会动。'
              + (d.removed.length ? '「立即同步」只增改、不删步骤 —— 多余的步骤请点右边的按钮清掉。' : '')
              + '</em>',
            '  </div>',
            '  <button type="button" class="ghost" id="run-sync-now">立即同步</button>',
            // 实验里还留着「方案里已经删掉的步骤」：早期同步只增不删、或保存方案时在确认框里
            // 点了「取消」，都会留下这种残留（表现为末尾多出一步、内容和上一步一样）。
            // 这里给一个明确出口，否则它会一直挂着 —— 怎么点「立即同步」都消不掉。
            d.removed.length
              ? '  <button type="button" class="ghost" id="run-drop-extra">删掉多余的 ' + d.removed.length + ' 步</button>'
              : '',
            '</div>',
          ].join('\n'),
      '<div class="run-step-card">',
      '  <h2>第 ' + stepNumber(run.pos) + ' 步：' + esc(s.title) + '</h2>',
      s.duration_hint ? '  <span class="dur">时长提示：' + highlight(s.duration_hint) + '</span>' : '',
      // 合并点之前的步骤：可以切换查看同一步在其它关联实验里的数据
      (run.linkAt != null && run.pos < run.linkAt && run.peers.length > 1
        ? [
            '  <div class="peer-bar">',
            '    <label>🔍 查看这一步在其它实验的数据',
            '      <select id="peer-select">',
            '        <option value="">本实验（' + esc(run.data.title) + '）</option>',
            run.peers.filter((p) => p.id !== run.id).map((p) => '        <option value="' + p.id + '">' + esc(p.title) + '</option>').join('\n'),
            '      </select>',
            '    </label>',
            '    <div id="peer-view"></div>',
            '  </div>',
          ].join('\n')
        : ''),
      // 这一步是不是和其它实验一起做的？比如「v5.1 第 7 步酸洗」和 v5 一起酸洗
      '  <div class="link-row"' + (run.mergeInfo ? ' hidden' : '') + '>',
      s.link_run_id
        ? [
            '<span class="link-chip">⇄ 已关联：<b>' + esc(run.linked[s.link_run_id] || ('实验 #' + s.link_run_id)) + '</b>'
              + (s.link_note ? '<i>' + esc(s.link_note) + '</i>' : '') + '</span>',
            '<button type="button" class="ghost tiny" id="link-edit">改说明</button>',
            '<button type="button" class="ghost tiny" id="link-del">取消关联</button>',
          ].join('')
        : '<button type="button" class="ghost tiny" id="link-add">＋ 合并平行实验</button>',
      '  </div>',
      s.notice ? [
        '  <div class="notice">',
        '    <span class="notice-icon" aria-hidden="true">⚠</span>',
        '    <div class="notice-body"><b>注意事项</b>',
        // 一条一行、带圆点 —— 之前用「；」连成一整句，扫读时容易串行
        noticeLines(s).filter(Boolean).map((line) => '      <span class="notice-item">' + highlight(line) + '</span>').join('\n'),
        '    </div>',
        '  </div>',
      ].join('\n') : '',
      '  <div class="instr">' + highlight(s.instruction) + '</div>',
      pyroBlock(s),
      '  <div id="fields"></div>',
      '  <div id="checks"></div>',
      '  <div style="margin-top:14px">',
      '    <div class="hc-meta">实验照片 / 视频</div>',
      '    <div class="photos" id="photos"></div>',
      // 不加 capture：否则手机上只会直接开相机，无法从相册里选已有视频
      '    <input type="file" id="photo-input" accept="image/*,video/*" hidden>',
      '    <input type="file" id="photo-gallery" accept="image/*,video/*" multiple hidden>',
      '  </div>',
      '  <div class="run-actions">',
      '    <button type="button" class="ghost" id="run-prev" ' + (run.pos === 0 ? 'disabled' : '') + '>上一步</button>',
      '    <button type="button" class="primary" id="run-next">'
        + (isLast ? (cut != null ? '完成到合并点' : '完成实验') : '完成并下一步') + '</button>',
      '  </div>',
      '  <div class="autosave" id="autosave"></div>',
      '</div>',
    ].join('\n');

    if (window.Merges) window.Merges.bind(host);
    drawFields(s);
    drawChecks(s);
    drawPhotos(s);
    bindPyro(s);

    // 查看其它关联实验在同一步的数据（只读，只用于对照）
    function drawPeerView() {
      const host = $('peer-view');
      const sel = $('peer-select');
      if (!host || !sel) return;
      const peerId = Number(sel.value || 0);
      if (!peerId) { host.innerHTML = ''; return; }
      host.innerHTML = '<span class="hint small">加载中…</span>';
      client.from(RUN_STEP).select('*')
        .eq('run_id', peerId).eq('position', run.pos).maybeSingle()
        .then(({ data: peer }) => {
          if (!peer) { host.innerHTML = '<span class="hint small">这个实验还没有这一步的数据。</span>'; return; }
          const peerRun = (run.peers || []).find((p) => p.id === peerId);
          const f = peer.fields || [];
          const v = peer.values || {};
          const checks = peer.checks || {};
          const cKeys = Object.keys(checks);
          const cDone = cKeys.filter((k) => !!checks[k]).length;
          const rows = [];
          f.forEach((fd) => {
            rows.push('<div class="hc-meta">· ' + esc(fd.label) + '：'
              + ((v[fd.label] == null || v[fd.label] === '') ? '（未填）' : esc(String(v[fd.label])))
              + (fd.unit ? ' ' + esc(fd.unit) : '') + '</div>');
          });
          if (!f.length) rows.push('<div class="hc-meta">· 这一步没有预设字段</div>');
          if (cKeys.length) rows.push('<div class="hc-meta">☑ 已完成勾选：' + cDone + '/' + cKeys.length + '</div>');
          if (String(peer.note || '').trim()) rows.push('<div class="hc-meta">备注：' + esc(peer.note) + '</div>');
          rows.push('<div class="hc-meta">照片 ' + ((peer.images || []).length) + ' 张</div>');
          host.innerHTML = '<div class="peer-step"><b>' + esc((peerRun && peerRun.title) || ('实验 #' + peerId))
            + ' · 第 ' + stepNumber(run.pos) + ' 步 ' + esc(peer.title || '') + '</b>'
            + rows.join('') + '</div>';
        })
        .catch((err) => {
          console.warn('[SciHub] 读取关联实验这一步失败：', err);
          host.innerHTML = '<span class="hint small">读取失败：' + esc(errorText(err)) + '</span>';
        });
    }

    const peerSel = $('peer-select');
    if (peerSel) {
      peerSel.addEventListener('change', drawPeerView);
      drawPeerView();
    }

    $('run-exit').addEventListener('click', () => route('home'));
    $('run-export').addEventListener('click', () => exportRunData(run.id));
    if (readOnly) host.querySelectorAll('#fields input, #fields textarea, #checks input, #photos input, #photos .photo-drop, #photos .photo-add, #run-next, #run-sync-now, #run-drop-extra, #set-progress, #link-add, #link-edit, #link-del, #pyro-seq, #pyro-room, #pyro-rate, #pyro-final').forEach((node) => { node.disabled = true; });

    // ── 步骤关联其它实验 ────────────────────────────────
    // 场景：v5.1 的第 7 步「酸洗」是和 v5 一起做的 —— 混料后统一酸洗。
    // 关联后，主页会把这两条实验合并成一条显示。
    const curStep = () => run.steps[run.pos];

    const saveLink = async (linkRunId, note) => {
      const st = curStep();
      const { error } = await client.from(RUN_STEP)
        .update({ link_run_id: linkRunId, link_note: note })
        .eq('id', st.id);
      if (error) {
        console.error('[SciHub] 关联写入失败：', error);
        setStatus('关联失败：请确认已在 Supabase 给 run_steps 加上 link_run_id / link_note 两列。', 'error');
        return false;
      }
      st.link_run_id = linkRunId;
      st.link_note = note;
      if (linkRunId && !run.linked[linkRunId]) {
        const { data } = await client.from(RUN).select('title').eq('id', linkRunId).maybeSingle();
        run.linked[linkRunId] = (data && data.title) || ('实验 #' + linkRunId);
      }
      return true;
    };

    const linkAdd = $('link-add');
    if (linkAdd) linkAdd.addEventListener('click', () => linkRun(run.id));
    const linkEdit = $('link-edit');
    if (linkEdit) linkEdit.addEventListener('click', () => linkRun(run.id));
    const linkDel = $('link-del');
    if (linkDel) linkDel.addEventListener('click', async () => {
      if (await saveLink(null, null)) {
        setStatus('已取消关联。', 'ok');
        drawRun();
      }
    });

    // 步骤节点：点一下直接跳到那一步。只是浏览，不影响「已进行到第几步」。
    host.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.goto);
      if (i === run.pos) return;
      run.pos = i;
      drawRun();
    }));

    $('run-prev').addEventListener('click', () => { run.pos--; drawRun(); });
    $('run-next').addEventListener('click', () => (isLast && cut == null ? finishRun() : nextStep()));
    const syncBtn = $('run-sync-now');
    if (syncBtn) syncBtn.addEventListener('click', syncRunNow);
    const dropExtraBtn = $('run-drop-extra');
    if (dropExtraBtn) dropExtraBtn.addEventListener('click', dropExtraSteps);

    // 「记为我做到这里」：把云端的 current_step 改成当前浏览的这一步
    const setProgBtn = $('set-progress');
    if (setProgBtn) setProgBtn.addEventListener('click', async () => {
      setProgBtn.disabled = true;
      const { error } = await client.from(RUN)
        .update({ current_step: run.pos, updated_at: new Date().toISOString() })
        .eq('id', run.id);
      if (error) {
        setProgBtn.disabled = false;
        setStatus('设置进度失败：' + errorText(error), 'error');
        return;
      }
      run.data.current_step = run.pos;
      run.data.updated_at = new Date().toISOString();
      setStatus('已把「进行到这里」记为第 ' + stepNumber(run.pos) + ' 步。', 'ok');
      drawRun();
    });

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
        const value = (s.values || {})[f.label] ?? '';
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

        // 勾选已完成：一个勾选框，勾上存 '✓'、取消存空 —— 让「非空即已填」的判定自然成立
        if (type === 'check') {
          const on = String(value).trim() !== '';
          return [
            '<div class="data-field">',
            '  <label class="check-field">',
            '    <input type="checkbox" data-key="' + i + '"' + (on ? ' checked' : '') + '>',
            '    <span>' + esc(f.label) + (f.unit ? '<span class="unit">(' + esc(f.unit) + ')</span>' : '') + '</span>',
            '  </label>',
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
      const onVal = () => {
        const f = fields[Number(inp.dataset.key)];
        s.values = s.values || {};

        // 勾选框：勾上存 '✓'、取消存空串（空串＝没填，进度判定不会把它当成做过）
        if (inp.type === 'checkbox') {
          s.values[f.label] = inp.checked ? '✓' : '';
        } else if (inp.dataset.part) {
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
      };

      inp.addEventListener('input', onVal);
      // 勾选框在部分浏览器只稳定触发 change，两个都接上（重复保存会自动防抖）
      if (inp.type === 'checkbox') inp.addEventListener('change', onVal);
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
        '<figure class="photo" data-path="' + esc(img.path) + '" data-media="' + idx + '" draggable="' + (run.data.status === 'running' && !run.data._mergedInto) + '" title="照片 / 视频">',
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

    // 点缩略图放大（长按拖动后不触发点击）
    let suppressClick = false;
    host.querySelectorAll('[data-zoom]').forEach((b) => {
      b.addEventListener('click', () => {
        if (suppressClick) { suppressClick = false; return; }
        openLightbox(s, Number(b.dataset.zoom));
      });
    });

    if ((run.data.status !== 'running' || !!run.data._mergedInto)) {
      host.querySelectorAll('input, .photo-drop, .photo-add').forEach((node) => { node.disabled = true; });
      return;
    }

    // 拖动缩略图调整顺序；顺序会被保存，导出的 Word 文档也按这个顺序排照片。
    // 桌面走原生 HTML5 拖拽；手机触屏没有 drag 事件，用 Pointer Events 做「长按拖动」。
    let dragFrom = -1;
    let touchDrag = false;
    let pressTimer = null;

    const finishTouchDrag = () => {
      touchDrag = false;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      document.removeEventListener('pointermove', onTouchMove);
      document.removeEventListener('pointerup', onTouchUp);
      document.removeEventListener('pointercancel', onTouchUp);
      host.querySelectorAll('[data-media]').forEach((f) => f.classList.remove('dragging', 'over'));
    };

    const onTouchMove = (e) => {
      if (!touchDrag) return;
      e.preventDefault();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const fig = el && el.closest ? el.closest('[data-media]') : null;
      host.querySelectorAll('[data-media]').forEach((f) => f.classList.toggle('over', f === fig));
    };

    const onTouchUp = async (e) => {
      if (!touchDrag) return;
      e.preventDefault();
      suppressClick = true;                 // 拖动结束后的 click 是误触，不再打开大图
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const fig = el && el.closest ? el.closest('[data-media]') : null;
      const to = fig ? Number(fig.dataset.media) : -1;
      const from = dragFrom;
      finishTouchDrag();
      if (from < 0 || to < 0 || from === to) return;

      const list = (s.images || []).slice();
      const moved = list.splice(from, 1)[0];
      if (!moved) return;
      list.splice(to, 0, moved);
      s.images = list;

      await saveStep(s, true);
      drawPhotos(s);
    };

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

      // 手机：长按进入拖动（避开「删除」「注解输入框」，也不和页面滚动、点开大图冲突）
      fig.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        if (e.target.closest('.photo-drop') || e.target.closest('.photo-caption')) return;
        const idx = Number(fig.dataset.media);
        pressTimer = setTimeout(() => {
          touchDrag = true;
          dragFrom = idx;
          fig.classList.add('dragging');
          document.addEventListener('pointermove', onTouchMove, { passive: false });
          document.addEventListener('pointerup', onTouchUp);
          document.addEventListener('pointercancel', onTouchUp);
        }, 450);
      });
      fig.addEventListener('pointerup', () => {
        if (pressTimer && !touchDrag) { clearTimeout(pressTimer); pressTimer = null; }
      });
      fig.addEventListener('pointercancel', () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
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
      const previous = s.images;
      s.images = (s.images || []).filter((x) => x.path !== path);
      if (!await saveStep(s, true)) { s.images = previous; return; }
      const { error } = await client.storage.from(BUCKET).remove([path]);
      if (error) setStatus('附件引用已移除，但云端文件未删除：' + errorText(error), 'warn');
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
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
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
  async function fetchImageForDocx(path, urls = run.urls) {
    const url = urls[path];
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

      const mime = String(res.headers.get('content-type') || '').split(';')[0];
      if (/^image\/(jpeg|png)$/.test(mime)) return { data: buf, mime, w, h };
      if (!/^image\//.test(mime)) return null;
      const bitmap = await createImageBitmap(new Blob([buf], { type: mime }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
      const converted = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!converted) return null;
      return { data: await converted.arrayBuffer(), mime: 'image/png', w: canvas.width, h: canvas.height };
    } catch (err) {
      console.warn('[SciHub] 图片读取失败，导出时跳过：', path, err);
      return null;
    }
  }

  /* 收集这条实验所属的「合并组」信息：参与哪些实验、合并点在哪、各实验合并点之前的步骤。
     导出时用它把整组的记录写进同一份文档，保证导出内容和关联信息对得上。 */
  async function collectMergeInfo(runId) {
    if (!runId) return null;
    const parallel = window.Merges ? await window.Merges.context(runId) : null;
    if (parallel) {
      const { data: steps, error } = await client.from(RUN_STEP).select('*').in('run_id', parallel.runs.map((member) => member.id)).order('position');
      if (error) throw error;
      const stepsById = {};
      for (const step of steps || []) (stepsById[step.run_id] ||= []).push(step);
      return { ...parallel, parallel: true, stepsById, links: parallel.parentIds.map((id) => ({ from: id, to: parallel.resultId, position: parallel.group.after_position + 1, note: parallel.group.note })) };
    }
    const { data: linkedSteps, error: linksError } = await client.from(RUN_STEP)
      .select('run_id,position,link_run_id,link_note').not('link_run_id', 'is', null);
    if (linksError) throw linksError;
    const ids = new Set([Number(runId)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of linkedSteps || []) {
        if (!ids.has(Number(step.run_id)) && !ids.has(Number(step.link_run_id))) continue;
        for (const id of [Number(step.run_id), Number(step.link_run_id)]) if (!ids.has(id)) { ids.add(id); changed = true; }
      }
    }
    const links = (linkedSteps || []).filter((step) => ids.has(Number(step.run_id)))
      .map((step) => ({ from: step.run_id, to: step.link_run_id, position: step.position, note: step.link_note }));
    if (!links.length) return null;
    const { data: members, error: runsError } = await client.from(RUN).select('*').in('id', [...ids]);
    const { data: steps, error: stepsError } = await client.from(RUN_STEP).select('*').in('run_id', [...ids]).order('position');
    if (runsError || stepsError) throw runsError || stepsError;
    const stepsById = {};
    for (const step of steps || []) (stepsById[step.run_id] ||= []).push(step);
    return { links, runs: members || [], linkAt: Math.min(...links.map((link) => link.position)), stepsById };
  }

  /* 把一次实验的步骤、填写数据与照片导成 Word 文档。
     不传 runId 就导当前打开的那次；传了则按 id 读进来（主页的导出按钮用）。 */
  async function exportRunData(runId) {
    if (!await flushSaves()) return;
    const id = runId || run.id;
    try {
      const { data: current, error: runError } = await client.from(RUN).select('*').eq('id', id).maybeSingle();
      const { data: steps, error: stepsError } = await client.from(RUN_STEP).select('*').eq('run_id', id).order('position');
      if (runError || stepsError) throw runError || stepsError;
      if (!current || !steps || !steps.length) { setStatus('没有可导出的实验数据。', 'warn'); return; }
      const merge = await collectMergeInfo(id);
      const members = merge ? merge.runs : [current];
      const stepsById = merge ? merge.stepsById : { [id]: steps };
      const paths = [...new Set(Object.values(stepsById).flatMap((list) => list.flatMap((step) => (step.images || []).map((image) => image.path))).filter(Boolean))];
      const urls = {};
      if (paths.length) {
        const { data: signed, error } = await client.storage.from(BUCKET).createSignedUrls(paths, 3600);
        if (error) throw error;
        for (const item of signed || []) if (item.signedUrl) urls[item.path] = item.signedUrl;
      }
      setStatus('正在生成 Word 文档…');
      const paragraphs = [{ text: '实验记录' + (merge ? (merge.parallel ? '（平行实验合并）' : '（旧关联实验）') : '') + ' · ' + current.title, bold: true, size: 16, align: 'center' }];
      if (merge) {
        paragraphs.push({ text: merge.parallel ? '平行支路与共同阶段' : '旧关联信息', bold: true, size: 13 });
        for (const link of merge.links) {
          const title = (memberId) => (members.find((member) => Number(member.id) === Number(memberId)) || {}).title || ('实验 #' + memberId);
          paragraphs.push({ text: title(link.from) + ' → ' + title(link.to) + ' · 第 ' + (link.position + 1) + ' 步' + (link.note ? ' · ' + link.note : ''), size: 10 });
        }
        paragraphs.push({ text: merge.parallel ? '以下分别列出各支路合并前的数据，以及唯一的共同阶段；共同数据不会重复归到各支路。' : '以下按各实验保存的快照分别列出，保留合并前后数据与附件。', size: 10 });
      }
      let imageTotal = 0, missingImages = 0;
      for (const member of members) {
        paragraphs.push('', { text: member.title, bold: true, size: 13 });
        paragraphs.push({ text: '开始：' + fmt(member.started_at) + (member.finished_at ? ' · 结束：' + fmt(member.finished_at) : '') + ' · ' + (member._mergedInto ? '独立支路已合并（只读）' : member.status === 'done' ? '已完成' : '进行中'), size: 10 });
        const savedSteps = stepsById[member.id] || [];
        const position = member._mergedInto ? member._merge.after_position : member.status === 'done' ? Infinity : Number(member.current_step) || 0;
        for (const step of savedSteps.filter((item) => item.position <= position)) {
          paragraphs.push('', { text: '第 ' + (window.Merges ? window.Merges.number(member, step.position) : step.position + 1) + ' 步 · ' + step.title, bold: true, size: 12 });
          if (step.started_at || step.finished_at) paragraphs.push({ text: '步骤时间：' + fmt(step.started_at) + ' → ' + fmt(step.finished_at), size: 10 });
          if (step.instruction) paragraphs.push({ text: step.instruction, size: 10 });
          if (step.pyro_seq) paragraphs.push({ text: '热解程序：' + step.pyro_seq, size: 10 });
          if (step.duration_hint) paragraphs.push({ text: '时长提示：' + step.duration_hint, size: 10 });
          noticeLines(step).forEach((line) => paragraphs.push({ text: '注意：' + line, size: 10 }));
          const values = step.values || {}, labels = new Set();
          for (const field of step.fields || []) {
            labels.add(field.label);
            paragraphs.push({ text: field.label + '：' + (values[field.label] ?? '（未填）') + (field.unit ? ' ' + field.unit : ''), size: 10 });
          }
          for (const label of Object.keys(values)) if (!labels.has(label) && values[label] !== '' && values[label] != null) paragraphs.push({ text: '历史字段 ' + label + '：' + values[label], size: 10 });
          for (const [label, checked] of Object.entries(step.checks || {})) paragraphs.push({ text: label + '：' + (checked ? '已完成' : '未完成'), size: 10 });
          if (step.note) paragraphs.push({ text: '备注：' + step.note, size: 10 });
          for (const image of step.images || []) {
            if (isVideoFile(image)) { paragraphs.push({ text: '视频附件（未嵌入）：' + (image.name || image.path) + (image.caption ? ' · ' + image.caption : ''), size: 9 }); continue; }
            const binary = await fetchImageForDocx(image.path, urls);
            if (!binary) { missingImages++; paragraphs.push({ text: '图片暂无法读取：' + (image.name || image.path), size: 9 }); continue; }
            imageTotal++;
            paragraphs.push({ text: '照片 ' + imageTotal + (image.caption ? '：' + image.caption : ''), size: 9 }, { image: binary });
          }
        }
      }
      const blob = await buildDocx(paragraphs);
      const filename = String(current.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      downloadBlob(blob, '实验记录-' + filename + '-' + SciHubSafety.localDate() + '.docx');
      setStatus('已导出 ' + members.length + ' 个实验、' + imageTotal + ' 张照片。' + (missingImages ? missingImages + ' 张图片未能读取，文档已标明。' : ''), missingImages ? 'warn' : 'ok');
    } catch (err) { setStatus('导出失败：' + errorText(err), 'error'); }
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

  function autosaveStatus(step, message) {
    const node = $('autosave');
    if (node && Number(run.id) === Number(step.run_id)) node.textContent = message;
  }

  const saveQueue = SciHubSafety.createSaveQueue(writeStep, {
    onError: (error, step) => {
      autosaveStatus(step, '未保存：' + errorText(error));
      setStatus('实验数据未保存：' + errorText(error) + '。请保留页面并重试。', 'error');
    },
  });

  function scheduleSave(step) {
    if (run.data && (run.data.status !== 'running' || !!run.data._mergedInto)) return;
    autosaveStatus(step, '编辑中…');
    saveQueue.schedule(step);
  }

  async function writeStep(step) {
    const ownerId = step.user_id;
    if (!state.user || state.user.id !== ownerId) throw new Error('登录状态已改变，当前数据尚未保存');
    const { data: parent, error: parentError } = await client.from(RUN).select('status').eq('id', step.run_id).single();
    if (parentError) throw parentError;
    if (parent.status !== 'running') throw new Error('实验已完成或终止，不能继续修改');
    const payload = JSON.parse(JSON.stringify({
      values: step.values || {}, note: step.note || '', images: step.images || [],
      status: step.status, started_at: step.started_at, finished_at: step.finished_at,
      ...(step.checks ? { checks: step.checks } : {}),
    }));
    let query = client.from(RUN_STEP).update(payload).eq('id', step.id).eq('run_id', step.run_id);
    if (step.updated_at) query = query.eq('updated_at', step.updated_at);
    const { data: saved, error } = await query.select('updated_at').maybeSingle();
    if (error) throw error;
    if (!saved) throw new Error('这一步已在其他设备修改或已被移除；本页的未保存内容仍保留，请先核对');
    step.updated_at = saved.updated_at;

    // Use the step's owner/run identity, never the currently displayed run.
    const position = Number(step.position);
    if (Number.isFinite(position) && stepHasProgress(step)) {
      const { data: progressed, error: progressError } = await client.from(RUN)
        .update({ current_step: position }).eq('id', step.run_id)
        .eq('status', 'running').lt('current_step', position).select('current_step,updated_at').maybeSingle();
      if (progressError) throw progressError;
      if (progressed && Number(run.id) === Number(step.run_id)) Object.assign(run.data, progressed);
    }
    autosaveStatus(step, '已保存 · ' + fmt(now()));
  }

  async function saveStep(step) {
    try { await saveQueue.save(step); return true; }
    catch (err) {
      autosaveStatus(step, '未保存：' + errorText(err));
      setStatus('实验数据未保存：' + errorText(err) + '。请保留页面并重试。', 'error');
      return false;
    }
  }

  async function flushSaves() {
    try { await saveQueue.flushAll(); return true; }
    catch (err) { setStatus('仍有实验数据未保存：' + errorText(err) + '。请先重试保存。', 'error'); return false; }
  }

  window.addEventListener('beforeunload', (event) => {
    if (!saveQueue.hasPending() && !savingDraft) return;
    event.preventDefault(); event.returnValue = '';
  });

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
      autosaveStatus(s, '上传中… ' + (i + 1) + ' / ' + list.length);
      const result = await uploadPhoto(list[i], true, s);
      if (result === true) ok++;
      else if (typeof result === 'string') lastError = result;
    }

    autosaveStatus(s, (ok === list.length)
      ? ('已上传 ' + ok + ' 个 · ' + fmt(now()))
      : ('已上传 ' + ok + ' / ' + list.length + ' 个' + (lastError ? '：' + lastError : '')));
    // 只有还停在这一步时才重绘，否则会把用户当前看的步骤界面刷掉
    if (run.steps[run.pos] === s) drawPhotos(s);
  }

  async function uploadPhoto(file, silent, targetStep) {
    const s = targetStep || run.steps[run.pos];
    const say = (txt) => autosaveStatus(s, txt);

    if (!silent) say('上传中…');

    try {
      const payload = await compressImage(file);
      const stamp = Date.now() + '-' + Math.floor(Math.random() * 100000);
      const safe = String(payload.name || 'photo.jpg').replace(/[^\w.\-]/g, '_');
      // 第一段目录必须是当前用户 id，才符合 Storage 的「只能读写自己目录」策略
      const path = s.user_id + '/' + s.run_id + '/' + s.position + '/' + stamp + '-' + safe;

      const { error } = await client.storage.from(BUCKET).upload(path, payload, {
        upsert: false,
        contentType: payload.type || 'image/jpeg',
      });
      if (error) throw error;

      const { data: signed } = await client.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24);
      if (signed && Number(run.id) === Number(s.run_id)) run.urls[path] = signed.signedUrl;

      s.images = (s.images || []).concat([{
        path: path,
        name: file.name || 'photo',
        type: payload.type || file.type || '',   // 用来区分照片与视频
        caption: '',
        at: new Date().toISOString(),
      }]);
      if (!await saveStep(s, true)) throw new Error('文件已上传，但实验附件信息未保存；请保持页面并重试保存');
      if (!silent && Number(run.id) === Number(s.run_id)) drawPhotos(s);
      return true;
    } catch (err) {
      console.error('[SciHub] 上传失败：', err, '| 文件：', file && file.name, file && file.size);
      const msg = errorText(err);
      say('上传失败：' + msg);
      return msg;
    }
  }

  /* ── 下一步 / 完成 ────────────────────────────────────── */

  let advancingRun = false;
  async function nextStep() {
    if (advancingRun || !run.data || (run.data.status !== 'running' || !!run.data._mergedInto)) return;
    advancingRun = true;
    const button = $('run-next');
    if (button) button.disabled = true;
    try {
    const s = run.steps[run.pos];

    // 关联子实验：做到合并点就该停 —— 合并点之后是和大家一起做的
    const cut = run.mergeCut;
    const total = cut == null ? run.steps.length : Math.max(1, Math.min(cut, run.steps.length));

    if (!s.started_at) s.started_at = new Date().toISOString();
    s.status = 'done';
    s.finished_at = new Date().toISOString();
    if (!await saveStep(s, true)) return;

    // 已经到合并点：这次实验该做的部分做完了，不再往下走
    if (cut != null && run.pos >= total - 1) {
      const { error: pointerError } = await client.from(RUN).update({
        current_step: run.pos,
        updated_at: new Date().toISOString(),
      }).eq('id', run.id);
      if (pointerError) throw pointerError;
      setStatus('已做到合并点（第 ' + total + ' 步）。第 ' + (cut + 1) + ' 步及之后由合并后的实验一起做。', 'ok');
      drawRun();
      return;
    }

    run.pos = Math.min(run.pos + 1, total - 1);
    const ns = run.steps[run.pos];
    if (ns && !ns.started_at) {
      ns.started_at = new Date().toISOString();
      if (!await saveStep(ns, true)) { run.pos--; return; }
    }

    const { error: pointerError } = await client.from(RUN).update({
      current_step: run.pos,
      updated_at: new Date().toISOString(),
    }).eq('id', run.id);
    if (pointerError) throw pointerError;
    run.data.current_step = run.pos;

    drawRun();
    } catch (err) { setStatus('步骤进度未保存：' + errorText(err), 'error'); }
    finally { advancingRun = false; if (button) button.disabled = false; }
  }

  let finishingRun = false;
  async function finishRun() {
    if (finishingRun || !run.data || (run.data.status !== 'running' || !!run.data._mergedInto)) return;
    if (!window.confirm('实验完成？会生成一份实验日志并保存到科研记录。')) return;
    finishingRun = true;
    const nextButton = $('run-next');
    if (nextButton) nextButton.disabled = true;
    const current = run.data;
    try {
      const step = run.steps[run.pos];
      if (!step.started_at) step.started_at = new Date().toISOString();
      step.status = 'done'; step.finished_at = new Date().toISOString();
      if (!await saveStep(step) || !await flushSaves()) return;
      const ended = new Date().toISOString();
      const { error } = await client.rpc('research_finish_run', {
        p_id: current.id, p_content: window.Merges ? await window.Merges.completionLog(current, run.steps, ended, buildLog) : buildLog(current, run.steps, ended), p_date: SciHubSafety.localDate(),
      });
      if (error) throw error;
      current.status = 'done'; current.finished_at = ended;
      setStatus('实验已完成，日志已保存到科研记录。', 'ok');
      await loadRecords();
      if (run.data === current) drawRun();
    } catch (err) {
      setStatus('完成实验未确认：' + errorText(err) + '。请核对后重试。', 'error');
    } finally {
      finishingRun = false;
      if (nextButton) nextButton.disabled = false;
    }
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
      lines.push('【第 ' + (i + (r._mergeOffset || 0) + 1) + ' 步】' + s.title);
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
    if (window.Merges) await window.Merges.refresh();
    const { data, error } = await client.from(RUN).select('*')
      .eq('status', 'running').order('updated_at', { ascending: false });
    if (error) throw error;
    const rows = window.Merges ? window.Merges.decorate(data || []) : (data || []);
    rows.forEach((row) => { row._mergeParents = rows.filter((parent) => parent._mergedInto === row.id); });
    return rows.filter((row) => !row._mergedInto);
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
    if (window.Merges && await window.Merges.context(runId)) { setStatus('该实验属于合并链路，原始支路及共同阶段需保留，不能直接删除。', 'warn'); return; }
    if (!window.confirm('删除这次实验？它的所有填写数据与照片都会被永久删除，无法恢复。')) return;

    try {
      const { data: steps, error: readError } = await client.from(RUN_STEP).select('images').eq('run_id', runId);
      if (readError) throw readError;
      const paths = [];
      (steps || []).forEach((s) => {
        (s.images || []).forEach((img) => { if (img && img.path) paths.push(img.path); });
      });
      const { error } = await client.from(RUN).delete().eq('id', runId); // run_steps 随之级联删除
      if (error) throw error;

      let cleanupError = null;
      if (paths.length) cleanupError = (await client.storage.from(BUCKET).remove(paths)).error;
      const { error: linkError } = await client.from(RUN_STEP).update({ link_run_id: null, link_note: null }).eq('link_run_id', runId);
      setStatus(cleanupError || linkError ? '实验已删除，但部分附件或关联尚未清理，请稍后核对。' : '实验已删除。', cleanupError || linkError ? 'warn' : 'ok');
      route('home');
    } catch (err) {
      console.error('[SciHub] 删除实验失败：', err);
      setStatus('删除失败，请稍后重试。', 'error');
    }
  }

  /* ── 关联其它实验 ────────────────────────────────────────
     入口在主页「进行中的实验」卡片上（那个链接图标）。流程：
       1. 挑本实验的哪一步（下面会显示这一步的内容，方便确认）
       2. 挑对方实验 + 对方的哪一步
       3. 比较两边「从这一步往后」的步骤是否一致 —— 不一致就不让合并
     */
  async function linkRun(runId) {
    if (window.Merges) await window.Merges.open(runId);
  }

  /* 取消关联：把这一组里所有实验之间的 link 全部清掉，
     主页就从「一条合并实验」拆回多个独立实验。
     各实验的步骤、填写的数据、进度全都不动（合并点之后的步骤也保留）。 */
  async function unlinkRun(runId) {
    try {
      const info = await collectMergeInfo(runId);
      if (!info) { setStatus('这次实验没有关联别的实验。', 'warn'); return; }
      if (info.parallel) { setStatus('混合后的共同阶段不能直接拆分，原始支路记录已保留。', 'warn'); return; }

      const names = info.runs.map((x) => '· ' + x.title).join('\n');
      const ok = window.confirm(
        '要把这 ' + info.runs.length + ' 个实验的关联全部取消吗？\n\n' + names
        + '\n\n取消后它们各自回到「进行中的实验」里独立显示。\n'
        + '各实验已填的数据和进度都不会动。'
      );
      if (!ok) return;

      // 清掉组内所有 link：一条 update 覆盖所有相关的 run_steps
      const ids = info.runs.map((x) => x.id);
      const { error } = await client.from(RUN_STEP)
        .update({ link_run_id: null, link_note: null })
        .in('run_id', ids)
        .not('link_run_id', 'is', null);
      if (error) throw error;

      setStatus('已取消关联，' + info.runs.length + ' 个实验各自独立了。', 'ok');
      route('home');
    } catch (err) {
      console.error('[SciHub] 取消关联失败：', err);
      setStatus('取消关联失败：' + errorText(err), 'error');
    }
  }

  window.Run = { flush: flushSaves, hasPending: saveQueue.hasPending, busy: () => advancingRun || finishingRun || savingDraft || syncingRun || startingRun || (window.Merges && window.Merges.busy()), reset: () => { runRenderSequence++; unsubscribeRun(); unsubscribePlan(); run.id = null; run.data = null; run.steps = []; }, render: renderRun, running: runningRuns, rename: renameRun, remove: removeRun, export: exportRunData, link: linkRun, unlink: unlinkRun };

  // 通知 app.js：实验模块已就绪（两个脚本并行下载，首页靠这个信号补渲染）
  window.dispatchEvent(new CustomEvent('scihub:ready'));
})();
