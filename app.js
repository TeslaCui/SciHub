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
  calOffset: 0,     // 实验日历的月份偏移：0 本月，-1 上月，+1 下月
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

  // 导出：把当前筛选出的记录存成 CSV（带 BOM，Excel 打开中文不乱码）
  if ($('export-btn')) {
    $('export-btn').addEventListener('click', () => {
      const rows = visibleRecords();
      if (!rows.length) { setStatus('当前没有可导出的记录。', 'warn'); return; }

      const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = [['标题', '类别', '日期', '标签', '内容'].map(cell).join(',')];
      rows.forEach((r) => {
        lines.push([
          r.title,
          r.category,
          r.occurred_on,
          (r.tags || []).join(' / '),
          r.content,
        ].map(cell).join(','));
      });

      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '科研记录-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      setStatus('已导出 ' + rows.length + ' 条记录。', 'ok');
    });
  }
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

/* 右上角「小工具」：目前是热解程序计算器，以后新增的也挂在这里 */
if ($('tools-btn')) {
  $('tools-btn').addEventListener('click', () => {
    closeUserMenu();
    if (window.Tools && window.Tools.openPyroCalculator) window.Tools.openPyroCalculator();
    else setStatus('小工具还没加载好，请刷新页面重试。', 'warn');
  });
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
const APP_VERSION = '0.48.0';

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

/* experiment.js 执行完会广播 scihub:ready。
   若此时正停在首页，就补渲染一次 —— 与 renderHome 里的等待互为双保险。 */
window.addEventListener('scihub:ready', () => {
  const home = $('view-home');
  if (state.user && home && !home.hidden) renderHome();
});

/* 进行中实验卡片上的「关联 / 导出 / 重命名 / 删除」用事件委托，避免每次重绘都要重新绑定 */
document.addEventListener('click', (e) => {
  if (!window.Run) return;

  const lnk = e.target.closest('[data-run-link]');
  if (lnk) {
    if (window.Run.link) window.Run.link(Number(lnk.dataset.runLink));
    return;
  }

  const exp = e.target.closest('[data-run-export]');
  if (exp) { window.Run.export(Number(exp.dataset.runExport)); return; }

  const ren = e.target.closest('[data-run-rename]');
  if (ren) { window.Run.rename(Number(ren.dataset.runRename), ren.dataset.name); return; }

  const del = e.target.closest('[data-run-del]');
  if (del) { window.Run.remove(Number(del.dataset.runDel)); }
});

async function renderHome() {
  const host = $('view-home');
  host.innerHTML = '<div class="section-title">进行中的实验</div><div class="empty">加载中…</div>';

  // app.js 与 experiment.js 是并行下载的：首次进首页时 window.Run 可能还没挂上，
  // 那样会静默拿到空列表（表现为「刷新后要切走再切回来才显示」）。这里等它就绪。
  for (let i = 0; i < 20 && !window.Run; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // 卡片上的图标操作（行内 SVG，无外部依赖）
  const ICON_TAG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  const ICON_DOC = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/></svg>';
  const ICON_LINK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l2.5-2.5a5 5 0 0 0-7-7L11 5"/><path d="M14 11a5 5 0 0 0-7 0L4.5 13.5a5 5 0 0 0 7 7L13 19"/></svg>';

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

  // ── 实验月历：把本月的实验按「开始那天」聚合，用于热力着色与悬停详情 ──
  const today = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => {
    const x = new Date(d);
    return x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate());
  };

  // 支持翻月：calOffset 为 0 表示本月，-1 上月，+1 下月
  const calOffset = Number(state.calOffset) || 0;
  const base = new Date(today.getFullYear(), today.getMonth() + calOffset, 1);
  const y0 = base.getFullYear();
  const m0 = base.getMonth();
  const monthStart = new Date(y0, m0, 1);
  const monthEnd = new Date(y0, m0 + 1, 1);

  let monthRuns = [];
  try {
    const { data } = await client
      .from('experiment_runs')
      .select('id,title,started_at,finished_at,status,current_step')
      .gte('started_at', monthStart.toISOString())
      .lt('started_at', monthEnd.toISOString())
      .order('started_at', { ascending: true });
    monthRuns = data || [];
  } catch (error) {
    console.warn('[SciHub] 实验日历数据读取失败：', error);
  }

  // 悬停要能看到具体步骤，所以把涉及到的实验的步骤一并取回来
  // （link_run_id / link_note 用于把「关联实验」合并成一条显示）
  const stepMap = {};
  if (monthRuns.length) {
    const { data: rs } = await client
      .from('run_steps')
      .select('run_id,position,title,status,duration_hint,link_run_id,link_note')
      .in('run_id', monthRuns.map((r) => r.id))
      .order('position');
    (rs || []).forEach((x) => {
      if (!stepMap[x.run_id]) stepMap[x.run_id] = [];
      stepMap[x.run_id].push(x);
    });
  }

  const byDay = {};
  monthRuns.forEach((r) => {
    const end = r.finished_at ? new Date(r.finished_at) : new Date();
    const mins = Math.max(0, Math.round((end - new Date(r.started_at)) / 60000));
    const k = dayKey(r.started_at);
    if (!byDay[k]) byDay[k] = { runs: [], minutes: 0 };
    byDay[k].runs.push(Object.assign({}, r, { minutes: mins }));
    byDay[k].minutes += mins;
  });

  // 颜色深浅：看当天总时长，并把次数也算进去（一次实验至少按 30 分钟计）
  const dayLevel = (info) => {
    if (!info) return 0;
    const score = info.minutes + info.runs.length * 30;
    if (score < 60) return 1;
    if (score < 240) return 2;
    if (score < 600) return 3;
    return 4;
  };

  const tipMap = {};   // 悬停详情（含换行/加粗，用自绘浮层而不是原生 title）
  const calCells = [];
  const firstWeekday = (new Date(y0, m0, 1).getDay() + 6) % 7;   // 周一作为一周之始
  for (let i = 0; i < firstWeekday; i++) calCells.push('<div class="cal-cell blank"></div>');

  const daysInMonth = new Date(y0, m0 + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const k = dayKey(new Date(y0, m0, d));
    const info = byDay[k];
    const lv = dayLevel(info);
    const isToday = k === dayKey(today);
    const tipId = k + '#' + d;

    if (info) {
      tipMap[tipId] = '<div class="cal-tip-head">' + k + ' · ' + info.runs.length + ' 次 · ' + Math.round(info.minutes) + ' 分钟</div>'
        + info.runs.map((r) => {
          const all = stepMap[r.id] || [];
          const steps = all.slice(0, 8)
            .map((x) => '<div class="cal-tip-step">' + (x.position + 1) + '. ' + esc(x.title || '')
              + (x.status === 'done' ? '<i>✓</i>' : '') + '</div>')
            .join('');
          return '<div class="cal-tip-run"><b>' + esc(r.title) + '</b>'
            + '<em>' + (r.finished_at ? '已完成' : '进行中') + ' · ' + Math.round(r.minutes) + ' 分钟</em>'
            + (steps ? '<div class="cal-tip-steps">' + steps + (all.length > 8 ? '<div class="cal-tip-step">…</div>' : '') + '</div>' : '')
            + '</div>';
        }).join('');
    } else {
      tipMap[tipId] = '<div class="cal-tip-head">' + k + '</div><div class="cal-tip-none">这天没有实验</div>';
    }

    calCells.push('<div class="cal-cell lv' + lv + (isToday ? ' today' : '')
      + '" data-tip-id="' + tipId + '"' + (info ? ' title="' + esc(k + '：' + info.runs.length + ' 次实验') + '"' : '')
      + '><span>' + d + '</span></div>');
  }

  const calendar = [
    '<div class="card cal-card">',
    '  <div class="cal-top">',
    '    <div class="cal-title">',
    '      <button type="button" class="cal-nav" data-cal="prev" title="上一月" aria-label="上一月">‹</button>',
    '      <span>' + y0 + ' 年 ' + (m0 + 1) + ' 月 · 实验日历</span>',
    '      <button type="button" class="cal-nav" data-cal="next" title="下一月" aria-label="下一月">›</button>',
    calOffset === 0 ? '' : '      <button type="button" class="ghost tiny" data-cal="today">回到本月</button>',
    '    </div>',
    '    <div class="cal-legend">少<i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i>多</div>',
    '  </div>',
    '  <div class="cal-grid cal-week">' + ['一', '二', '三', '四', '五', '六', '日'].map((w) => '<span>' + w + '</span>').join('') + '</div>',
    '  <div class="cal-grid">' + calCells.join('') + '</div>',
    '</div>',
  ].join('\n');

  // ── 待办 / 计时提醒 ──
  // 进行中的实验，按「当前步骤的时长提示」推算该在什么时间结束。
  // 比如步骤写着「反应 24 小时」，就从开始时间往后 24 小时提醒。
  const parseDurationHours = (text) => {
    const t = String(text || '');
    const h = t.match(/(\d+(?:\.\d+)?)\s*(?:小时|hours?|h(?![a-z]))/i);
    if (h) return Number(h[1]);
    const d = t.match(/(\d+(?:\.\d+)?)\s*(?:天|days?)/i);
    if (d) return Number(d[1]) * 24;
    const m = t.match(/(\d+(?:\.\d+)?)\s*(?:分钟|min(?:ute)?s?)/i);
    if (m) return Number(m[1]) / 60;
    return 0;
  };

  // 进行中的实验可能不是本月开始的，所以这里再补查一次它们的步骤
  const needSteps = (runs || []).map((r) => r.id).filter((id) => !stepMap[id]);
  if (needSteps.length) {
    const { data: more } = await client
      .from('run_steps')
      .select('run_id,position,title,status,duration_hint,link_run_id,link_note')
      .in('run_id', needSteps)
      .order('position');
    (more || []).forEach((x) => {
      if (!stepMap[x.run_id]) stepMap[x.run_id] = [];
      stepMap[x.run_id].push(x);
    });
  }

  // ── 把有关联的实验合并成一组 ──────────────────────────
  // 某实验的某个步骤 link_run_id 指向另一个实验时（如 v5.1 第 7 步酸洗 → v5），
  // 这两个实验算一组：主页只显示一条「关联实验」，同一件事不重复出现。
  const groups = [];
  const groupOf = {};   // runId -> 组下标

  (runs || []).forEach((r) => {
    if (groupOf[r.id] != null) return;
    const gi = groups.length;
    groups.push({ runs: [r], links: [] });
    groupOf[r.id] = gi;

    // 顺着 link_run_id 把能连上的实验都并进来
    const queue = [r.id];
    while (queue.length) {
      const id = queue.shift();
      (stepMap[id] || []).forEach((s) => {
        if (!s.link_run_id || groupOf[s.link_run_id] != null) return;
        const other = (runs || []).find((x) => x.id === s.link_run_id);
        if (!other) return;
        groupOf[other.id] = gi;
        groups[gi].runs.push(other);
        groups[gi].links.push({ from: id, to: other.id, note: s.link_note, position: s.position });
        queue.push(other.id);
      });
    }
  });

  // 待办（自动）：所有「进行中」的实验都会进来，每个实验一条。
  // 取哪一步：当前步骤优先；若当前步骤没写时长，就往后找第一个
  // 「写了时长且还没完成」的步骤 —— 因为「反应 24 小时」这类等待常常写在后面的步骤里
  // （例：现在第 2 步，流程要求从开始算 24h 后必须结束）。
  const todos = [];
  groups.forEach((g) => {
    // 一组只出一条待办，用组里第一个实验代表整组
    const r = g.runs[0];
    const steps = stepMap[r.id] || [];
    const curPos = r.current_step || 0;

    const pendingTimed = steps.filter((x) => x.position >= curPos
      && x.status !== 'done'
      && parseDurationHours(x.duration_hint) > 0);

    const cur = steps.find((x) => x.position === curPos) || pendingTimed[0] || steps[0];
    const hours = parseDurationHours(cur && cur.duration_hint);
    todos.push({
      kind: 'run',
      run: r,
      group: g,
      step: cur,
      hours: hours,
      due: hours > 0 ? new Date(new Date(r.started_at).getTime() + hours * 3600 * 1000) : null,
    });
  });

  // 手动待办（存在 research_todos 里）：与实验无关的事，比如「明天 10:00 取样品」
  let myTodos = [];
  if (client) {
    const { data: manual, error: manualErr } = await client
      .from('research_todos')
      .select('*')
      .eq('done', false)
      .order('created_at', { ascending: false });
    if (manualErr) console.warn('[SciHub] 待办读取失败（表可能还没建）：', manualErr);
    else myTodos = manual || [];
  }
  myTodos.forEach((t) => {
    todos.push({
      kind: 'todo',
      id: t.id,
      title: t.title,
      due: t.due_at ? new Date(t.due_at) : null,
    });
  });

  // 有结束时间的排前面（超时的最前），没设时长的排最后
  todos.sort((a, b) => {
    if (a.due && b.due) return a.due - b.due;
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });

  const hhmm = (d) => p2(d.getHours()) + ':' + p2(d.getMinutes());
  const todoCard = [
    '<div class="card todo-card">',
    '  <div class="todo-title">待办 · 计时提醒</div>',
    todos.length
      ? todos.map((t) => {
          const isRun = t.kind === 'run';
          const multi = isRun && t.group && t.group.runs.length > 1;
          // 关联实验合并成一条：标题用「A ⇄ B」
          const title = isRun
            ? (multi ? t.group.runs.map((x) => x.title).join(' ⇄ ') : t.run.title)
            : t.title;
          const sub = isRun
            ? '第 ' + (((t.step && t.step.position) != null ? t.step.position : 0) + 1) + ' 步'
              + (t.step && t.step.title ? ' · ' + esc(t.step.title) : '')
              + (t.step && t.step.duration_hint ? ' · ' + esc(t.step.duration_hint) : '')
            : (t.due ? '手动待办' : '手动待办 · 未设时间');

          const hasDue = !!t.due;
          const leftMin = hasDue ? Math.round((t.due - Date.now()) / 60000) : 0;
          const overdue = hasDue && leftMin < 0;
          const absMin = Math.abs(leftMin);

          let whenTxt;
          if (!hasDue) {
            whenTxt = isRun ? '进行中 · 这一步未设时长提示' : '随时';
          } else {
            const sameDay = t.due.toDateString() === today.toDateString();
            whenTxt = (sameDay ? '今天 ' : fmtText(t.due.toISOString()) + ' ') + hhmm(t.due) + ' · '
              + (overdue
                ? '已超时 ' + (absMin >= 60 ? Math.round(absMin / 60) + ' 小时' : absMin + ' 分钟')
                : '还需 ' + (absMin >= 60 ? Math.round(absMin / 60) + ' 小时' : absMin + ' 分钟'));
          }

          return '<div class="todo-item' + (overdue ? ' overdue' : '') + '">'
            + '<div class="todo-main">'
            + '<b>' + esc(title) + '</b>'
            + '<span>' + sub + '</span>'
            + (multi && t.group.links.length
              ? '<span class="link-summary">⇄ ' + t.group.links.map((l) => {
                  const a = (t.group.runs.find((x) => x.id === l.from) || {}).title || '';
                  const b = (t.group.runs.find((x) => x.id === l.to) || {}).title || '';
                  return '第 ' + (l.position + 1) + ' 步「' + esc(a) + ' → ' + esc(b) + '」'
                    + (l.note ? '：' + esc(l.note) : '');
                }).join('；') + '</span>'
              : '')
            + '<em>' + whenTxt + '</em>'
            + '</div>'
            // 自动项（来自进行中的实验）不能在这里删 —— 它跟着实验走；
            // 手动项才有删除按钮。
            + (isRun
              ? '<button type="button" class="ghost tiny" data-run="' + t.run.id + '">去处理</button>'
              : '<button type="button" class="icon-btn del" data-todo-del="' + t.id + '" title="删除这条待办" aria-label="删除">×</button>')
            + '</div>';
        }).join('')
      : '<div class="todo-empty">当前没有待办。<br><span>开始实验后，当前步骤会自动出现在这里；也可以点下方「＋」自己加一条。</span></div>',
    '  <button type="button" class="todo-add-btn" id="todo-add-btn" title="添加一条待办">＋ 添加待办</button>',
    '</div>',
  ].join('\n');

  // 圆环进度（与设计稿一致）：底环 + 亮色弧段，100 周长便于直接写 dasharray
  const progRing = (pct) => '<svg class="prog-ring" viewBox="0 0 36 36" aria-hidden="true">'
    + '<circle class="ring-bg" cx="18" cy="18" r="15.9155"/>'
    + '<circle class="ring-fg" cx="18" cy="18" r="15.9155" stroke-dasharray="' + Math.max(0, Math.min(100, pct)) + ', 100"/>'
    + '</svg>';

  host.innerHTML = [
    '<div class="home-top">' + calendar + todoCard + '</div>',
    '<div class="section-title">进行中的实验</div>',
    groups.length
      ? groups.map((g) => {
          const r = g.runs[0];
          const multi = g.runs.length > 1;

          // 合并点 = 组里最早提出关联的那一步（如 v5.1 第 7 步酸洗 → 合并点是第 7 步）
          const linkAt = g.links.length ? Math.min.apply(null, g.links.map((l) => l.position)) : null;

          // 每个子实验的进度：只看合并点之前的部分，做到哪里、是否已到合并点
          const subRows = g.runs.map((x) => {
            const st = stepMap[x.id] || [];
            const cut = linkAt == null ? st.length - 1 : linkAt - 1;
            let reached = 0;
            st.forEach((s, i) => {
              if (i > cut) return;
              const hasData = Object.keys(s.values || {}).some((k) => String((s.values || {})[k] || '').trim());
              if (s.status === 'done' || (s.images || []).length || String(s.note || '').trim() || hasData) reached = i;
            });
            const total = linkAt == null ? Math.max(1, st.length) : linkAt;   // 合并点之前的步数
            return {
              run: x,
              reached: reached,
              total: total,
              pct: Math.round(((reached + 1) / total) * 100),
              doneAll: linkAt != null && reached >= linkAt - 1,                // 已做到合并点
            };
          });
          const notReady = subRows.filter((x) => !x.doneAll).length;

          return [
            '<article class="home-card' + (multi ? ' linked' : '') + '">',
            '  <div class="hc-main">',
            '    <div class="hc-title">' + (multi
              ? g.runs.map((x) => esc(x.title)).join(' ⇄ ') + ' <span class="link-tag">关联实验</span>'
              : esc(r.title)) + '</div>',
            '    <div class="hc-meta">开始于 ' + fmtText(r.started_at) + ' · 第 ' + ((r.current_step || 0) + 1) + ' 步进行中'
              + (multi ? ' · 共 ' + g.runs.length + ' 个实验一起做' : '') + '</div>',

            // 合并后只保留这一栏；子实验收在下拉里，提示直接挂在下拉标题上
            multi ? [
              '    <details class="sub-runs"' + (notReady ? ' open' : '') + '>',
              '      <summary>',
              '        <span class="sub-toggle">展开 ' + g.runs.length + ' 个关联子实验</span>',
              notReady
                ? '<span class="sub-warn">⚠ ' + notReady + ' 个还没做到第 ' + ((linkAt || 0) + 1) + ' 步</span>'
                : '<span class="sub-ok">✓ 全部已到合并步骤</span>',
              '      </summary>',
              '      <div class="sub-list">',
              subRows.map((x) => [
                '        <div class="sub-row' + (x.doneAll ? ' done' : '') + '">',
                '          ' + progRing(x.pct),
                '          <div class="sub-info">',
                '            <b>' + esc(x.run.title) + '</b>',
                '            <span>已到 第 ' + (x.reached + 1) + ' 步 · 共 ' + x.total + ' 步'
                  + (linkAt != null ? '（合并点：第 ' + (linkAt + 1) + ' 步）' : '') + '</span>',
                '          </div>',
                x.doneAll
                  ? '          <span class="sub-done">✓ 已完成</span>'
                  : '          <span class="sub-pending">未到合并步</span>',
                '          <button type="button" class="ghost tiny" data-run="' + x.run.id + '">'
                  + (x.doneAll ? '查看' : '继续') + '</button>',
                '        </div>',
              ].join('\n')).join(''),
              '      </div>',
              '    </details>',
              g.links.length ? '    <div class="link-summary">⇄ ' + g.links.map((l) => {
                  const a = (g.runs.find((y) => y.id === l.from) || {}).title || '';
                  const b = (g.runs.find((y) => y.id === l.to) || {}).title || '';
                  return '第 ' + (l.position + 1) + ' 步「' + esc(a) + ' → ' + esc(b) + '」'
                    + (l.note ? '：' + esc(l.note) : '');
                }).join('；') + '</div>' : '',
            ].join('\n') : '',

            '  </div>',
            '  <div class="hc-actions">',
            '    <button type="button" class="plan-start" data-run="' + r.id + '">继续</button>',
            // 关联入口就在卡片上：选本实验的哪一步 + 对方实验的哪一步，再校验后续步骤是否一致
            '    <button type="button" class="icon-btn" data-run-link="' + r.id + '" title="关联其它实验" aria-label="关联其它实验">' + ICON_LINK + '</button>',
            '    <button type="button" class="icon-btn" data-run-export="' + r.id + '" title="导出为 Word 文档" aria-label="导出">' + ICON_DOC + '</button>',
            '    <button type="button" class="icon-btn" data-run-rename="' + r.id + '" data-name="' + esc(r.title) + '" title="重命名" aria-label="重命名">' + ICON_TAG + '</button>',
            '    <button type="button" class="icon-btn del" data-run-del="' + r.id + '" title="删除这次实验" aria-label="删除这次实验">' + ICON_TRASH + '</button>',
            '  </div>',
            '</article>',
          ].join('\n');
        }).join('\n')
      : '<div class="empty">当前没有进行中的实验。上轮没做完的实验会一直留在这里，点「继续」就能接着做。</div>',

    '<div class="section-title">开始新的实验</div>',
    (plans && plans.length)
      ? plans.map((p) => [
          '<article class="home-card clickable" data-open-plan="' + p.id + '" role="button" tabindex="0" title="查看方案详情">',
          '  <div class="hc-main">',
          '    <div class="hc-title">' + esc(p.title) + '</div>',
          '    <div class="hc-meta">查看方案详情与操作</div>',
          '  </div>',
          '</article>',
        ].join('\n')).join('\n')
      : '<div class="empty">还没有实验方案。<br><button type="button" class="ghost" data-go="plans" style="margin-top:10px">去导入 Word 方案</button></div>',

    '<div class="section-title">快捷入口</div>',
    '<div class="quick-grid">',
    '  <button type="button" class="quick" data-go="plans"><b>方案管理</b><span>导入、查看详情、编辑或删除实验方案</span></button>',
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

  // 方案卡片：整卡点开详情（操作按钮统一放在详情页，这里不再重复）
  host.querySelectorAll('[data-open-plan]').forEach((el) => {
    const open = () => { if (window.Plans) window.Plans.editor(Number(el.dataset.openPlan)); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  // 实验日历：桌面悬停、手机点按都能看当天详情 —— 触摸设备不会触发 mouseenter，
  // 所以两种事件都绑上。浮层用自绘 HTML（原生 title 撑不下多行步骤）。
  const hideTip = () => {
    const tip = $('cal-tip');
    if (tip) { tip.hidden = true; tip.removeAttribute('data-for'); }
  };

  const showTip = (cell) => {
    const html = tipMap[cell.dataset.tipId];
    if (!html) return;

    let tip = $('cal-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'cal-tip';
      tip.className = 'cal-tip';
      document.body.appendChild(tip);
    }
    tip.innerHTML = html;
    tip.hidden = false;
    tip.dataset.for = cell.dataset.tipId;

    const rect = cell.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    tip.style.width = w + 'px';
    tip.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, rect.left + rect.width / 2 - w / 2)) + 'px';
    tip.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  };

  host.querySelectorAll('[data-tip-id]').forEach((cell) => {
    cell.addEventListener('mouseenter', () => showTip(cell));
    cell.addEventListener('mouseleave', hideTip);

    // 手机：点一下弹出，再点同一格收起
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const tip = $('cal-tip');
      if (tip && !tip.hidden && tip.dataset.for === cell.dataset.tipId) { hideTip(); return; }
      showTip(cell);
    });
  });

  // 点别处收起浮层
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-tip-id]') && !e.target.closest('#cal-tip')) hideTip();
  });

  // 待办：点「＋ 添加待办」弹窗填写（删除见下；来自进行中实验的自动项不在这里删）
  const addTodoBtn = $('todo-add-btn');
  if (addTodoBtn) {
    addTodoBtn.addEventListener('click', () => {
      openModal('添加待办', [
        '<label>内容<input id="todo-title" maxlength="120" placeholder="如：明天 10:00 取样品"></label>',
        '<label>截止时间（可留空）<input id="todo-due" type="datetime-local"></label>',
        '<p class="hint small">留空就是一条没有截止时间的待办。</p>',
      ].join(''), [
        { label: '取消', onClick: closeModal },
        {
          label: '添加',
          primary: true,
          onClick: async () => {
            const titleEl = $('todo-title');
            const title = (titleEl.value || '').trim();
            if (!title) { titleEl.focus(); return; }

            const dueEl = $('todo-due');
            const { error } = await client.from('research_todos').insert({
              user_id: state.user.id,
              title: title,
              due_at: dueEl.value ? new Date(dueEl.value).toISOString() : null,
            });

            if (error) {
              console.error('[SciHub] 添加待办失败：', error);
              setStatus('添加待办失败：请确认已在 Supabase 建好 research_todos 表。', 'error');
              return;
            }
            closeModal();
            setStatus('已添加待办。', 'ok');
            renderHome();
          },
        },
      ]);

      // 弹窗一出来就聚焦，回车即可提交
      setTimeout(() => {
        const t = $('todo-title');
        if (!t) return;
        t.focus();
        t.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          const ok = document.querySelector('.modal-card .actions .primary');
          if (ok) ok.click();
        });
      }, 30);
    });
  }

  host.querySelectorAll('[data-todo-del]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const { error } = await client.from('research_todos').delete().eq('id', Number(btn.dataset.todoDel));
    if (error) {
      console.error('[SciHub] 删除待办失败：', error);
      setStatus('删除待办失败。', 'error');
      return;
    }
    renderHome();
  }));

  // 翻月：上月 / 下月 / 回到本月
  host.querySelectorAll('[data-cal]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = btn.dataset.cal;
    const cur = Number(state.calOffset) || 0;
    if (act === 'prev') state.calOffset = cur - 1;
    else if (act === 'next') state.calOffset = cur + 1;
    else state.calOffset = 0;
    hideTip();
    renderHome();
  }));

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
