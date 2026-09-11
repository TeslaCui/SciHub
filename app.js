'use strict';

/* SciHub · 科研工作台
 * 静态前端 + Supabase（认证 + Postgres/RLS）。
 *
 * publishable key 是可以公开的（它只用来标识项目）；真正的安全边界在数据库 RLS
 * ——research_records 的策略是 auth.uid() = user_id，所以任何账号都只能读写自己的行。
 * 绝不能把 service_role key 放进前端。
 */

const SUPABASE_URL = 'https://ttjnxndmjwhwpamyeuva.supabase.co';
const SUPABASE_KEY = 'sb_publishable_uVvZ4nqnVJztf-zRTwp56w_vQ659ejh';
const TABLE = 'research_records';
const PROFILE_TABLE = 'research_profiles';
const CATEGORIES = ['实验日志', '文献笔记', '表征数据', '结果分析', '待办', '其他'];
/* 本项目专用的登录态存储键：避免同一浏览器里与其它站点的登录态互相顶掉 */
const AUTH_STORAGE_KEY = 'scihub-research-auth';
/* 若注册时仍被「邮箱确认」拦住而拿不到会话，就把用户名/电话暂存，登录成功后补登记 */
const PENDING_PROFILE_KEY = 'scihub-pending-profile';

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

/* 面向用户的错误文案：不暴露后端实现细节，原始错误只进控制台 */
function friendly(error) {
  const msg = (error && (error.message || error.error_description || error.details)) || '';
  const code = (error && error.code) || '';
  console.error('[SciHub]', error);
  if (/Invalid login credentials/i.test(msg)) return '账号或密码不正确。';
  if (/Email not confirmed/i.test(msg)) return '账号尚未完成邮箱验证。';
  if (/User already registered/i.test(msg)) return '该邮箱已被注册。';
  if (/Password should be at least|password.*(short|length)/i.test(msg)) return '密码长度不符合要求。';
  if (/rate limit|too many/i.test(msg)) return '操作过于频繁，请稍后再试。';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '网络连接失败，请稍后重试。';
  if (code === '23505' || /duplicate key/i.test(msg)) return '用户名或电话已被占用。';
  if (code === '23503') return '账号状态异常，请重新登录。';
  return '操作失败，请稍后重试。';
}

function isMissingTable(error) {
  const code = (error && error.code) || '';
  const msg = (error && error.message) || '';
  return code === '42P01' || code === 'PGRST205' || /relation .* does not exist|could not find the table/i.test(msg);
}

/* ── 认证 ──────────────────────────────────────────────── */

