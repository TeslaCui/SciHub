// Supabase Edge Function：AI「检测最新实验步骤 + 制订待办」
//
// ── 为什么单独做一个函数 ─────────────────────────────────────
// 待办的规则（现在做到哪一步、要不要等多久、文案怎么写）会经常调整。
// 放在服务端，改提示词就能生效，不必动前端、也不必重新发布前端。
// 前端只负责把事实发给它、把结果展示出来 —— 并在调用失败时用本地规则兜底。
//
// ── 部署 ─────────────────────────────────────────────────────
// Supabase Dashboard → Edge Functions → Deploy a new function
//   → 名称填 todo-plan → 粘贴本文件 → Deploy
// 密钥沿用已有的 DEEPSEEK_API_KEY（Project Settings → Edge Functions → Secrets）。
//
// ── 请求 ─────────────────────────────────────────────────────
// POST {
//   "now": "2026-09-13T21:30:00.000Z",          // 服务端时间（仅作参考）
//   "runs": [{
//     "id": 12, "title": "FeNC v5 …", "startedAt": "...", "currentStep": 6,
//     "steps": [{ "position": 0, "title": "称量", "done": true, "filled": 2,
//                 "planDuration": "约 2 小时",      // 该步的时长提示（前端已做三级兜底）
//                 "stepStartedAt": "...", "stepUpdatedAt": "..." }]
//   }]
// }
//
// ── 响应 ─────────────────────────────────────────────────────
// 200 { "todos": [{ "runId": 12, "step": 6, "kind": "doing" | "wait",
//                   "label": "第 7 步 · 热解", "dueInHours": 24, "reason": "…" }] }
// 4xx/5xx { "error": "...", "detail": "..." }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const NL = String.fromCharCode(10);

