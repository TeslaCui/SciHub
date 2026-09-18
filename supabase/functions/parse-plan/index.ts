// Supabase Edge Function：用 DeepSeek 把实验方案文本结构化成「步骤 + 数据字段」
//
// ── 为什么要有它 ────────────────────────────────────────────
// 前端是纯静态站，如果把 DeepSeek 的 API key 写进前端，任何人按 F12 就能拿到并盗用。
// 所以 key 只存在这里（Supabase 服务端 secret），浏览器只调用本函数。
//
// ── 部署（两种任选）────────────────────────────────────────
// A. 网页方式（推荐，不需要装 CLI）：
//    Supabase Dashboard → Edge Functions → Deploy a new function
//    → 名称填 parse-plan → 把本文件内容粘进编辑器 → Deploy
// B. CLI 方式：
//    supabase functions deploy parse-plan
//
// ── 配置密钥 ────────────────────────────────────────────────
// Supabase Dashboard → Project Settings → Edge Functions → Secrets
//    名称：DEEPSEEK_API_KEY
//    值  ：你在 DeepSeek 平台申请的 key
// 切勿把 key 写进本文件或提交到仓库。
//
// ── 请求 / 响应 ─────────────────────────────────────────────
// POST { "text": "方案全文" }
// 200  { "title": "...", "steps": [ { "title", "instruction", "notice", "duration_hint",
//                                     "fields": [ { "label", "unit", "type" } ] } ] }
// 4xx/5xx { "error": "...", "detail": "..." }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `你是化学/材料实验方案的结构化助手。用户会给出一份实验方案的纯文本（从 Word 文档提取，可能有编号、表格、换行混乱），请把它整理成可执行的实验步骤与需要现场记录的数据字段。

严格要求：
1. 按原文顺序拆出步骤（通常以「一、二、三…」或明显的小节标题划分）；标题保持原意并可精简到 30 字以内。
   **步骤粒度宁粗勿细**：同一道工序里连续写着的多个操作（例如「设定升温程序」「启动热解」「观察并记录」
   这类其实是一件事的多行描述）要**合并成一个步骤**，不要拆成好几个小步。
   判断标准是「操作者是否需要分开做两件不同的事」，而不是原文换了几行、或排版上分了段。
   但属于不同工序的（如「洗涤」与「干燥」、「离心」与「干燥」）必须分开 —— 不要为了少而错误合并。
2. 每个步骤给出 fields：这一步中操作者**需要现场填写/记录**的数据项。
   - label 必须能**唯一标识**该数据。若同一节里有两个不同试剂都要称量，必须分别写成「2-MIM 实际称量质量」「Fe(acac)₃ 实际称量质量」，绝不能都写成「记录实际质量」。
   - unit 只填单位本身（g、mg、mL、L、M、mol、h、min、s、rpm、℃、%）；没有单位就填空字符串。
   - 不要把「操作量」误当成「记录项」：原文写「加入 120 mL 甲醇」是操作，不算字段；原文写「记录实际质量：____ g」才算字段。
   - 若某步骤确实没有需要记录的数据（例如纯操作或汇总表），fields 就给空数组。
   - 每个字段可选给 type：普通填写给 "text"（数字给 "number"、时间给 "time"、日期给 "date"、日期+时间给 "datetime"）；
     **只需「做完打勾确认」的项（如「是否出现沉淀」「是否抽滤完成」「是否已密封」）给 "check"**，
     这类字段执行时就是一个勾选框，不需要手填文字。
3. instruction：把该步骤的操作要点整理成通顺的几条（用换行分隔），保留所有关键数值与条件。
4. notice（注意事项）：把该步骤中**最容易被忽略、做错就会导致实验失败或安全事故**的提醒单独摘出来，例如：
   - 「正常溶液应呈红色，出现沉淀即为异常」
   - 「离心前务必配平，对称放置」
   - 「不得完全密闭，需留针头排气」
   - 「加料后立即冰浴，避免升温」
   原文里带「注意 / 切记 / 务必 / 避免 / ⚠」的句子算，**原文没明说但属于该操作的常识性风险**（如配平、密闭、氧化、骤冷）也可以归纳进来。多条用「；」分隔。
   **确实没有就填空字符串**，不要为凑内容而编造。