async function initAuth() {
  if (!client) {
    setStatus('服务加载失败，请检查网络后刷新页面。', 'error');
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
  if (state.user) { updateUserChip(); loadProfile(); }
  else { state.profile = null; closeUserMenu(); closeModal(); }

  if (state.user) {
    if (changed || !state.records.length) loadRecords();
    if (changed) ensureProfile();
    if (changed) route('home');
  } else {
    state.records = [];
    state.editingId = null;
    closeForm();
    renderRecords();
  }
}

/* ── 登录 / 注册 ───────────────────────────────────────── */

async function submitAuth(event) {
  event.preventDefault();
  if (!client) return;

  const button = $('auth-submit');
  button.disabled = true;
  try {
    if (state.mode === 'register') await register();
    else await login();
  } catch (error) {
    setStatus(friendly(error), 'error');
  } finally {
    button.disabled = false;
  }
}

/* 登录：账号（邮箱 / 用户名 / 电话 任一）+ 密码 */
async function login() {
  const identifier = $('auth-identifier').value.trim();
  const password = $('auth-password').value;
  if (!identifier || !password) {
    setStatus('请填写账号和密码。', 'error');
    return;
  }

  let email = identifier;
  if (identifier.indexOf('@') === -1) {
    const { data, error } = await client.rpc('research_lookup_login_email', { p_identifier: identifier });
    if (error) throw error;
    if (!data) {
      setStatus('账号不存在，请检查后重试。', 'error');
      return;
    }
    email = data;
  }

  const { error } = await client.auth.signInWithPassword({ email: email, password: password });
  if (error) throw error;
  $('auth-password').value = '';
  $('auth-password2').value = '';
  setStatus('登录成功。', 'ok');
}

/* 注册：邮箱 + 用户名 + 电话 + 密码（二次确认） */
async function register() {
  const email = $('auth-identifier').value.trim();
  const username = $('auth-username').value.trim();
  const phone = $('auth-phone').value.trim();
  const password = $('auth-password').value;
  const password2 = $('auth-password2').value;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    setStatus('请填写正确的邮箱地址。', 'error');
    return;
  }
  if (!username) {
    setStatus('请填写用户名。', 'error');
    return;
  }
  if (!phone) {
    setStatus('请填写电话。', 'error');
    return;
  }
  if (!password) {
    setStatus('请填写密码。', 'error');
    return;
  }
  if (password !== password2) {
    setStatus('两次输入的密码不一致。', 'error');
    return;
  }

  /* 先在库里查重：用户名 / 电话冲突必须在 signUp 之前拦下，
     否则邮箱已被占用、用户却还没登录，就卡死了。 */
  const { data: conflict, error: conflictError } = await client.rpc('research_check_signup', {
    p_username: username,
    p_phone: phone,
    p_email: email,
  });
  if (conflictError) throw conflictError;
  if (conflict === 'username') { setStatus('该用户名已被占用，请换一个。', 'error'); return; }
  if (conflict === 'phone') { setStatus('该电话已被占用，请换一个。', 'error'); return; }
  if (conflict === 'email') { setStatus('该邮箱已注册，请直接登录。', 'error'); return; }

  const { data, error } = await client.auth.signUp({ email: email, password: password });
  if (error) throw error;

  if (!data.session || !data.user) {
    /* 项目仍开着邮箱确认，拿不到会话：暂存登记信息，登录成功后补写 */
    localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify({ email: email, username: username, phone: phone }));
    setStatus('账号已创建，请查收邮箱完成验证后登录。', 'warn');
    return;
  }

  const { error: profileError } = await client.from(PROFILE_TABLE).insert({
    user_id: data.user.id,
    username: username,
    phone: phone,
    email: email,
  });
  if (profileError) {
    setStatus('账号已创建，但资料保存失败：' + friendly(profileError), 'error');
    return;
  }

  $('auth-password').value = '';
  $('auth-password2').value = '';
  setStatus('注册成功，已登录。', 'ok');
}

/* 兜底：处理「注册时被邮箱确认拦下」的账号——登录成功后补登记用户名 / 电话 */
async function ensureProfile() {
  const pending = readPendingProfile();
  if (!pending) return;

  const { data, error } = await client
    .from(PROFILE_TABLE)
    .select('user_id')
    .eq('user_id', state.user.id)
    .maybeSingle();
  if (error) return;
  if (data) { localStorage.removeItem(PENDING_PROFILE_KEY); return; }

  const { error: insertError } = await client.from(PROFILE_TABLE).insert({
    user_id: state.user.id,
    username: pending.username,
    phone: pending.phone || null,
    email: pending.email,
  });
  if (insertError) return;

  localStorage.removeItem(PENDING_PROFILE_KEY);
  setStatus('资料已同步。', 'ok');
}

