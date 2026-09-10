'use strict';

/* SciHub · 科研工作台
 * 静态前端 + Supabase（认证 + Postgres/RLS）。
 *
 * publishable key 是可以公开的（它只用来标识项目）；真正的安全边界在数据库 RLS
 * ——research_records 的策略是 auth.uid() = user_id，所以任何账号都只能读写自己的行。
 * 绝不能把 service_role key 放进前端。
 */

const SUPABASE_URL = 'https://wcnmufiabeftlsregamh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FHlEZrROrCVM1WLdoij5Cw_7Ue64M1X';
const TABLE = 'research_records';
const CATEGORIES = ['实验日志', '文献笔记', '表征数据', '结果分析', '待办', '其他'];
/* 与其它站点（如拾光题库的 shiguang-quiz-auth）分开，避免同一浏览器里互相顶掉登录态 */
const AUTH_STORAGE_KEY = 'scihub-research-auth';

const client = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: AUTH_STORAGE_KEY,
      },
    })
  : null;

const state = {
  user: null,
  mode: 'login',
  records: [],
  q: '',
  category: '',
  editingId: null,
  tableMissing: false,
};

const $ = (id) => document.getElementById(id);

/* ── 状态提示 ──────────────────────────────────────────── */

let statusTimer = null;

function setStatus(message, kind) {
  const box = $('status');
  if (statusTimer) clearTimeout(statusTimer);
  if (!message) {
    box.hidden = true;
    return;
  }
  box.textContent = message;
  box.className = 'status ' + (kind || '');
  box.hidden = false;
  if (kind === 'ok') statusTimer = setTimeout(() => { box.hidden = true; }, 3500);
}

function friendly(error) {
  const msg = (error && (error.message || error.error_description || error.details)) || '';
  if (/Invalid login credentials/i.test(msg)) return '邮箱或密码不正确。';
  if (/Email not confirmed/i.test(msg)) return '邮箱尚未确认：请到邮箱点击确认链接（或在 Supabase 关闭 Confirm email）。';
  if (/User already registered/i.test(msg)) return '该邮箱已注册，请直接登录。';
  if (/Password should be at least/i.test(msg)) return '密码太短：至少 6 位。';
  if (/rate limit|too many/i.test(msg)) return '请求过于频繁，请稍后再试。';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '网络请求失败：请检查网络，或确认 Supabase 项目可访问。';
  return msg || '操作失败，请重试。';
}

function isMissingTable(error) {
  const code = (error && error.code) || '';
  const msg = (error && error.message) || '';
  return code === '42P01' || code === 'PGRST205' || /relation .* does not exist|could not find the table/i.test(msg);
}

/* ── 认证 ──────────────────────────────────────────────── */

async function initAuth() {
  if (!client) {
    setStatus('Supabase SDK 未加载：请检查网络能否访问 cdn.jsdelivr.net。', 'error');
    $('auth-submit').disabled = true;
    return;
  }
  const { data } = await client.auth.getSession();
  applyUser((data.session && data.session.user) || null);
  client.auth.onAuthStateChange((_event, session) => {
    applyUser((session && session.user) || null);
  });
}