const SYSTEM_PROMPT = [
  '你是实验进度与待办助手。用户给若干「进行中的实验」，每个实验有**完整**步骤清单：',
  'position（0 起算的顺序）、title（步骤标题）、instruction（这一步的操作说明全文）、',
  'notice（这一步的注意事项）、planDuration（这一步的时长提示，可能为空）、',
  'filled（这一步填了几个数据项）、filledKeys（填的是哪些项的名字）、',
  'stepStartedAt / stepUpdatedAt（这一步开始/最近改动的时刻，可能为空），',
  '以及系统记录的 currentStep（上次停在的步骤）。',
  '',
  '请**通读整条流程**（说明 + 注意事项）后再判断：理解每个实验在做什么、哪些步骤是动作、',
  '哪些是等待（如「搅拌 24 h」「60 ℃ 真空干燥不少于 12 h」），这样才判断得准现在做到哪儿、',
  '接下来该做什么。',
  '',
  '请为每个实验输出一条待办，规则：',
  '',
  '一、判断「现在进行到第几步」（输出 step，0 起算）：',
  '  1. 只有 done=true 或 filled>0 才算「已经做过」；',
  '  2. 从前往后找出最后一个做过的步骤，作为「进行到的步骤」；',
  '  3. 一个都没有做过的 → 用 currentStep；',
  '  4. step 不得小于 0、不得大于步骤总数 - 1。',
  '',
  '二、制订待办（输出 kind / label / dueInHours）—— 先区分两种情形：',
  '',
  '  【情形一】已经离开那一步、往后走了：currentStep 大于「最后一个填过数据的步骤」的 position，',
  '   说明用户点过「完成并下一步」、那一步已做完。此时**报下一步该做的动作**：',
  '   kind="wait"，label 用「等待下一步：<第一个还没做的步骤的标题>」；',
  '   若那个下一步写了 planDuration，dueInHours 取它的小时数，否则 0。',
  '   （例：第 7 步热解已做完 → 显示「等待下一步：1 M HNO3 预酸洗」。）',
  '',
  '  【情形二】正停在那一步（currentStep 等于该步 position）：**报这一步本身**。',
  '   若它写了 planDuration → kind="doing"，label 用「第 N 步 · 标题 · 时长」，',
  '   dueInHours 取该时长的小时数（「约 24 小时」→24；「约 30 分钟」→0.5；「约 7 天」→168；',
  '   「约 12 小时（过夜）」→12）。它若没有 planDuration，就报它的下一步（同情形一的写法）。',
  '   （例：正在第 3 步反应 24 h → 显示「第 3 步 · 快速加入与室温反应 · 约 24 小时」+ 24。）',
  '',
  '  不要编造时间：planDuration 为空、步骤说明里也没有明确时长时，dueInHours 一律给 0。',
  '  1. 如果「进行到的那一步」本身写了时长（planDuration 非空）→',
  '     kind="doing"，label 用「第 N 步 · 标题 · 时长」，dueInHours 取该时长的**小时数**',
  '     （「约 24 小时」→24；「约 30 分钟」→0.5；「约 7 天」→168；「约 12 小时（过夜）」→12；',
  '      无法确定数值时给 0）。',
  '  2. 否则看它的下一步（第一个还没做的步骤）：',
  '     kind="wait"，label 用「等待下一步：<下一步标题>」；若那个下一步也有时长，dueInHours 取它的小时数，',
  '     否则 dueInHours=0。',
  '  3. 如果没有下一步（已经是最后一步）→ kind="wait"，label 用「等待下一步：<当前步骤标题>」，dueInHours 取该步时长或 0。',
  '  4. 不要编造时间：planDuration 为空、且步骤说明里也没有明确时长时，dueInHours 一律给 0。',
  '',
  '三、reason：用一句话说明判断依据。**描述步骤时一律用界面上的步号（position + 1，即 1 起算）**，',
     '   不要用 position 本身（否则界面显示第 9 步、你却写「第 8 步」，看着自相矛盾）。',
  '',
  '只输出 JSON，结构必须是：',
  '{"todos":[{"runId":<数字>,"step":<0起算的步骤序号>,"kind":"doing"或"wait",',
  ' "label":"<一句话待办文案>","dueInHours":<数字，可为 0>,"reason":"<一句依据>"}]}',
  '不要解释文字，不要 Markdown 代码块。',
].join(NL);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: '只支持 POST' }, 405);
  }

  try {
    const body = await req.json().catch(() => null);
    const runs = body && Array.isArray(body.runs) ? body.runs.slice(0, 20) : [];
    if (!runs.length) return json({ error: '缺少 runs' }, 400);

    const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
    if (!apiKey) return json({ error: '服务端未配置 DEEPSEEK_API_KEY' }, 500);

    // 压缩成紧凑文本，控制 token
    const lines: string[] = [];
    runs.forEach((r) => {
      const steps = Array.isArray(r?.steps) ? r.steps.slice(0, 200) : [];
      lines.push('实验 runId=' + String(r?.id ?? '') + ' 标题=' + String(r?.title ?? '')
        + ' currentStep=' + Number(r?.currentStep ?? 0) + ' 开始于=' + String(r?.startedAt ?? ''));
      steps.forEach((s) => {
        const keys = Array.isArray(s?.filledKeys) ? s.filledKeys.join('、') : '';
        lines.push('  [' + String(s?.position ?? '') + '] ' + String(s?.title ?? ''));
        lines.push('      说明：' + (String(s?.instruction ?? '') || '（无）'));
        if (String(s?.notice ?? '')) lines.push('      注意：' + String(s.notice));
        lines.push('      已填：' + (keys !== '' ? keys : '（无）')
          + ' | 时长提示：' + (String(s?.planDuration ?? '') || '（无）')
          + ' | 开始=' + (String(s?.stepStartedAt ?? '') || '-')
          + ' | 改动=' + (String(s?.stepUpdatedAt ?? '') || '-'));
      });
    });
    const userMsg = 'now=' + String(body?.now ?? '') + NL + lines.join(NL);

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg.slice(0, 60000) },
        ],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return json({ error: 'DeepSeek 调用失败', detail: detail.slice(0, 600) }, 502);
    }

    const payload = await upstream.json();
    const content = payload?.choices?.[0]?.message?.content ?? '';

    let parsed: { todos?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return json({ error: 'DeepSeek 返回的不是合法 JSON', detail: String(content).slice(0, 600) }, 502);
    }

    const rows = Array.isArray(parsed?.todos) ? parsed.todos : [];
    const todos = rows.slice(0, 20).map((x) => ({
      runId: Number((x as { runId?: unknown })?.runId),
      step: Number((x as { step?: unknown })?.step),
      kind: String((x as { kind?: unknown })?.kind ?? '') === 'doing' ? 'doing' : 'wait',
      label: String((x as { label?: unknown })?.label ?? '').slice(0, 120),
      dueInHours: Number((x as { dueInHours?: unknown })?.dueInHours ?? 0),
      reason: String((x as { reason?: unknown })?.reason ?? '').slice(0, 300),
    })).filter((t) => Number.isFinite(t.runId));

    return json({ todos: todos });
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