function readPendingProfile() {
  try {
    const raw = localStorage.getItem(PENDING_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.email !== (state.user && state.user.email)) return null;
    return parsed;
  } catch (_error) {
    return null;
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
    state.tableMissing = isMissingTable(error);
    console.error('[SciHub] 记录读取失败：', error);
    setStatus('记录暂时无法加载，请稍后重试。', 'error');
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
    state.tableMissing = isMissingTable(error);
    setStatus(friendly(error), 'error');
    renderRecords();
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
    host.innerHTML = '<div class="empty">记录暂时无法加载，请稍后重试。</div>';
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

/* 切换「登录 / 注册」：注册时才展开用户名、电话与确认密码 */
function switchAuthMode(mode) {
  state.mode = mode === 'register' ? 'register' : 'login';
  const isRegister = state.mode === 'register';

  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === state.mode);
  });

  $('auth-title').textContent = isRegister ? '注册' : '登录';
  $('auth-identifier-label').textContent = isRegister ? '邮箱' : '账号';
  $('auth-identifier').setAttribute('placeholder', isRegister ? '邮箱地址' : '邮箱 / 用户名 / 电话');
  $('auth-identifier').setAttribute('autocomplete', isRegister ? 'email' : 'username');
  $('register-extra').hidden = !isRegister;
  $('confirm-extra').hidden = !isRegister;
  $('auth-username').required = isRegister;
  $('auth-phone').required = isRegister;
  $('auth-password2').required = isRegister;
  $('auth-submit').textContent = isRegister ? '注册' : '登录';
  $('auth-password').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchAuthMode(tab.dataset.mode));
  });

  /* 密码显示 / 隐藏 */
  document.querySelectorAll('.pw-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('is-on', show);
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      btn.title = show ? '隐藏密码' : '显示密码';
    });
  });

  $('auth-form').addEventListener('submit', submitAuth);
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
switchAuthMode('login');
bindEvents();
renderRecords();
initAuth();
registerServiceWorker();

/* ── 顶栏用户菜单与弹层 ────────────────────────────────── */

function userLabel() {
  if (state.profile && state.profile.username) return state.profile.username;
  const email = (state.user && state.user.email) || '';
  return email ? email.split('@')[0] : '用户';
}

function updateUserChip() {
  const label = userLabel();
  if ($('user-avatar')) $('user-avatar').textContent = (label[0] || 'S').toUpperCase();
  if ($('user-name')) $('user-name').textContent = label;
  if ($('um-name')) $('um-name').textContent = label;
  if ($('um-sub')) $('um-sub').textContent = (state.user && state.user.email) || '';
}

function toggleUserMenu(open) {
  const menu = $('user-menu');
  if (!menu) return;
  const next = open == null ? menu.hidden : open;
  menu.hidden = !next;
  if ($('user-menu-btn')) $('user-menu-btn').setAttribute('aria-expanded', String(!!next));
}

function closeUserMenu() { toggleUserMenu(false); }

function openModal(title, bodyHtml, actions) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const bar = $('modal-actions');
  bar.innerHTML = '';
  (actions || []).forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    btn.className = a.primary ? 'primary' : 'ghost';
    btn.addEventListener('click', a.onClick);
    bar.appendChild(btn);
  });
  $('modal').hidden = false;
}

function closeModal() { $('modal').hidden = true; }

async function loadProfile() {
  if (!state.user) return;
  const { data } = await client
    .from(PROFILE_TABLE).select('username,phone,email')
    .eq('user_id', state.user.id).maybeSingle();
  state.profile = data || null;
  updateUserChip();
}

function showAccount() {
  const p = state.profile || {};
  openModal('账号信息', [
    '<div class="kv"><b>用户名</b>' + esc(p.username || '—') + '</div>',
    '<div class="kv"><b>邮箱</b>' + esc(p.email || (state.user && state.user.email) || '—') + '</div>',
    '<div class="kv"><b>电话</b>' + esc(p.phone || '—') + '</div>',
  ].join(''), [{ label: '关闭', onClick: closeModal }]);
}

function showPassword() {
  openModal('修改密码', [
    '<label>新密码<input id="new-pw" type="password" autocomplete="new-password" placeholder="输入新密码"></label>',
    '<label>确认新密码<input id="new-pw2" type="password" autocomplete="new-password" placeholder="再次输入"></label>',
  ].join(''), [
    { label: '取消', onClick: closeModal },
    {
      label: '保存',
      primary: true,
      onClick: async () => {
        const a = $('new-pw').value;
        const b = $('new-pw2').value;
        if (!a) { setStatus('请填写新密码。', 'error'); return; }
        if (a !== b) { setStatus('两次输入的密码不一致。', 'error'); return; }
        const { error } = await client.auth.updateUser({ password: a });
        if (error) { setStatus(friendly(error), 'error'); return; }
        closeModal();
        setStatus('密码已更新。', 'ok');
      },
    },
  ]);
}

