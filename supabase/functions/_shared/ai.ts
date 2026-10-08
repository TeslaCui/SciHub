/* Shared boundary for every AI proxy. Gateway JWT validation alone also accepts
 * project/anonymous tokens; an authenticated user is required before spending. */
export async function authorizeAI(req: Request): Promise<Response | null> {
  const authorization = req.headers.get('authorization') || '';
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return new Response(JSON.stringify({ error: '请先登录' }), { status: 401, headers });
  }
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key) return new Response(JSON.stringify({ error: '认证服务未配置' }), { status: 503, headers });
  try {
    const response = await fetch(url + '/auth/v1/user', {
      headers: { Authorization: authorization, apikey: key }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return new Response(JSON.stringify({ error: '登录已失效，请重新登录' }), { status: 401, headers });
    const user = await response.json();
    if (!user?.id || user.is_anonymous === true) return new Response(JSON.stringify({ error: '请使用已注册账号登录' }), { status: 401, headers });
    return null;
  } catch {
    return new Response(JSON.stringify({ error: '认证服务暂时不可用' }), { status: 503, headers });
  }
}

export async function readAIRequest(req: Request): Promise<Record<string, unknown> | null> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) { await reader.cancel(); throw new Error('请求内容过大，请缩短方案'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

export function fetchAI(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(45000) });
}