function applyUser(user) {
  const changed = (state.user && state.user.id) !== (user && user.id);
  state.user = user || null;

  $('auth-view').hidden = !!state.user;
  $('app-view').hidden = !state.user;
  $('user-box').hidden = !state.user;
  if (state.user) $('user-email').textContent = state.user.email || '(已登录)';

  if (state.user) {
    if (changed || !state.records.length) loadRecords();
  } else {
    state.records = [];
    state.editingId = null;
    closeForm();
    renderRecords();
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  if (!email || password.length < 6) {
    setStatus('请填写邮箱，并设置至少 6 位密码。', 'error');
    return;
  }

  const button = $('auth-submit');
  button.disabled = true;
  try {
    if (state.mode === 'login') {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      setStatus('登录成功。', 'ok');
    } else {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) {
        setStatus('注册成功，已登录。', 'ok');
      } else {
        setStatus('注册成功：请先到邮箱点击确认链接，再回来登录。', 'ok');
      }
    }
    $('auth-password').value = '';
  } catch (error) {
    setStatus(friendly(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  if (!client) return;
  await client.auth.signOut();
  setStatus('已退出登录。', 'ok');
}

/* ── 数据读写 ──────────────────────────────────────────── */

async function loadRecords() {
  if (!client || !state.user) return;
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .order('occurred_on', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    state.records = [];
    if (isMissingTable(error)) {
      state.tableMissing = true;
      setStatus('数据表 research_records 还不存在：请在 Supabase SQL Editor 执行仓库根目录的 supabase_schema.sql，然后点右上角「刷新」。', 'warn');
    } else {
      state.tableMissing = false;
      setStatus(friendly(error), 'error');
    }
    renderRecords();
    return;
  }

  state.tableMissing = false;
  state.records = data || [];
  renderRecords();
}

async function submitRecord(event) {
  event.preventDefault();
  if (!client || !state.user) return;

  const title = $('f-title').value.trim();
  if (!title) {
    setStatus('标题不能为空。', 'error');
    return;
  }

  const payload = {
    title: title,
    category: $('f-category').value || CATEGORIES[0],
    occurred_on: $('f-date').value || today(),
    tags: $('f-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
    content: $('f-content').value,
  };

  try {
    if (state.editingId === null) {
      payload.user_id = state.user.id;
      const { error } = await client.from(TABLE).insert(payload);
      if (error) throw error;
      setStatus('记录已创建。', 'ok');
    } else {
      const { error } = await client.from(TABLE).update(payload).eq('id', state.editingId);
      if (error) throw error;
      setStatus('记录已更新。', 'ok');
    }
    closeForm();
    await loadRecords();
  } catch (error) {
    if (isMissingTable(error)) {
      state.tableMissing = true;
      setStatus('数据表不存在：请先执行 supabase_schema.sql。', 'warn');
    } else {
      setStatus(friendly(error), 'error');
    }
  }
}

async function removeRecord(id) {
  if (!client || !state.user) return;
  if (!window.confirm('确认删除这条记录？删除后无法恢复。')) return;
  const { error } = await client.from(TABLE).delete().eq('id', id);
  if (error) {
    setStatus(friendly(error), 'error');
    return;
  }
  if (state.editingId === id) closeForm();
  setStatus('记录已删除。', 'ok');
  await loadRecords();
}

/* ── 表单开关 ──────────────────────────────────────────── */

function openForm(record) {
  state.editingId = record ? record.id : null;
  $('form-title').textContent = record ? '编辑科研记录' : '新建科研记录';
  $('f-title').value = record ? record.title : '';
  $('f-category').value = (record && record.category) || CATEGORIES[0];
  $('f-date').value = (record && record.occurred_on) || today();
  $('f-tags').value = record && record.tags ? record.tags.join(', ') : '';
  $('f-content').value = record ? record.content : '';
  $('record-form').hidden = false;
  $('f-title').focus();
}

function closeForm() {
  state.editingId = null;
  $('record-form').hidden = true;
  $('record-form').reset();
}

/* ── 渲染 ──────────────────────────────────────────────── */

function visibleRecords() {
  const q = state.q.trim().toLowerCase();
  return state.records.filter((r) => {
    if (state.category && r.category !== state.category) return false;
    if (!q) return true;
    const haystack = [r.title, r.content, (r.tags || []).join(' ')].join(' ').toLowerCase();
    return haystack.indexOf(q) !== -1;
  });
}

function renderRecords() {
  const host = $('records');
  const list = visibleRecords();
  $('list-count').textContent = String(list.length);

  if (state.tableMissing) {
    host.innerHTML = '<div class="empty">数据表尚未创建。执行 <b>supabase_schema.sql</b> 后即可开始记录。</div>';
    return;
  }
  if (!list.length) {
    host.innerHTML = state.records.length
      ? '<div class="empty">没有匹配的记录。</div>'
      : '<div class="empty">还没有记录，点右上「＋ 新建记录」开始。</div>';
    return;
  }

  host.innerHTML = list.map(cardHtml).join('');
  host.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const record = state.records.find((r) => String(r.id) === btn.dataset.edit);
      if (record) { openForm(record); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
  });
  host.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => removeRecord(Number(btn.dataset.del)));
  });
}

function cardHtml(record) {
  const tags = (record.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
  const body = record.content ? '<p class="record-body">' + esc(record.content) + '</p>' : '';
  return [
    '<article class="record">',
    '  <div class="record-head">',
    '    <span class="record-title">' + esc(record.title) + '</span>',
    '    <span class="badge">' + esc(record.category || '未分类') + '</span>',
    '    <span class="record-date">' + esc(record.occurred_on || '') + '</span>',
    '  </div>',
    body,
    tags ? '  <div class="tags">' + tags + '</div>' : '',
    '  <div class="record-actions">',
    '    <button type="button" class="ghost" data-edit="' + esc(String(record.id)) + '">编辑</button>',
    '    <button type="button" class="ghost del" data-del="' + esc(String(record.id)) + '">删除</button>',
    '  </div>',
    '</article>',
  ].join('\n');
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/* ── 启动 ──────────────────────────────────────────────── */

function fillCategorySelects() {
  const options = CATEGORIES.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
  $('f-category').innerHTML = options;
  $('category-filter').innerHTML = '<option value="">全部类别</option>' + options;
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.mode = tab.dataset.mode;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('auth-submit').textContent = state.mode === 'login' ? '登录' : '注册';
      $('auth-password').setAttribute('autocomplete', state.mode === 'login' ? 'current-password' : 'new-password');
    });
  });

  $('auth-form').addEventListener('submit', submitAuth);
  $('logout-btn').addEventListener('click', logout);
  $('refresh-btn').addEventListener('click', () => { setStatus('正在刷新…'); loadRecords(); });
  $('new-btn').addEventListener('click', () => openForm(null));
  $('cancel-btn').addEventListener('click', closeForm);
  $('record-form').addEventListener('submit', submitRecord);
  $('search').addEventListener('input', (e) => { state.q = e.target.value; renderRecords(); });
  $('category-filter').addEventListener('change', (e) => { state.category = e.target.value; renderRecords(); });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* PWA 只是增强，失败不影响使用 */ });
}

fillCategorySelects();
bindEvents();
renderRecords();
initAuth();
registerServiceWorker();
