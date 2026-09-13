// Supabase Edge Function：用 DeepSeek 判断「两个实验从某一步往后」的后续步骤是否一致
//
// ── 为什么需要它 ────────────────────────────────────────────
// 把两个实验合并成一个（关联实验）的前提是：从合并点往后，两边要做的事得是同一套。
// 纯字符串比对能挡住明显不同的步骤，但「水热反应」vs「溶剂热反应」这类同义表述
// 会被误判成不同；反过来「离心 5min」vs「离心 10min」这种关键差异又容易被放过。
// 交给模型判断语义更可靠；拿不准时按「不一致」处理（宁可拦住让人确认，
// 也不要把两件不同的事错并成一件）。
//
// ── 部署（两种任选）────────────────────────────────────────
// A. 网页方式（推荐）：Supabase Dashboard → Edge Functions → Deploy a new function
//    → 名称填 check-link → 粘贴本文件 → Deploy
// B. CLI：supabase functions deploy check-link
//
// 复用同一个 secret：DEEPSEEK_API_KEY（Project Settings → Edge Functions → Secrets）
//
// ── 请求 / 响应 ─────────────────────────────────────────────
// POST { "mine": [{"title":"..."}], "other": [{"title":"..."}] }
//      mine / other 分别是两边「从合并点往后」的步骤，按顺序排列
// 200  { "same": true,  "reason": "…" }
// 200  { "same": false, "at": 2, "mine": "…", "other": "…", "reason": "…" }
// 4xx/5xx { "error": "...", "detail": "..." }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SYSTEM_PROMPT = `你是实验流程的比对助手。用户给出两个实验「从合并点往后」的后续步骤：
- mine：本实验的后续步骤（按顺序）
- other：要关联的另一个实验的后续步骤（按顺序）

任务：判断这两串步骤描述的是不是**同一套后续操作** —— 因为要把两个实验合并成一个来做。

判断标准：
1. 只要顺序和内容对得上就算一致。纯措辞差异（「水热反应」vs「溶剂热反应」、「离心分离」vs「离心」、
   「干燥」vs「烘干」）不算不同。
2. 下列差异**算不同**，必须拦住：
   - 步骤条数不同；
   - 任一步骤的**关键条件**不同：温度、时间、浓度、转速、pH、试剂、用量、气氛（N₂ / Ar / 空气）等；
   - 某一步只在一边有，或顺序错位。
3. 拿不准就判**不一致**（宁可拦住让人确认，也不要把两件不同的事错并成一件）。
4. reason 用一句中文说清楚：一致就简述理由；不一致就指出第一处不同在第几步、两边分别是什么。
5. 只输出 JSON，不要任何解释文字或 Markdown 代码块。

输出 JSON 结构：
{"same": true, "reason": "…"}
{"same": false, "at": 2, "mine": "本实验第 3 步的标题", "other": "对方第 3 步的标题", "reason": "…"}
（at 是「第几处不同」，从 0 开始算；一致时省略）`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return json('ok', 200, true);
  }
  if (req.method !== 'POST') {
    return json({ error: '只支持 POST' }, 405);
  }

  try {
    const body = await req.json().catch(() => null);
    const pick = (v: unknown): string[] =>
      (Array.isArray(v) ? v : [])
        .map((x) => {
          if (typeof x === 'string') return x;
          const t = (x as { title?: unknown })?.title;
          return t == null ? '' : String(t);
        })
        .map((s) => s.trim())
        .filter(Boolean);

    const mine = pick(body?.mine);
    const other = pick(body?.other);

    // 两边都没东西时没有可比性，直接按「不一致」处理，别浪费一次模型调用
    if (!mine.length || !other.length) {
      return json({ same: false, reason: '一边没有后续步骤，无法比较。' });
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
            content: 'mine：' + JSON.stringify(mine.slice(0, 60))
              + '\n\nother：' + JSON.stringify(other.slice(0, 60)),
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

    let parsed: { same?: unknown; reason?: unknown; at?: unknown; mine?: unknown; other?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return json({ error: 'DeepSeek 返回的不是合法 JSON', detail: String(content).slice(0, 600) }, 502);
    }

    const same = parsed?.same === true;
    const reason = parsed?.reason == null ? '' : String(parsed.reason);

    if (same) return json({ same: true, reason });

    const at = Number.isInteger(parsed?.at) ? Number(parsed.at) : null;
    return json({
      same: false,
      at,
      mine: parsed?.mine == null ? '' : String(parsed.mine),
      other: parsed?.other == null ? '' : String(parsed.other),
      reason,
    });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});

function json(body: unknown, status = 200, plain = false): Response {
  return new Response(plain ? String(body) : JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': plain ? 'text/plain' : 'application/json' },
  });
}