5. duration_hint：若该步骤暗含等待时间（如「搅拌 24 h」「干燥过夜」「保温 1 h」），写成简短提示，如「约 24 小时」「需隔夜等待」；没有就填空字符串。
6. 「逐项打勾」的事项也放在 fields 里（type = "check"），不要另建清单：
   - 原文「第一次抽滤（ ），第二次抽滤（ ）」→ fields 里加两项：「第一次抽滤」(type=check)、「第二次抽滤」(type=check)
   - 原文「分别称取 A、B、C」且需要逐个确认 → 「称取 A」「称取 B」「称取 C」（都 type=check）
   - 这类条目用操作者能直接核对的动作命名，简洁（20 字以内），不要带编号/括号/单位。
7. title 字段：整个方案的名称（取文档标题，没有就用「未命名实验方案」）。
8. 只输出 JSON，不要任何解释文字或 Markdown 代码块。

输出 JSON 结构：
{"title":"方案名","steps":[{"title":"步骤标题","instruction":"操作要点","notice":"","duration_hint":"","fields":[{"label":"字段名","unit":"g","type":"number"},{"label":"第一次抽滤","unit":"","type":"check"}]}]}`;

/* 模式二：只把「时长」抽出来。保存方案时用它把「过夜」「隔天」这类自然语言
   一次性整成标准提示，写进方案的 duration_hint —— 之后待办走确定性路径。 */
const DURATION_PROMPT = [
  '你是实验步骤的时长提取助手。用户给出一组实验步骤（标题 + 操作说明），',
  '请判断每一步是否包含「需要等待 / 持续一段时间」，并把时间写成简短中文提示。',
  '',
  '规则：',
  '1. 只输出 JSON：{"durations": ["约 1 小时", "", "..."]}。数组长度必须与输入步骤数严格一致、顺序对应。',
  '2. 明确数字的，写成「约 24 小时」「约 30 分钟」（h→小时、min→分钟、d→天）。',
  '3. 自然语言写法的，换算成标准提示并保留原词：「过夜 / 隔夜 / 一晚」→「约 12 小时（过夜）」；',
  '   「隔天 / 次日」→「约 24 小时（隔天）」；「半天」→「约 12 小时（半天）」。',
  '4. 该步骤确实没有任何等待 / 持续时间（纯操作、称量、记录数据等）→ 该项填空字符串。',
  '5. 不要编造：原文没写就别猜数值。',
  '6. 只输出 JSON，不要解释，不要 Markdown 代码块。',
].join(String.fromCharCode(10));

/* 模式三：判断「现在进行到第几步」。用户给步骤清单 + 系统记录的 currentStep，
   由模型判断实际做到哪一步（比单看 current_step、或单看「填过数据」都更稳）。 */
const PROGRESS_PROMPT = [
  '你是实验进度判断助手。用户给一次实验的步骤清单（每步含：是否已标完成 done、填了几项数据 filled、',
  '照片数 photos、备注 note），以及系统记录的「上次停在这一步 currentStep」。',
  '请判断现在实际进行到第几步。',
  '',
  '判断规则：',
  '1. 从前往后看，找出「最后一个确实已经做过的步骤」。**只有 done=true（标了完成）或 filled>0（真的填了数据）才算做过**；',
  '   仅有照片（photos>0）或仅有备注（note 非空）不算 —— 那常常只是随手记一下或传了张图。',
  '2. 若这一步之后紧邻的下一步也已经有填写/照片/备注，说明已经进入下一步，以它为准。',
  '3. 只标完成、但后面还有明确在做的步骤时，以更靠后的那一步为准。',
  '4. 完全没有线索（都没有填写痕迹）时，采用 currentStep。',
  '5. 不要超过步骤总数 - 1，也不要小于 0。',
  '',
  '只输出 JSON：{"step": <0 起算的步骤序号>, "reason": "一句话依据"}。不要解释，不要 Markdown。',
].join(String.fromCharCode(10));

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: '只支持 POST' }, 405);
  }

  try {
    const body = await req.json().catch(() => null);
    // ── 模式三：{ "mode": "progress", "currentStep": 6, "steps": [{position,title,done,filled,photos,note}] } ──
    // 响应：{ "step": 6, "reason": "第 7 步已填数据，第 8 步没有任何填写痕迹" }
    if (body && body.mode === 'progress') {
      const pgKey = Deno.env.get('DEEPSEEK_API_KEY');
      if (!pgKey) return json({ error: '服务端未配置 DEEPSEEK_API_KEY' }, 500);

      const items = Array.isArray(body.steps) ? body.steps.slice(0, 200) : [];
      if (!items.length) return json({ error: '缺少 steps' }, 400);

      const NL = String.fromCharCode(10);
      const list = items
        .map((x, i) => (i + 1) + '. [' + String(x?.position ?? i) + '] ' + String(x?.title ?? '')
          + ' done=' + (x?.done ? '1' : '0') + ' filled=' + Number(x?.filled ?? 0)
          + ' photos=' + Number(x?.photos ?? 0)
          + ' note=' + (String(x?.note ?? '') ? '"' + String(x.note).slice(0, 60) + '"' : '无'))
        .join(NL);

      const userMsg = 'currentStep（0 起算）=' + Number(body.currentStep ?? 0) + NL + '步骤清单：' + NL + list;

      const up = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pgKey },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: PROGRESS_PROMPT },
            { role: 'user', content: userMsg },
          ],
        }),
      });
      if (!up.ok) {
        const detail = await up.text();
        return json({ error: 'DeepSeek 调用失败', detail: detail.slice(0, 600) }, 502);
      }
      const payload3 = await up.json();
      const content3 = payload3?.choices?.[0]?.message?.content ?? '';
      let parsed3: { step?: unknown; reason?: unknown };
      try {
        parsed3 = JSON.parse(content3);
      } catch {
        return json({ error: 'DeepSeek 返回的不是合法 JSON', detail: String(content3).slice(0, 600) }, 502);
      }
      const step3 = Number(parsed3?.step);
      if (!Number.isFinite(step3)) return json({ error: 'AI 没有给出 step' }, 502);
      return json({ step: step3, reason: String(parsed3?.reason ?? '').slice(0, 300) });
    }

    // ── 模式二：{ "mode": "duration", "steps": [{title, instruction}] } ──
    // 响应：{ "durations": ["约 12 小时（过夜）", "", ...] }
    if (body && body.mode === 'duration') {
      const durKey = Deno.env.get('DEEPSEEK_API_KEY');
      if (!durKey) return json({ error: '服务端未配置 DEEPSEEK_API_KEY' }, 500);

      const items = Array.isArray(body.steps) ? body.steps.slice(0, 60) : [];
      if (!items.length) return json({ error: '缺少 steps' }, 400);

      const list = items
        .map((x, i) => (i + 1) + '. 标题：' + String(x?.title ?? '') + ' 说明：' + String(x?.instruction ?? '').slice(0, 800))
        .join(String.fromCharCode(10));

      const up = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + durKey },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: DURATION_PROMPT },
            { role: 'user', content: list },
          ],
        }),
      });
      if (!up.ok) {
        const detail = await up.text();
        return json({ error: 'DeepSeek 调用失败', detail: detail.slice(0, 600) }, 502);
      }
      const payload2 = await up.json();
      const content2 = payload2?.choices?.[0]?.message?.content ?? '';
      let parsed2: { durations?: unknown };
      try {
        parsed2 = JSON.parse(content2);
      } catch {
        return json({ error: 'DeepSeek 返回的不是合法 JSON', detail: String(content2).slice(0, 600) }, 502);
      }
      const rows = Array.isArray(parsed2?.durations) ? parsed2.durations : [];
      return json({ durations: rows.map((x) => String(x ?? '').trim()) });
    }

    const text = body && typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) {
      return json({ error: '缺少 text' }, 400);
    }

    const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
    if (!apiKey) {
      return json({ error: '服务端未配置 DEEPSEEK_API_KEY' }, 500);
    }

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          // 控制长度，避免超出上下文与费用
          { role: 'user', content: text.slice(0, 60000) },
        ],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return json({ error: 'DeepSeek 调用失败', detail: detail.slice(0, 600) }, 502);
    }

    const payload = await upstream.json();
    const content = payload?.choices?.[0]?.message?.content ?? '';

    let plan: unknown;
    try {
      plan = JSON.parse(content);
    } catch {
      return json({ error: 'DeepSeek 返回的不是合法 JSON', detail: String(content).slice(0, 600) }, 502);
    }

    return json(plan);
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