if ($('user-menu-btn')) {
  $('user-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleUserMenu(); });
}

document.querySelectorAll('[data-um]').forEach((btn) => {
  btn.addEventListener('click', () => {
    closeUserMenu();
    const kind = btn.dataset.um;
    if (kind === 'account') showAccount();
    else if (kind === 'password') showPassword();
    else if (kind === 'logout') logout();
  });
});

document.addEventListener('click', (e) => {
  const menu = $('user-menu');
  if (!menu || menu.hidden) return;
  if (!e.target.closest('#user-menu') && !e.target.closest('#user-menu-btn')) closeUserMenu();
});

if ($('modal')) {
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
}

/* ── 路由与主页 ────────────────────────────────────────── */

/* ── 版本标识与更新检查 ────────────────────────────────── */

/* 每次发版时，这个常量与 version.json、sw.js 的 CACHE 名一起更新。
   它是「烧」进 JS 的，所以能代表当前浏览器实际运行的版本。 */
const APP_VERSION = '0.11.0';

async function checkVersion() {
  const label = $('app-version');
  const btn = $('update-btn');
  if (label) {
    label.textContent = 'v' + APP_VERSION;
    label.className = 'ver';
    label.title = '当前页面运行的前端版本';
  }
  if (btn) btn.hidden = true;

  try {
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const latest = String(data.version || '').trim();
    if (!latest) return;

    if (latest !== APP_VERSION) {
      if (label) {
        label.textContent = 'v' + APP_VERSION + ' → v' + latest;
        label.className = 'ver ver-outdated';
        label.title = '页面运行的是 v' + APP_VERSION + '，服务器上已是 v' + latest + '，请点击更新';
      }
      if (btn) btn.hidden = false;
    } else if (label) {
      label.title = '已是最新版本（v' + latest + '）';
    }
  } catch (_error) {
    /* 离线时静默忽略 */
  }
}

if ($('update-btn')) {
  $('update-btn').addEventListener('click', async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch (_error) { /* 清缓存失败也照样刷新 */ }
    location.reload();
  });
}

checkVersion();
setInterval(checkVersion, 5 * 60 * 1000);

const ROUTES = ['home', 'plans', 'plan', 'run', 'records'];

function fmtText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function showView(name) {
  ROUTES.forEach((r) => {
    const node = $('view-' + r);
    if (node) node.hidden = r !== name;
  });

  const navMap = { plan: 'plans', run: 'home' };
  const navTarget = navMap[name] || name;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.route === navTarget);
  });
  window.scrollTo({ top: 0 });
}

function route(name, param) {
  if (!state.user) return;
  const target = ROUTES.indexOf(name) === -1 ? 'home' : name;
  showView(target);

  if (target === 'home') renderHome();
  else if (target === 'plans' && window.Plans) window.Plans.list();
  else if (target === 'plan' && param && window.Plans) window.Plans.editor(param);
  else if (target === 'run' && param && window.Run) window.Run.render(param);
}

/* 进行中实验卡片上的「重命名 / 删除」用事件委托，避免每次重绘都要重新绑定 */
document.addEventListener('click', (e) => {
  if (!window.Run) return;

  const ren = e.target.closest('[data-run-rename]');
  if (ren) { window.Run.rename(Number(ren.dataset.runRename), ren.dataset.name); return; }

  const del = e.target.closest('[data-run-del]');
  if (del) { window.Run.remove(Number(del.dataset.runDel)); }
});

