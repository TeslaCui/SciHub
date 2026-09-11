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
//                                     "fields": [ { "label", "unit" } ] } ] }
// 4xx/5xx { "error": "...", "detail": "..." }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `你是化学/材料实验方案的结构化助手。用户会给出一份实验方案的纯文本（从 Word 文档提取，可能有编号、表格、换行混乱），请把它整理成可执行的实验步骤与需要现场记录的数据字段。

严格要求：
1. 按原文顺序拆出步骤（通常以「一、二、三…」或明显的小节标题划分）；标题保持原意并可精简到 30 字以内。
2. 每个步骤给出 fields：这一步中操作者**需要现场填写/记录**的数据项。
   - label 必须能**唯一标识**该数据。若同一节里有两个不同试剂都要称量，必须分别写成「2-MIM 实际称量质量」「Fe(acac)₃ 实际称量质量」，绝不能都写成「记录实际质量」。
   - unit 只填单位本身（g、mg、mL、L、M、mol、h、min、s、rpm、℃、%）；没有单位就填空字符串。
   - 不要把「操作量」误当成「记录项」：原文写「加入 120 mL 甲醇」是操作，不算字段；原文写「记录实际质量：____ g」才算字段。
   - 若某步骤确实没有需要记录的数据（例如纯操作或汇总表），fields 就给空数组。
3. instruction：把该步骤的操作要点整理成通顺的几条（用换行分隔），保留所有关键数值与条件。
4. notice（注意事项）：把该步骤中**最容易被忽略、做错就会导致实验失败或安全事故**的提醒单独摘出来，例如：
   - 「正常溶液应呈红色，出现沉淀即为异常」
   - 「离心前务必配平，对称放置」
   - 「不得完全密闭，需留针头排气」
   - 「加料后立即冰浴，避免升温」
   原文里带「注意 / 切记 / 务必 / 避免 / ⚠」的句子算，**原文没明说但属于该操作的常识性风险**（如配平、密闭、氧化、骤冷）也可以归纳进来。多条用「；」分隔。
   **确实没有就填空字符串**，不要为凑内容而编造。
5. duration_hint：若该步骤暗含等待时间（如「搅拌 24 h」「干燥过夜」「保温 1 h」），写成简短提示，如「约 24 小时」「需隔夜等待」；没有就填空字符串。
6. title 字段：整个方案的名称（取文档标题，没有就用「未命名实验方案」）。
7. 只输出 JSON，不要任何解释文字或 Markdown 代码块。

输出 JSON 结构：
{"title":"方案名","steps":[{"title":"步骤标题","instruction":"操作要点","notice":"","duration_hint":"","fields":[{"label":"字段名","unit":"g"}]}]}`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: '只支持 POST' }, 405);
  }

  try {
    const body = await req.json().catch(() => null);
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
