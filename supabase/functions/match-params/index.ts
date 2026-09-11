// Supabase Edge Function：用 DeepSeek 判断「旧字段」与「新字段」里哪些是同一个参数
//
// ── 为什么需要它 ────────────────────────────────────────────
// 实验方案用旧版规则解析过；后来解析能力升级、字段命名也可能变了。
// 「重新解析」后要把已填数据迁移到新字段上 —— 纯字符串匹配能覆盖大部分，
// 但像「2-MIM 记录实际质量」vs「2-MIM 实际称量质量」这种表述差异，
// 交给模型判断语义是否相同更可靠。判断不出来的就不配，宁可保守。
//
// ── 部署（两种任选）────────────────────────────────────────
// A. 网页方式（推荐）：Supabase Dashboard → Edge Functions → Deploy a new function
//    → 名称填 match-params → 粘贴本文件 → Deploy
// B. CLI：supabase functions deploy match-params
//
// 复用同一个 secret：DEEPSEEK_API_KEY（Project Settings → Edge Functions → Secrets）
//
// ── 请求 / 响应 ─────────────────────────────────────────────
// POST { "old": ["旧字段A", "旧字段B"], "new": ["新字段A", "新字段B"] }
// 200  { "pairs": [ { "from": "旧字段A", "to": "新字段A" } ] }
// 4xx/5xx { "error": "...", "detail": "..." }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `你是实验数据字段的匹配助手。用户给出两组字段名（都是某一步骤里需要记录的参数）：
- old：方案旧版本里的字段名
- new：方案新版本里的字段名

任务：找出 old 中每一项对应 new 中的哪一项 —— 判断标准是「说的是不是同一个实验参数」。

严格要求：
1. 只在**确实是同一个参数**时才配对；拿不准就不要配（漏配比错配安全得多，错配会让数据填到错误的格子）。
2. 每个 old 最多配一个 new，每个 new 最多配一个 old，不允许一对多。
3. **试剂名必须一致**：字段里常带试剂（如「2-MIM」「Fe(acac)₃」「Zn 溶液」）。两个字段的试剂不同就是不同参数，绝不能配。
4. **量纲/物理量必须一致**：质量≠体积≠温度≠时间≠转速。单位不同（g 与 mL）不能配。
5. 以下差异**不影响**配对：「记录 / 实际 / 称量 / 称取 / 读取 / 填写 / 测得 / 数值 / 数据」这类修饰词，以及空格、括号、标点。
6. 只输出 JSON，不要任何解释文字或 Markdown 代码块。

输出 JSON 结构：
{"pairs":[{"from":"old 里的原字段名","to":"new 里的原字段名"}]}
没有可配对的就输出 {"pairs":[]}。`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: '只支持 POST' }, 405);
  }

  try {
    const body = await req.json().catch(() => null);
    const oldList = Array.isArray(body?.old) ? body.old.map((x: unknown) => String(x ?? '')).filter(Boolean) : [];
    const newList = Array.isArray(body?.new) ? body.new.map((x: unknown) => String(x ?? '')).filter(Boolean) : [];
    if (!oldList.length || !newList.length) {
      return json({ error: '缺少 old 或 new' }, 400);
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
          {
            role: 'user',
            content: 'old：' + JSON.stringify(oldList.slice(0, 200))
              + '\n\nnew：' + JSON.stringify(newList.slice(0, 200)),
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return json({ error: 'DeepSeek 调用失败', detail: detail.slice(0, 600) }, 502);
    }

    const payload = await upstream.json();
    const content = payload?.choices?.[0]?.message?.content ?? '';

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return json({ error: 'DeepSeek 返回的不是合法 JSON', detail: String(content).slice(0, 600) }, 502);
    }

    // 只回传双方都确实存在的字段名，避免模型臆造出列表里没有的值
    const oldSet = new Set(oldList);
    const newSet = new Set(newList);
    const rawPairs = (parsed as { pairs?: unknown })?.pairs;
    const pairs = (Array.isArray(rawPairs) ? rawPairs : [])
      .map((p) => ({ from: String((p as { from?: unknown })?.from ?? ''), to: String((p as { to?: unknown })?.to ?? '') }))
      .filter((p) => oldSet.has(p.from) && newSet.has(p.to));

    return json({ pairs });
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