async function renderHome() {
  const host = $('view-home');
  host.innerHTML = '<div class="section-title">进行中的实验</div><div class="empty">加载中…</div>';

  // 卡片上的图标操作（行内 SVG，无外部依赖）
  const ICON_TAG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  let runs = [];
  try {
    if (window.Run) runs = await window.Run.running();
  } catch (error) {
    console.error('[SciHub] 读取进行中实验失败：', error);
  }

  const { data: plans } = await client
    .from('experiment_plans')
    .select('id,title')
    .order('created_at', { ascending: false })
    .limit(5);

  const { data: recent } = await client
    .from(TABLE)
    .select('id,title,category,occurred_on')
    .order('created_at', { ascending: false })
    .limit(3);

  host.innerHTML = [
    '<div class="section-title">进行中的实验</div>',
    runs.length
      ? runs.map((r) => [
          '<article class="home-card">',
          '  <div class="hc-main">',
          '    <div class="hc-title">' + esc(r.title) + '</div>',
          '    <div class="hc-meta">开始于 ' + fmtText(r.started_at) + ' · 第 ' + ((r.current_step || 0) + 1) + ' 步进行中</div>',
          '  </div>',
          '  <div class="hc-actions">',
          '    <button type="button" class="plan-start" data-run="' + r.id + '">继续</button>',
          '    <button type="button" class="icon-btn" data-run-rename="' + r.id + '" data-name="' + esc(r.title) + '" title="重命名" aria-label="重命名">' + ICON_TAG + '</button>',
          '    <button type="button" class="icon-btn del" data-run-del="' + r.id + '" title="删除这次实验" aria-label="删除这次实验">' + ICON_TRASH + '</button>',
          '  </div>',
          '</article>',
        ].join('\n')).join('\n')
      : '<div class="empty">当前没有进行中的实验。上轮没做完的实验会一直留在这里，点「继续」就能接着做。</div>',

    '<div class="section-title">开始新的实验</div>',
    (plans && plans.length)
      ? plans.map((p) => [
          '<article class="home-card">',
          '  <div class="hc-main">',
          '    <div class="hc-title">' + esc(p.title) + '</div>',
          '    <div class="hc-meta">按这份方案开始一次新实验</div>',
          '  </div>',
          '  <div class="hc-actions"><button type="button" class="plan-start" data-start-plan="' + p.id + '">开始实验</button></div>',
          '</article>',
        ].join('\n')).join('\n')
      : '<div class="empty">还没有实验方案。<br><button type="button" class="ghost" data-go="plans" style="margin-top:10px">去导入 Word 方案</button></div>',

    '<div class="section-title">快捷入口</div>',
    '<div class="quick-grid">',
    '  <button type="button" class="quick" data-go="plans"><b>方案管理</b><span>导入、编辑、重命名或删除实验方案</span></button>',
    '  <button type="button" class="quick" data-go="records"><b>科研记录</b><span>查看与检索已保存的记录</span></button>',
    '  <button type="button" class="quick" data-new-record><b>新建记录</b><span>随手记一条实验日志或文献笔记</span></button>',
    '</div>',

    '<div class="section-title">最近记录</div>',
    (recent && recent.length)
      ? recent.map((x) => [
          '<article class="home-card">',
          '  <div class="hc-main">',
          '    <div class="hc-title">' + esc(x.title) + '</div>',
          '    <div class="hc-meta">' + esc(x.category || '') + ' · ' + esc(x.occurred_on || '') + '</div>',
          '  </div>',
          '</article>',
        ].join('\n')).join('\n')
      : '<div class="empty">还没有记录。</div>',
  ].join('\n');

  host.querySelectorAll('[data-run]').forEach((btn) => {
    btn.addEventListener('click', () => route('run', Number(btn.dataset.run)));
  });
  host.querySelectorAll('[data-start-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.Plans) window.Plans.start(Number(btn.dataset.startPlan));
    });
  });
  host.querySelectorAll('[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => route(btn.dataset.go));
  });
  const newRec = host.querySelector('[data-new-record]');
  if (newRec) {
    newRec.addEventListener('click', () => {
      route('records');
      setTimeout(() => openForm(null), 0);
    });
  }
}

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => route(btn.dataset.route));
});
