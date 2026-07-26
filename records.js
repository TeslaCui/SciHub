/* records.js — SciHub 文件后端集成层
 *
 * 负责：从本地服务读取/写入项目、实验日志、对话记录（全部保存为 .md），
 * 维护每个项目的 AGENTS.md，并提供基于项目记忆的 AI 对话与整理。
 * 与 app.js（知识卡片 / 概览，仍用 localStorage）协作，共享侧栏与视觉风格。
 */
(() => {
  'use strict';

  const API_SETTINGS_KEY = 'scihub-api-settings-v1';
  const TODAY = new Date().toISOString().slice(0, 10);

  const esc = (v = '') => (window.SciHubApp ? window.SciHubApp.escapeHtml(v)
    : String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[c])));
  const toast = (m, err) => { if (window.SciHubApp) window.SciHubApp.toast(m); else console.log(m); };
  const iso = () => new Date().toISOString();
  const $ = id => document.getElementById(id);

  const R = {
    projects: [],
    active: null,        // 当前项目 summary
    tab: 'logs',
    date: TODAY,
    log: { source: '', phenomena: '', record: '' },
    logs: [],
    conversations: [],
    conversation: null,
    agents: '',
    saveTimer: null,
    sessionKey: ''       // 未持久化时本会话内的 API Key
  };

  // ------------------------------------------------------------------ API --
  async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `请求失败 (${res.status})`);
    return data;
  }
  const slugPath = slug => `/api/projects/${encodeURIComponent(slug)}`;

  // API 设置（含 Key）存 localStorage；仅在用户点击发送时才随请求发出。
  function readSettings() { try { return JSON.parse(localStorage.getItem(API_SETTINGS_KEY)) || {}; } catch { return {}; } }
  function saveSettings(s) { localStorage.setItem(API_SETTINGS_KEY, JSON.stringify(s)); }

  async function askModel(messages) {
    const stored = readSettings();
    const key = stored.key || R.sessionKey;
    if (!stored.endpoint || !stored.model || !key) throw new Error('请先在「AI 设置」中填写接口地址、模型与 API Key。');
    const response = await api('/api/proxy', {
      method: 'POST',
      body: JSON.stringify({ url: stored.endpoint, headers: { Authorization: `Bearer ${key}` }, body: { model: stored.model, temperature: 0.2, messages } })
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('接口没有返回可用内容，请检查模型与接口格式。');
    return content;
  }

  // ------------------------------------------------------------- 项目加载 --
  async function refreshProjects(keepSlug = true) {
    const keep = keepSlug ? R.active?.slug : null;
    try {
      const data = await api('/api/projects');
      R.projects = data.projects || [];
      if (keep) R.active = R.projects.find(p => p.slug === keep) || R.active;
      renderProjectSidebar();
      return true;
    } catch (e) {
      R.projects = [];
      renderProjectSidebar();
      // 服务未启动时给出温和提示（只提示一次）
      if (!refreshProjects._warned) { refreshProjects._warned = true; showServerHint(); }
      return false;
    }
  }

  function showServerHint() {
    const host = $('logsBody') || $('recordsBody');
    // 概览页也提示
    const hint = '未连接本地文件服务。请通过「启动 SciHub.cmd」以 Python 启动，再刷新页面。';
    toast(hint);
  }

  async function loadProject(slug) {
    R.active = R.projects.find(p => p.slug === slug) || null;
    R.date = TODAY;
    R.log = { source: '', phenomena: '', record: '' };
    R.conversation = null;
    if (!R.active) return;
    try {
      const [logs, conversations] = await Promise.all([
        api(`${slugPath(slug)}/logs`),
        api(`${slugPath(slug)}/conversations`)
      ]);
      R.logs = logs.logs || [];
      R.conversations = conversations.conversations || [];
      await loadAgents();
    } catch (e) { toast(`打开项目失败：${e.message}`); }
  }

  async function loadAgents() {
    if (!R.active) return;
    try { R.agents = (await api(`${slugPath(R.active.slug)}/agents`)).content || ''; }
    catch { R.agents = ''; }
  }

  function selectProject(slug) {
    loadProject(slug).then(() => {
      renderProjectSidebar();
      if (window.SciHubApp) window.SciHubApp.renderAll();
      const v = ['logs', 'records', 'memory'].includes(currentView()) ? currentView() : 'logs';
      window.switchView(v);
      renderActiveView();
    });
  }

  function currentView() {
    const active = document.querySelector('.view.active-view');
    return active ? active.id.replace('View', '') : 'dashboard';
  }

  // ------------------------------------------------------------- 侧栏渲染 --
  function renderProjectSidebar() {
    const list = $('projectList');
    if (!list) return;
    if (!R.projects.length) {
      list.innerHTML = '<div style="padding:8px;color:#89958e;font-size:11px;line-height:1.6">还没有项目。<br>点击右上角 + 新建，文件会保存到 科研项目/ 文件夹。</div>';
      return;
    }
    list.innerHTML = R.projects.map(p => `
      <button class="project-item ${R.active && p.slug === R.active.slug ? 'selected' : ''}" data-project-select="${esc(p.slug)}" title="${esc(p.description || '')}">
        <span class="project-color" style="background:#5d8a75"></span>
        <span>${esc(p.name)}</span>
        <b>${p.logCount}·${p.conversationCount}</b>
      </button>`).join('');
  }

  function requireProject(titleEl, bodyEl) {
    if (R.active) return true;
    $(titleEl).textContent = '选择一个研究项目';
    $(bodyEl).innerHTML = '<div class="empty-state"><span>◫</span><strong>还没有选择项目</strong>在左侧选择或新建一个研究项目后，这里会显示对应的文件记录。</div>';
    return false;
  }

  // ---------------------------------------------------------- 视图：日志 --
  function renderLogsView() {
    if (!requireProject('logsProjectTitle', 'logsBody')) return;
    $('logsProjectTitle').textContent = R.active.name;
    const l = R.log;
    const textDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${R.date}T12:00:00`));
    $('logsBody').innerHTML = `
      <div class="record-panel">
        <div class="record-meta-row">
          <label class="record-field"><span>实验日期</span><input id="logDate" type="date" value="${R.date}" /></label>
          <p class="record-note">${textDate}<br>保存后写入 <b>实验日志/${R.date}.md</b>，并更新 AGENTS.md。</p>
        </div>
        <div class="record-field"><div class="record-field-head"><span>原始实验记录</span><small id="sourceCount">${l.source.length} 字</small></div>
          <textarea id="logSource" class="record-textarea" placeholder="记录当天的实验过程、参数、观察现象、数据、结论和后续计划。">${esc(l.source)}</textarea>
          <p class="record-hint">自动保存只在已有文字时创建日志文件。AI 整理不会编造数据；采用结果前可继续手动修改。</p>
        </div>
        <div class="record-organized">
          <div class="record-field"><div class="record-field-head"><span>实验现象</span></div><textarea id="logPhenomena" class="record-textarea short" placeholder="观察结果与直接数据">${esc(l.phenomena)}</textarea></div>
          <div class="record-field"><div class="record-field-head"><span>实验记录</span></div><textarea id="logRecord" class="record-textarea short" placeholder="目的、条件、步骤、结论与计划">${esc(l.record)}</textarea></div>
        </div>
        <div class="record-foot">
          <span class="record-hint">每次保存都会同步 AGENTS.md · Ctrl / ⌘ + S 立即保存</span>
          <div style="display:flex;gap:8px">
            <button id="organizeBtn" class="secondary-button" ${l.source.trim() ? '' : 'disabled'}>✦ AI 整理</button>
            <button id="saveLogBtn" class="primary-button">保存实验日志</button>
          </div>
        </div>
      </div>`;
    $('logDate').onchange = e => loadLog(e.target.value);
    const bind = (id, key) => $(id).oninput = e => {
      R.log[key] = e.target.value;
      if (id === 'logSource') { $('sourceCount').textContent = `${e.target.value.length} 字`; $('organizeBtn').disabled = !e.target.value.trim(); }
      scheduleLogSave();
    };
    bind('logSource', 'source'); bind('logPhenomena', 'phenomena'); bind('logRecord', 'record');
    $('saveLogBtn').onclick = () => saveLog(true);
    $('organizeBtn').onclick = organizeLog;
  }

  function scheduleLogSave() { clearTimeout(R.saveTimer); R.saveTimer = setTimeout(() => saveLog(false), 900); }

  async function loadLog(date) {
    R.date = date;
    try { R.log = (await api(`${slugPath(R.active.slug)}/logs/${date}`)).log; renderLogsView(); }
    catch (e) { toast(e.message); }
  }

  async function saveLog(announce) {
    if (!R.active || !Object.values(R.log).some(v => v.trim())) return;
    try {
      await api(`${slugPath(R.active.slug)}/logs/${R.date}`, { method: 'POST', body: JSON.stringify(R.log) });
      await refreshProjects(true);
      if (announce) toast('实验日志与 AGENTS.md 已保存');
    } catch (e) { toast(`保存失败：${e.message}`); }
  }

  async function organizeLog() {
    const source = R.log.source.trim();
    if (!source) return;
    const b = $('organizeBtn'); b.disabled = true; b.textContent = '正在整理…';
    try {
      const reply = await askModel([
        { role: 'system', content: '你是严谨的中文实验日志编辑助手。仅根据原文整理，不得编造或改变任何事实、数据、条件、结论和不确定性。只返回 JSON：{"phenomena":"...","record":"..."}。' },
        { role: 'user', content: source }
      ]);
      let parsed; try { const hit = reply.match(/\{[\s\S]*\}/); parsed = JSON.parse(hit ? hit[0] : reply); } catch { parsed = { phenomena: '', record: reply }; }
      R.log.phenomena = typeof parsed.phenomena === 'string' ? parsed.phenomena : '';
      R.log.record = typeof parsed.record === 'string' ? parsed.record : reply;
      renderLogsView();
      toast('已生成整理建议，请检查后保存');
    } catch (e) { toast(`AI 整理失败：${e.message}`); const f = $('organizeBtn'); if (f) { f.disabled = false; f.textContent = '✦ AI 整理'; } }
  }

  // ------------------------------------------------------- 视图：对话记录 --
  function renderRecordsView() {
    if (!requireProject('recordsProjectTitle', 'recordsBody')) return;
    $('recordsProjectTitle').textContent = R.active.name;
    const c = R.conversation;
    const listHtml = R.conversations.length
      ? R.conversations.map(x => `<button class="conversation-list-item ${c && x.id === c.id ? 'selected' : ''}" data-record="${esc(x.id)}"><h3>${esc(x.title)}</h3><div class="conversation-meta"><span class="model-badge">${esc(x.model)}</span><time>${esc((x.updatedAt || '').slice(0, 10))}</time></div></button>`).join('')
      : '<div class="empty-state" style="border:0;padding:30px 12px"><span>💬</span><strong>暂无对话</strong>可新建、手工记录或导入。</div>';
    let chatHtml = '<div class="conversation-detail-empty"><div><span>💬</span><p>选择或新建一段对话。可记录人工讨论、导入历史对话，或基于项目记忆继续向 AI 提问。</p></div></div>';
    if (c) {
      const msgs = c.messages.length
        ? c.messages.map(m => `<article class="message"><div class="message-avatar ${m.role === 'assistant' ? 'assistant' : ''}">${m.role === 'assistant' ? esc((c.model || 'A').slice(0, 1)) : '我'}</div><div class="message-content"><div class="message-meta">${m.role === 'assistant' ? esc(c.model || 'AI') : '你'} <small>${esc((m.createdAt || '').replace('T', ' ').slice(0, 16))}</small></div><div class="message-bubble">${esc(m.content)}</div></div></article>`).join('')
        : '<div class="empty-state" style="border:0"><span>◌</span><strong>空对话</strong>输入第一条消息后会保存为 Markdown。</div>';
      chatHtml = `<div class="conversation-head"><h2>${esc(c.title)}</h2><div class="detail-meta"><span class="model-badge">${esc(c.model)}</span><span>·</span><span>${c.messages.length} 条消息</span></div></div>
        <div id="recordMessages" class="messages" style="max-height:460px;overflow:auto">${msgs}</div>
        <div class="record-composer"><textarea id="recordInput" placeholder="继续提问；系统会把 AGENTS.md 作为项目上下文提供给 AI。（Ctrl/⌘ + Enter 发送）"></textarea><button id="recordSend" class="primary-button">发送</button></div>`;
    }
    $('recordsBody').innerHTML = `<div class="content-layout conversation-layout"><section class="conversation-list-panel"><div class="list-toolbar"><span>${R.conversations.length} 段对话</span></div><div class="conversation-list">${listHtml}</div></section><section class="conversation-detail-panel">${chatHtml}</section></div>`;
    $('recordsBody').querySelectorAll('[data-record]').forEach(b => b.onclick = () => loadConversation(b.dataset.record));
    if (c) {
      $('recordSend').onclick = sendMessage;
      $('recordInput').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendMessage(); });
      const m = $('recordMessages'); if (m) m.scrollTop = m.scrollHeight;
    }
  }

  async function loadConversation(id) {
    try { R.conversation = (await api(`${slugPath(R.active.slug)}/conversations/${encodeURIComponent(id)}`)).conversation; renderRecordsView(); }
    catch (e) { toast(e.message); }
  }

  async function saveConversation() {
    const c = R.conversation; if (!c) return;
    const d = await api(`${slugPath(R.active.slug)}/conversations`, { method: 'POST', body: JSON.stringify(c) });
    R.conversation = d.conversation;
    await refreshProjects(true);
  }

  async function sendMessage() {
    const input = $('recordInput'); const content = input.value.trim(); const c = R.conversation;
    if (!content || !c) return;
    input.value = '';
    c.messages.push({ role: 'user', content, createdAt: iso() });
    try {
      await saveConversation(); renderRecordsView();
      const s = readSettings();
      if (!s.endpoint || !s.model || !(s.key || R.sessionKey)) { toast('问题已记录。配置 AI 设置后可基于项目记忆获得回复。'); return; }
      const b = $('recordSend'); if (b) { b.disabled = true; b.textContent = '思考中…'; }
      const memory = (await api(`${slugPath(R.active.slug)}/agents`)).content;
      const history = c.messages.map(m => ({ role: m.role, content: m.content }));
      const answer = await askModel([
        { role: 'system', content: `你是科研协作助手。以下是项目 AGENTS.md 上下文；它包含原始记录索引，不能把模型建议当作已验证事实。请用中文清楚回答，区分证据、推测和待验证事项。\n\n${memory}` },
        ...history
      ]);
      c.messages.push({ role: 'assistant', content: answer, createdAt: iso() });
      await saveConversation(); renderRecordsView();
      toast('AI 回复与项目记忆已保存');
    } catch (e) { toast(`对话请求失败：${e.message}`); renderRecordsView(); }
  }

  // ------------------------------------------------------- 视图：项目记忆 --
  function renderMemoryView() {
    if (!requireProject('memoryProjectTitle', 'memoryBody')) return;
    $('memoryProjectTitle').textContent = R.active.name;
    const p = R.active;
    $('memoryBody').innerHTML = `
      <div class="record-panel">
        <div class="form-field full"><label>项目名称</label><input id="memName" maxlength="80" value="${esc(p.name)}" /></div>
        <div class="form-field full"><label>项目说明</label><textarea id="memDesc" style="min-height:70px" maxlength="800">${esc(p.description || '')}</textarea></div>
        <div class="form-field full"><label>重要信息</label><textarea id="memImportant" style="min-height:110px" maxlength="2000" placeholder="已知事实、样品编号、固定约束、待验证事项。会同步进入 AGENTS.md。">${esc(p.importantInfo || '')}</textarea></div>
        <div class="record-foot"><span class="record-hint">项目路径：科研项目/${esc(p.slug)}/</span><button id="saveMemBtn" class="primary-button">保存项目记忆</button></div>
        <div class="record-agents"><div class="record-field-head"><span>AGENTS.md（自动更新）</span></div><pre class="agents-preview">${esc(R.agents || '正在读取 AGENTS.md…')}</pre></div>
      </div>`;
    $('saveMemBtn').onclick = saveProjectInfo;
  }

  async function saveProjectInfo() {
    const payload = { name: $('memName').value.trim(), description: $('memDesc').value.trim(), importantInfo: $('memImportant').value.trim() };
    if (!payload.name) { toast('项目名称不能为空'); return; }
    try {
      const d = await api(slugPath(R.active.slug), { method: 'POST', body: JSON.stringify(payload) });
      R.active = d.project;
      await refreshProjects(true);
      await loadAgents();
      renderMemoryView();
      toast('README.md 与 AGENTS.md 已更新');
    } catch (e) { toast(`保存失败：${e.message}`); }
  }

  // -------------------------------------------------------------- 各类弹窗 --
  function openModal(content, init) {
    $('modalRoot').innerHTML = `<div class="modal-backdrop" role="dialog" aria-modal="true"><div class="modal">${content}</div></div>`;
    document.querySelectorAll('[data-close-modal]').forEach(b => b.addEventListener('click', closeModal));
    document.querySelector('.modal-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
    init?.();
  }
  function closeModal() { $('modalRoot').innerHTML = ''; }

  function openProjectDialog() {
    openModal(`<div class="modal-header"><div><h2>新建研究项目</h2><p>会在 科研项目/ 下创建项目文件夹、README.md 与 AGENTS.md。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="newProjectForm"><div class="modal-body"><div class="form-grid"><div class="form-field full"><label>项目名称</label><input id="npName" required maxlength="80" placeholder="如：电催化 ORR 活性优化" /></div><div class="form-field full"><label>项目说明</label><textarea id="npDesc" maxlength="800" placeholder="研究目标、样品信息或范围"></textarea></div><div class="form-field full"><label>重要信息</label><textarea id="npImportant" maxlength="2000" placeholder="已知事实、样品编号、固定约束、待验证事项。会同步进入 AGENTS.md。"></textarea></div></div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">创建项目</button></div></form>`,
      () => {
        $('npName').focus();
        $('newProjectForm').addEventListener('submit', async e => {
          e.preventDefault();
          const payload = { name: $('npName').value.trim(), description: $('npDesc').value.trim(), importantInfo: $('npImportant').value.trim() };
          try {
            const d = await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
            closeModal();
            await refreshProjects(false);
            selectProject(d.project.slug);
            toast('项目文件夹与初始 Markdown 已创建');
          } catch (err) { toast(`创建失败：${err.message}`); }
        });
      });
  }

  function openRecordDialog() {
    if (!R.active) { toast('请先选择或新建一个项目'); return; }
    openModal(`<div class="modal-header"><div><h2>新建对话记录</h2><p>会保存到当前项目的「对话记录」文件夹。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="newRecordForm"><div class="modal-body"><div class="form-grid"><div class="form-field full"><label>对话标题</label><input id="nrTitle" required maxlength="120" placeholder="如：下一轮实验条件讨论" /></div><div class="form-field full"><label>模型或来源</label><input id="nrModel" maxlength="80" value="手工记录" placeholder="如：ChatGPT、Claude、Gemini" /></div></div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">创建对话</button></div></form>`,
      () => {
        $('nrTitle').focus();
        $('newRecordForm').addEventListener('submit', async e => {
          e.preventDefault();
          R.conversation = { id: '', title: $('nrTitle').value.trim(), model: $('nrModel').value.trim() || '手工记录', messages: [] };
          try { await saveConversation(); closeModal(); await refreshProjects(true); await loadProject(R.active.slug); renderRecordsView(); toast('对话 Markdown 已创建'); }
          catch (err) { toast(`创建失败：${err.message}`); }
        });
      });
  }

  function openRecordImport() {
    if (!R.active) { toast('请先选择或新建一个项目'); return; }
    openModal(`<div class="modal-header"><div><h2>导入外部对话</h2><p>读取 JSON / Markdown / 文本，存为当前项目的 Markdown 对话记录。</p></div><button class="close-button" data-close-modal>×</button></div>
      <div class="modal-body"><div class="form-field full"><label>选择导出文件</label><input id="riFile" type="file" accept=".json,.md,.txt,application/json,text/plain" /></div><div class="form-field full"><label>来源模型</label><input id="riModel" maxlength="80" value="导入记录" /></div><p class="import-tip">可识别常见的 messages 字段与 ChatGPT 的 mapping；无法识别的内容也会作为原始文本保留。</p></div>
      <div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" id="riConfirm">导入对话</button></div>`,
      () => { $('riConfirm').onclick = importRecord; });
  }

  async function importRecord() {
    const file = $('riFile').files[0];
    if (!file) { toast('请选择要导入的文件'); return; }
    try {
      const text = await file.text();
      let raw; try { raw = JSON.parse(text); } catch { }
      const root = Array.isArray(raw) ? raw[0] : (raw || {});
      let messages = [];
      if (Array.isArray(root.messages)) messages = root.messages.map(m => ({ role: (m.role || m.author?.role) === 'user' ? 'user' : 'assistant', content: typeof m.content === 'string' ? m.content : (m.content?.parts || []).join('\n'), createdAt: m.createdAt || m.create_time || iso() })).filter(m => m.content?.trim());
      else if (root.mapping) messages = Object.values(root.mapping).map(n => n.message).filter(Boolean).map(m => ({ role: m.author?.role === 'user' ? 'user' : 'assistant', content: (m.content?.parts || []).filter(Boolean).join('\n'), createdAt: m.create_time ? new Date(m.create_time * 1000).toISOString() : iso() })).filter(m => m.content.trim());
      else messages = [{ role: 'assistant', content: text, createdAt: iso() }];
      R.conversation = { id: '', title: root.title || file.name.replace(/\.[^.]+$/, ''), model: $('riModel').value.trim() || '导入记录', messages };
      await saveConversation(); closeModal(); await refreshProjects(true); await loadProject(R.active.slug); renderRecordsView();
      toast(`已导入 ${messages.length} 条消息，并更新 AGENTS.md`);
    } catch (e) { toast(`导入失败：${e.message}`); }
  }

  function openApiDialog() {
    const s = readSettings();
    openModal(`<div class="modal-header"><div><h2>AI 对话设置</h2><p>用于「AI 整理」实验日志，以及基于项目记忆继续提问。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="apiForm"><div class="modal-body"><p class="import-tip" style="border-left:3px solid #c7dccd;background:#f4f8f3;padding:10px 12px;margin-top:0">API Key 仅保存在本浏览器。项目 Markdown、实验数据与对话只有在你点击发送时才会随请求发送给所配置的服务商。</p>
      <div class="form-field full"><label>接口地址</label><input id="apiEndpoint" type="url" required value="${esc(s.endpoint || 'https://api.openai.com/v1/chat/completions')}" placeholder="https://api.openai.com/v1/chat/completions" /></div>
      <div class="form-field full"><label>模型名称</label><input id="apiModel" required value="${esc(s.model || '')}" placeholder="例如：gpt-4.1-mini" /></div>
      <div class="form-field full"><label>API Key</label><input id="apiKey" type="password" autocomplete="off" value="${esc(s.key || R.sessionKey || '')}" placeholder="粘贴 API Key" /></div>
      <label class="field-note" style="display:flex;align-items:center;gap:8px"><input id="apiStore" type="checkbox" ${s.persist ? 'checked' : ''} style="width:16px;height:16px" /> 保存 API Key 到本浏览器</label>
      <p class="import-tip">支持 OpenAI Chat Completions 兼容接口。请求经本机服务转发至 HTTPS 地址，以避免 CORS 限制。</p></div>
      <div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">保存设置</button></div></form>`,
      () => {
        $('apiForm').addEventListener('submit', e => {
          e.preventDefault();
          const persist = $('apiStore').checked; const key = $('apiKey').value.trim();
          R.sessionKey = key;
          saveSettings({ endpoint: $('apiEndpoint').value.trim(), model: $('apiModel').value.trim(), key: persist ? key : '', persist });
          closeModal();
          toast(persist ? 'AI 设置已保存到本浏览器' : 'AI 设置已保存；刷新页面后需重新填写 API Key');
        });
      });
  }

  async function showAgents() {
    if (!R.active) { toast('请先选择项目'); return; }
    await loadAgents();
    openModal(`<div class="modal-header"><div><h2>项目 AGENTS.md</h2><p>可直接交给 AI 的项目上下文；自动区块随日志与对话保存即时更新。</p></div><button class="close-button" data-close-modal>×</button></div>
      <div class="modal-body"><pre class="agents-preview" style="max-height:60vh">${esc(R.agents)}</pre></div>
      <div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>关闭</button></div>`);
  }

  // ------------------------------------------------------------------ 派发 --
  function renderActiveView() {
    const v = currentView();
    if (v === 'logs') renderLogsView();
    else if (v === 'records') renderRecordsView();
    else if (v === 'memory') renderMemoryView();
  }

  function onViewActivated(view) {
    if (view === 'logs') renderLogsView();
    else if (view === 'records') renderRecordsView();
    else if (view === 'memory') renderMemoryView();
  }

  // 事件绑定
  document.addEventListener('DOMContentLoaded', () => {
    $('apiSettingsButton')?.addEventListener('click', openApiDialog);
    $('viewAgentsButton')?.addEventListener('click', showAgents);
    $('newRecordButton')?.addEventListener('click', openRecordDialog);
    $('recordImportButton')?.addEventListener('click', openRecordImport);
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && ['logs'].includes(currentView())) { e.preventDefault(); saveLog(true); }
    });
    refreshProjects(false).then(() => { if (window.SciHubApp) window.SciHubApp.renderAll(); });
  });

  // 暴露给 app.js
  window.SciHubRecords = {
    get projects() { return R.projects; },
    renderProjectSidebar,
    selectProject,
    openProjectDialog,
    onViewActivated
  };
})();
