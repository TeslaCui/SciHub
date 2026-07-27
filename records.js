/* records.js — SciHub 文件后端集成层
 *
 * 负责：从本地服务读取/写入项目、实验日志、对话记录（全部保存为 .md），
 * 维护每个项目的 AGENTS.md，并提供基于项目记忆的 AI 对话与整理。
 * 与 app.js 协作，共享侧栏与视觉风格。
 */
(() => {
  'use strict';

  const API_SETTINGS_KEY = 'scihub-api-settings-v1';
  const TODAY = new Date().toISOString().slice(0, 10);
  const PROVIDERS = {
    openai: {
      label: 'GPT（OpenAI）',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini']
    },
    gemini: {
      label: 'Gemini（Google）',
      endpoint: '',
      models: ['gemini-2.5-flash', 'gemini-2.5-pro']
    },
    claude: {
      label: 'Claude（Anthropic）',
      endpoint: 'https://api.anthropic.com/v1/messages',
      models: ['claude-sonnet-4-5', 'claude-haiku-4-5']
    },
    deepseek: {
      label: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/chat/completions',
      models: ['deepseek-v4-pro', 'deepseek-v4-flash']
    }
  };
  const REASONING_EFFORTS = {
    default: '模型默认',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高'
  };

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
    log: { source: '', phenomena: '', record: '', images: [], formattedSource: '', planId: '', subexperimentId: '', aiContext: '', includePlanMemory: true },
    logs: [],
    plans: [],
    planBook: null,
    planEditor: null,
    planGeneration: null,
    conversations: [],
    conversation: null,
    agents: '',
    autoPolish: true,
    useFullProjectMemory: false,
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

  function providerFor(settings) {
    if (PROVIDERS[settings.provider]) return settings.provider;
    const endpoint = settings.endpoint || '';
    if (endpoint.includes('generativelanguage.googleapis.com')) return 'gemini';
    if (endpoint.includes('anthropic.com')) return 'claude';
    if (endpoint.includes('deepseek.com')) return 'deepseek';
    return 'openai';
  }

  function normalizeSettings(stored = {}) {
    const provider = providerFor(stored);
    const isOfficialDeepSeek = !stored.endpoint
      || stored.endpoint === 'https://api.deepseek.com'
      || stored.endpoint === PROVIDERS.deepseek.endpoint;
    const legacyDeepSeekModel = provider === 'deepseek'
      && isOfficialDeepSeek
      && ['deepseek-chat', 'deepseek-reasoner'].includes(stored.model);
    return {
      ...stored,
      provider,
      model: legacyDeepSeekModel ? PROVIDERS.deepseek.models[0] : (stored.model || PROVIDERS[provider].models[0]),
      endpoint: stored.endpoint || PROVIDERS[provider].endpoint,
      reasoningEffort: stored.reasoningEffort || 'default'
    };
  }

  function settingsForUse() { return normalizeSettings(readSettings()); }

  function geminiEndpoint(settings) {
    return settings.endpoint || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`;
  }

  async function askModel(messages, draftSettings = null) {
    const settings = draftSettings ? normalizeSettings(draftSettings) : settingsForUse();
    const key = settings.key || R.sessionKey;
    if (!settings.model || !key) throw new Error('请先在「AI 设置」中选择服务商、模型并填写 API Key。');
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const chatMessages = messages.filter(m => m.role !== 'system');
    let url;
    let headers;
    let body;
    if (settings.provider === 'gemini') {
      url = `${geminiEndpoint(settings)}${geminiEndpoint(settings).includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
      headers = {};
      body = {
        contents: chatMessages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { temperature: 0.2 },
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {})
      };
    } else if (settings.provider === 'claude') {
      url = settings.endpoint || PROVIDERS.claude.endpoint;
      headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = {
        model: settings.model,
        max_tokens: 4096,
        messages: chatMessages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        ...(system ? { system } : {})
      };
    } else {
      url = settings.endpoint || PROVIDERS[settings.provider].endpoint;
      headers = { Authorization: `Bearer ${key}` };
      if (settings.provider === 'deepseek') {
        const deepSeekEffort = {
          low: 'high',
          medium: 'high',
          high: 'high',
          xhigh: 'max'
        }[settings.reasoningEffort];
        body = {
          model: settings.model,
          messages,
          thinking: { type: 'enabled' },
          ...(deepSeekEffort ? { reasoning_effort: deepSeekEffort } : {})
        };
      } else {
        const reasoning = settings.provider === 'openai' && settings.reasoningEffort !== 'default'
          ? { reasoning_effort: settings.reasoningEffort }
          : {};
        body = { model: settings.model, messages, ...(Object.keys(reasoning).length ? reasoning : { temperature: 0.2 }) };
      }
    }
    const response = await api('/api/proxy', {
      method: 'POST',
      body: JSON.stringify({ url, headers, body })
    });
    const content = settings.provider === 'gemini'
      ? response.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('')
      : settings.provider === 'claude'
        ? response.content?.map(part => part.text || '').join('')
        : response.choices?.[0]?.message?.content;
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
    // 任一核心视图均显示相同的本地服务提示
    const hint = '未连接本地文件服务。请通过「启动 SciHub.cmd」以 Python 启动，再刷新页面。';
    toast(hint);
  }

  async function loadProject(slug) {
    R.active = R.projects.find(p => p.slug === slug) || null;
    R.date = TODAY;
    R.log = { source: '', phenomena: '', record: '', images: [], formattedSource: '', planId: '', subexperimentId: '' };
    R.autoPolish = true;
    R.useFullProjectMemory = false;
    R.conversation = null;
    if (!R.active) return;
    try {
      const [logs, conversations, plans] = await Promise.all([
        api(`${slugPath(slug)}/logs`),
        api(`${slugPath(slug)}/conversations`),
        api(`${slugPath(slug)}/plans`)
      ]);
      R.logs = logs.logs || [];
      R.conversations = conversations.conversations || [];
      R.plans = plans.plans || [];
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
      const v = ['plans', 'logs', 'records', 'memory', 'planBook'].includes(currentView()) ? currentView() : 'logs';
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
    list.querySelectorAll('[data-project-select]').forEach(button => {
      button.addEventListener('click', () => selectProject(button.dataset.projectSelect));
    });
  }

  function updateTopbarActions(view = currentView()) {
    document.querySelector('.app-shell')?.classList.toggle('home-mode', view === 'home');
    const exportButton = $('exportProjectButton');
    if (exportButton) exportButton.hidden = view === 'home' || !R.active;
  }

  function renderHomeView() {
    updateTopbarActions('home');
    const body = $('homeBody');
    if (!body) return;
    if (!R.projects.length) {
      body.innerHTML = `<div class="empty-state home-empty"><span>⌂</span><strong>还没有研究项目</strong><p>先创建一个项目；之后它的实验方案、实验日志和对话记录都会保存在独立的项目文件夹中。</p><button class="primary-button" id="homeEmptyCreate">+ 新建项目</button></div>`;
      $('homeEmptyCreate').onclick = openProjectDialog;
      return;
    }
    body.innerHTML = `<div class="home-project-grid">${R.projects.map(project => `
      <article class="home-project-card">
        <div><p class="eyebrow">研究项目</p><h2>${esc(project.name)}</h2></div>
        <p>${esc(project.description || '尚未填写项目说明。')}</p>
        <div class="home-project-meta"><span>${project.logCount || 0} 条实验日志</span><span>${project.conversationCount || 0} 段对话</span></div>
        <div class="home-project-footer"><span>项目/${esc(project.slug)}/</span><div class="home-project-actions"><button class="text-button" data-edit-project="${esc(project.slug)}">编辑信息</button><button class="text-button danger-button" data-delete-project="${esc(project.slug)}">删除项目</button><button class="primary-button" data-enter-project="${esc(project.slug)}">进入项目</button></div></div>
      </article>`).join('')}</div>`;
    body.querySelectorAll('[data-enter-project]').forEach(button => {
      button.onclick = () => selectProject(button.dataset.enterProject);
    });
    body.querySelectorAll('[data-edit-project]').forEach(button => {
      button.onclick = () => openProjectEditDialog(button.dataset.editProject);
    });
    body.querySelectorAll('[data-delete-project]').forEach(button => {
      button.onclick = () => openProjectDeleteDialog(button.dataset.deleteProject);
    });
  }

  function requireProject(titleEl, bodyEl) {
    if (R.active) return true;
    $(titleEl).textContent = '选择一个研究项目';
    $(bodyEl).innerHTML = '<div class="empty-state"><span>◫</span><strong>还没有选择项目</strong>在左侧选择或新建一个研究项目后，这里会显示对应的文件记录。</div>';
    return false;
  }

  // ---------------------------------------------------------- 视图：方案 --
  function planEntriesHtml(entries = []) {
    if (!entries.length) return '<span class="plan-entry-empty">暂无附加文件或子文件夹</span>';
    return `<div class="plan-entry-list">${entries.map(entry => `<span class="plan-entry"><i>${entry.kind === 'folder' ? '▣' : '▤'}</i>${esc(entry.name)}</span>`).join('')}</div>`;
  }

  function projectPath(...parts) {
    return ['科研项目', R.active?.slug || '当前项目', ...parts.filter(Boolean).map(String)].join('/');
  }

  function logStoragePath(log = R.log, date = R.date) {
    if (!log.planId) return projectPath('实验日志', `${date}.md`);
    const plan = planForLog(log);
    const planFolder = plan?.folder || log.planFolder || '实验方案';
    const subexperiment = plan?.subexperiments?.find(item => item.id === log.subexperimentId);
    const subexperimentFolder = subexperiment?.folder || log.subexperimentFolder || '';
    return projectPath(planFolder, log.subexperimentId ? subexperimentFolder : '', '实验日志', `${date}.md`);
  }

  function renderPlansView() {
    if (!requireProject('plansProjectTitle', 'plansBody')) return;
    $('plansProjectTitle').textContent = R.active.name;
    if (!R.plans.length) {
      $('plansBody').innerHTML = `<div class="empty-state plans-empty"><span>◇</span><strong>还没有实验方案</strong><p>先创建方案版本，再录入它包含的子实验。之后每条实验日志都可以关联到方案或某个子实验。</p><button id="plansEmptyCreate" class="primary-button">+ 新建实验方案</button></div>`;
      $('plansEmptyCreate').onclick = openPlanDialog;
      return;
    }
    const cards = R.plans.map(plan => {
      const relatedLogs = R.logs.filter(log => log.planId === plan.id);
      const hasSubexperiments = (plan.subexperiments?.length || 0) > 0;
      const subexperiments = plan.subexperiments?.length
        ? plan.subexperiments.map(item => {
          const subLogCount = relatedLogs.filter(log => log.subexperimentId === item.id).length;
          const subexperimentPath = projectPath(plan.folder || '实验方案', item.folder || '', '实验方案.md');
          return `<li><div><b>${esc(item.name)}</b>${item.description ? `<small>${esc(item.description)}</small>` : ''}<small class="plan-associated-path">关联文件夹：${esc(subexperimentPath)}</small>${planEntriesHtml(item.entries)}</div><div class="plan-sub-actions"><span>${subLogCount} 条日志</span><button class="text-button" data-start-log="${esc(plan.id)}" data-start-subexperiment="${esc(item.id)}">记录日志</button><button class="text-button" data-preview-plan="${esc(plan.id)}" data-subexperiment-id="${esc(item.id)}">查看实验方案</button></div></li>`;
        }).join('')
        : '<li class="plan-subexperiment-empty"><span>尚未设置子实验；可先将日志关联到整个方案。</span></li>';
      const editable = plan.storage !== 'legacy';
      const planDocumentPath = projectPath(plan.relativePath || `${plan.folder || '实验方案'}/方案.md`);
      const planFolderPath = projectPath(plan.folder || '实验方案');
      return `<article class="plan-card">
        <div class="plan-card-head"><div><span class="plan-version">${esc(plan.version)}</span><h2>${esc(plan.name)}</h2></div><div><span class="plan-log-count">${relatedLogs.length} 条关联日志</span>${editable ? `<div class="plan-card-actions"><button class="text-button" data-compare-plan="${esc(plan.id)}">查看版本改动</button><button class="text-button" data-edit-plan="${esc(plan.id)}">编辑方案</button><button class="text-button danger-button" data-delete-plan="${esc(plan.id)}">删除方案</button></div>` : ''}</div></div>
        <p class="plan-description">${esc(plan.description || '尚未填写方案说明。')}</p>
        <div class="plan-files"><div class="plan-section-label">方案书：${esc(planDocumentPath)}</div>${planEntriesHtml(plan.entries)}<div class="plan-file-actions">${hasSubexperiments ? '<span class="plan-file-hint">此方案已有子实验；请在对应子实验中查看和管理方案书。</span>' : `<button class="text-button" data-preview-plan="${esc(plan.id)}">查看实验方案</button>`}</div></div>
        <div class="plan-subexperiments"><div class="plan-section-head"><div class="plan-section-label">子实验</div><button class="text-button" data-add-subexperiment="${esc(plan.id)}">+ 添加子实验</button></div><ul>${subexperiments}</ul></div>
        <div class="plan-card-foot"><span>${esc(planFolderPath)}/ · ${esc((plan.updatedAt || '').slice(0, 10) || '刚刚')}</span><button class="secondary-button" data-start-log="${esc(plan.id)}">关联此方案记录日志</button></div>
      </article>`;
    }).join('');
    $('plansBody').innerHTML = `<div class="plans-grid">${cards}</div>`;
    $('plansBody').querySelectorAll('[data-start-log]').forEach(button => {
      button.onclick = () => startPlanLog(button.dataset.startLog, button.dataset.startSubexperiment || '');
    });
    $('plansBody').querySelectorAll('[data-add-subexperiment]').forEach(button => {
      button.onclick = () => openSubexperimentDialog(button.dataset.addSubexperiment);
    });
    $('plansBody').querySelectorAll('[data-preview-plan]').forEach(button => {
      button.onclick = () => openPlanBookPage(button.dataset.previewPlan, button.dataset.subexperimentId || '');
    });
    $('plansBody').querySelectorAll('[data-edit-plan]').forEach(button => {
      button.onclick = () => openEditPlanDialog(button.dataset.editPlan);
    });
    $('plansBody').querySelectorAll('[data-delete-plan]').forEach(button => {
      button.onclick = () => openPlanDeleteDialog(button.dataset.deletePlan);
    });
    $('plansBody').querySelectorAll('[data-compare-plan]').forEach(button => {
      button.onclick = () => openPlanDiffDialog(button.dataset.comparePlan);
    });
  }

  function startPlanLog(planId, subexperimentId = '') {
    R.date = TODAY;
    window.switchView('logs');
    loadLog(TODAY, { planId, subexperimentId });
  }

  function openEditPlanDialog(planId) {
    const plan = R.plans.find(item => item.id === planId);
    if (!plan) { toast('未找到实验方案'); return; }
    if (plan.storage === 'legacy') { toast('旧版单文件方案暂不支持在界面编辑'); return; }
    openModal(`<div class="modal-header"><div><h2>编辑实验方案</h2><p>可修改方案名称和说明；版本目录 <b>${esc(plan.folder)}</b> 保持不变，以免移动已有的子实验和日志文件。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="editPlanForm"><div class="modal-body"><div class="form-grid">
        <label class="form-field"><span>方案名称</span><input id="editPlanName" required maxlength="120" value="${esc(plan.name)}" /></label>
        <label class="form-field"><span>版本目录</span><input value="${esc(plan.folder)}" disabled /><small class="field-note">目录名不在编辑时变更，保证现有文件路径稳定。</small></label>
        <label class="form-field full"><span>方案说明</span><textarea id="editPlanDescription" maxlength="4000" placeholder="方案目的、变量范围、判定标准等。">${esc(plan.description || '')}</textarea></label>
      </div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">保存修改</button></div></form>`, () => {
      $('editPlanForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('editPlanForm').querySelector('[type=submit]');
        button.disabled = true;
        button.textContent = '保存中…';
        try {
          const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}`, {
            method: 'PUT',
            body: JSON.stringify({
              name: $('editPlanName').value.trim(),
              description: $('editPlanDescription').value.trim()
            })
          });
          R.plans = R.plans.map(item => item.id === response.plan.id ? response.plan : item);
          closeModal();
          renderPlansView();
          toast('实验方案已更新');
        } catch (error) {
          toast(`保存方案失败：${error.message}`);
        } finally {
          const current = $('editPlanForm')?.querySelector('[type=submit]');
          if (current) { current.disabled = false; current.textContent = '保存修改'; }
        }
      });
    });
  }

  async function openPlanDeleteDialog(planId) {
    if (!R.active) { toast('请先选择项目'); return; }
    try {
      const preview = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/delete-preview`);
      const items = preview.items || [];
      const fileList = items.map(item => `<li><i>${item.kind === 'folder' ? '▣' : '▤'}</i>${esc(item.path)}</li>`).join('');
      openModal(`<div class="modal-header"><div><h2>删除实验方案</h2><p>该操作会删除整个方案版本目录及其中的子实验、关联日志和附加文件，无法撤销。</p></div><button class="close-button" data-close-modal>×</button></div>
        <form id="deletePlanForm"><div class="modal-body"><div class="delete-warning"><b>待删除目录：项目/${esc(preview.folder)}/</b><br>以下 ${items.length} 项会被逐项删除。请核对清单后，输入版本目录名以确认。</div><ul class="delete-target-list">${fileList || '<li>目录为空</li>'}</ul><label class="form-field full" style="margin-top:16px"><span>输入 <b>${esc(preview.folder)}</b> 以确认删除</span><input id="deletePlanConfirmation" required autocomplete="off" placeholder="${esc(preview.folder)}" /></label></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit" style="background:#a85349">删除方案</button></div></form>`, () => {
        $('deletePlanConfirmation').focus();
        $('deletePlanForm').addEventListener('submit', async event => {
          event.preventDefault();
          const confirmation = $('deletePlanConfirmation').value.trim();
          if (confirmation !== preview.folder) { toast('请输入完整且正确的版本目录名'); return; }
          const button = $('deletePlanForm').querySelector('[type=submit]');
          button.disabled = true;
          button.textContent = '删除中…';
          try {
            await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}`, {
              method: 'DELETE',
              body: JSON.stringify({ confirmation })
            });
            closeModal();
            await refreshProjects(true);
            await loadProject(R.active.slug);
            renderPlansView();
            toast('实验方案目录及清单中的关联内容已删除');
          } catch (error) {
            toast(`删除方案失败：${error.message}`);
            const current = $('deletePlanForm')?.querySelector('[type=submit]');
            if (current) { current.disabled = false; current.textContent = '删除方案'; }
          }
        });
      });
    } catch (error) {
      toast(`无法读取删除清单：${error.message}`);
    }
  }

  function openPlanEntryDialog(planId, subexperimentId, kind) {
    const label = kind === 'folder' ? '子文件夹' : 'Markdown 文件';
    openModal(`<div class="modal-header"><div><h2>新增${label}</h2><p>文件会直接创建在当前方案或子实验文件夹中，并随“导出整个项目”一同保留。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="planEntryForm"><div class="modal-body"><div class="form-grid">
        <label class="form-field full"><span>${label}名称</span><input id="planEntryName" required placeholder="例如：结果汇总${kind === 'file' ? '.md（可省略）' : ''}" /></label>
        ${kind === 'file' ? '<label class="form-field full"><span>文件内容（可选）</span><textarea id="planEntryContent" placeholder="可直接写入 Markdown 内容。"></textarea></label>' : ''}
      </div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">创建${label}</button></div></form>`, () => {
      $('planEntryForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('planEntryForm').querySelector('[type=submit]');
        button.disabled = true;
        button.textContent = '创建中…';
        try {
          const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/entries`, {
            method: 'POST',
            body: JSON.stringify({
              kind,
              name: $('planEntryName').value.trim(),
              content: $('planEntryContent')?.value.trim() || '',
              subexperimentId
            })
          });
          R.plans = R.plans.map(plan => plan.id === response.plan.id ? response.plan : plan);
          closeModal();
          renderPlansView();
          toast(`${label}已创建`);
        } catch (error) {
          toast(`创建${label}失败：${error.message}`);
        } finally {
          const current = $('planEntryForm')?.querySelector('[type=submit]');
          if (current) { current.disabled = false; current.textContent = `创建${label}`; }
        }
      });
    });
  }

  const PLAN_STYLE_RE = /<!--\s*SCIHUB-PLAN-STYLE:\s*({[\s\S]*?})\s*-->/i;
  const PLAN_STYLE_DEFAULT = { font: 'Microsoft YaHei', fontSize: 11, layout: 'spacious' };
  const PLAN_LAYOUT_OPTIONS = [
    ['compact', '紧凑排布（占用最少页面）'],
    ['spacious', '宽松排布（表达结构清晰）']
  ];
  const PLAN_FONT_OPTIONS = [
    ['Microsoft YaHei', '微软雅黑'],
    ['SimSun', '宋体'],
    ['KaiTi', '楷体'],
    ['Noto Serif SC', '思源宋体']
  ];

  function planPresentationStyle(content = '') {
    const match = String(content).match(PLAN_STYLE_RE);
    if (!match) return { ...PLAN_STYLE_DEFAULT };
    try {
      const stored = JSON.parse(match[1]);
      const font = PLAN_FONT_OPTIONS.some(([value]) => value === stored.font) ? stored.font : PLAN_STYLE_DEFAULT.font;
      const fontSize = Number(stored.fontSize);
      const layout = PLAN_LAYOUT_OPTIONS.some(([value]) => value === stored.layout) ? stored.layout : PLAN_STYLE_DEFAULT.layout;
      return { font, fontSize: [9, 10, 11, 12, 13, 14, 16].includes(fontSize) ? fontSize : PLAN_STYLE_DEFAULT.fontSize, layout };
    } catch {
      return { ...PLAN_STYLE_DEFAULT };
    }
  }

  function planContentWithStyle(content, style) {
    const clean = String(content || '').replace(PLAN_STYLE_RE, '').trim();
    const safe = {
      font: PLAN_FONT_OPTIONS.some(([value]) => value === style?.font) ? style.font : PLAN_STYLE_DEFAULT.font,
      fontSize: [9, 10, 11, 12, 13, 14, 16].includes(Number(style?.fontSize)) ? Number(style.fontSize) : PLAN_STYLE_DEFAULT.fontSize,
      layout: PLAN_LAYOUT_OPTIONS.some(([value]) => value === style?.layout) ? style.layout : PLAN_STYLE_DEFAULT.layout
    };
    return `<!-- SCIHUB-PLAN-STYLE: ${JSON.stringify(safe)} -->\n\n${clean}`.trim();
  }

  function editablePlanContent(content = '') {
    const marked = content.match(/<!-- PLAN-CONTENT:START -->\s*([\s\S]*?)\s*<!-- PLAN-CONTENT:END -->/);
    const source = marked ? marked[1] : (() => {
      const legacy = content.match(/(?:^|\n)## 实验方案\s*\n([\s\S]*?)(?=\n## 子实验\s*$|$)/m);
      return legacy ? legacy[1] : content;
    })();
    return String(source).replace(PLAN_STYLE_RE, '').trim();
  }

  function standardPlanPrompt(sourceMarkdown) {
    return [
      { role: 'system', content: '你是一名严谨的科研实验方案编辑。请仅基于用户提供的 Markdown 资料，生成可由研究者审核的中文 Markdown 实验方案。必须使用以下三级标题：### 实验目的、### 研究假设与实验设计、### 材料与仪器、### 实验分组与变量、### 操作步骤、### 记录与数据处理、### 预期结果与判定标准、### 风险与注意事项、### 待确认项。原资料中没有的试剂、仪器、参数、剂量、时间、结论和现象一律不得虚构；缺失的信息必须明确写“待补充”。操作步骤只能重组、澄清已提供的动作或列为待补充。不要输出 YAML front matter、一级标题或“以下是方案”等说明。' },
      { role: 'user', content: `请读取以下已转换的 Markdown 资料，并生成标准实验方案：\n\n${sourceMarkdown}` }
    ];
  }

  function openPlanSourceImportDialog(planId, subexperimentId = '') {
    const plan = R.plans.find(item => item.id === planId);
    if (!plan || !R.active) { toast('未找到可导入资料的实验方案'); return; }
    const subexperiment = plan.subexperiments?.find(item => item.id === subexperimentId);
    const importFolder = subexperiment ? `${plan.folder}/${subexperiment.folder}/导入资料/` : `${plan.folder}/导入资料/`;
    openModal(`<div class="modal-header"><div><h2>导入方案资料</h2><p>支持 Word（.docx）、PDF、Markdown 与文本。系统只会把转换后的 Markdown 保存到 <b>${esc(importFolder)}</b>，不会保留原始二进制文件。</p></div><button class="close-button" data-close-modal>×</button></div>
      <div class="modal-body"><div class="form-field full"><label>选择方案资料</label><input id="planSourceFile" type="file" accept=".docx,.pdf,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain" /></div><p class="import-tip">Word 中的图片、PDF 页面中的嵌入图片会以文件/页码信息记录在转换后的 Markdown 中；扫描版 PDF 需要先 OCR。</p></div>
      <div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button id="planSourceImportConfirm" type="button" class="primary-button">导入资料</button></div>`, () => {
      $('planSourceImportConfirm').onclick = () => importPlanSourceDocument(planId, subexperimentId);
    });
  }

  async function importPlanSourceDocument(planId, subexperimentId = '') {
    const file = $('planSourceFile')?.files?.[0];
    if (!file) { toast('请选择要导入的方案文件'); return; }
    if (file.size > 15 * 1024 * 1024) { toast('文件超过 15 MB，暂不能导入'); return; }
    const button = $('planSourceImportConfirm');
    button.disabled = true;
    button.textContent = '正在转换为 Markdown…';
    try {
      const imported = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/import`, {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, contentBase64: await fileToBase64(file), subexperimentId })
      });
      R.plans = (await api(`${slugPath(R.active.slug)}/plans`)).plans || R.plans;
      await loadAgents();
      closeModal();
      openPlanBookPage(planId, subexperimentId, imported);
    } catch (error) {
      toast(`方案文件导入失败：${error.message}`);
    } finally {
      const current = $('planSourceImportConfirm');
      if (current) { current.disabled = false; current.textContent = '导入资料'; }
    }
  }

  // 保留旧版弹窗编辑器的实现，便于兼容历史页面；方案书页现在使用下方的页内编辑器。
  async function openPlanContentEditorModal(planId, subexperimentId = '') {
    const plan = R.plans.find(item => item.id === planId);
    if (!plan || !R.active) { toast('未找到实验方案'); return; }
    const scopeQuery = subexperimentId ? `?subexperimentId=${encodeURIComponent(subexperimentId)}` : '';
    let existing = '';
    let presentation = { ...PLAN_STYLE_DEFAULT };
    try {
      const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/content${scopeQuery}`);
      existing = editablePlanContent(response.content || '');
      presentation = planPresentationStyle(response.content || '');
    } catch (error) {
      toast(`读取方案正文失败：${error.message}`);
      return;
    }
    const editorStyle = `font-family:${esc(presentation.font)},sans-serif;font-size:${presentation.fontSize}pt`;
    const fontOptions = PLAN_FONT_OPTIONS.map(([value, label]) => `<option value="${esc(value)}" ${value === presentation.font ? 'selected' : ''}>${esc(label)}</option>`).join('');
    const sizeOptions = [9, 10, 11, 12, 13, 14, 16].map(size => `<option value="${size}" ${size === presentation.fontSize ? 'selected' : ''}>${size} pt</option>`).join('');
    const layoutOptions = PLAN_LAYOUT_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === presentation.layout ? 'selected' : ''}>${label}</option>`).join('');
    openModal(`<div class="modal-header"><div><h2>编辑实验方案书</h2><p>可直接输入、删除和调整结构。格式会保存为 Markdown；字体与字号作为方案书的版式设置保存，不会留下 HTML 文件。</p></div><button class="close-button" data-close-modal>×</button></div>
      <div class="modal-body plan-editor-modal"><div class="plan-editor-toolbar" role="toolbar" aria-label="方案书编辑工具"><label>全文字体 <select id="planEditorFont">${fontOptions}</select></label><label>全文字号 <select id="planEditorSize">${sizeOptions}</select></label><label>排版 <select id="planEditorLayout">${layoutOptions}</select></label><span class="plan-editor-divider"></span><button type="button" data-plan-editor-command="bold" title="加粗"><b>B</b></button><button type="button" data-plan-editor-command="italic" title="斜体"><i>I</i></button><button type="button" data-plan-editor-command="insertUnorderedList" title="无序列表">• 列表</button><button type="button" data-plan-editor-command="insertOrderedList" title="有序列表">1. 列表</button><button type="button" data-plan-editor-command="undo" title="撤销">↶</button><button type="button" data-plan-editor-command="redo" title="重做">↷</button></div><p class="plan-editor-hint">紧凑排布会把“材料与仪器”等清单压缩为多列；宽松排布保留逐项结构。粘贴内容会以纯文本写入，避免把外部 Word 格式混入项目 Markdown。选中文字后右键，可保留复制、剪切、粘贴，并按你的要求让 AI 修改该段。</p><div id="planContentEditor" class="plan-rich-editor execution-document-body" data-layout="${presentation.layout}" contenteditable="true" role="textbox" aria-multiline="true" style="${editorStyle}">${executionPlanHtml(existing)}</div></div>
      <div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button id="savePlanContentButton" type="button" class="primary-button">保存并查看方案书</button></div>`, () => {
      const editor = $('planContentEditor');
      const applyPresentation = () => {
        editor.style.fontFamily = $('planEditorFont').value;
        editor.style.fontSize = `${$('planEditorSize').value}pt`;
        editor.dataset.layout = $('planEditorLayout').value;
      };
      $('planEditorFont').addEventListener('change', applyPresentation);
      $('planEditorSize').addEventListener('change', applyPresentation);
      $('planEditorLayout').addEventListener('change', applyPresentation);
      document.querySelectorAll('[data-plan-editor-command]').forEach(button => button.addEventListener('click', () => {
        editor.focus();
        document.execCommand(button.dataset.planEditorCommand, false);
      }));
      editor.addEventListener('paste', event => {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain') || '';
        document.execCommand('insertText', false, text);
      });
      const modal = editor.closest('.modal');
      let savedRange = null;
      let savedText = '';
      let aiBusy = false;
      const contextMenu = document.createElement('div');
      contextMenu.className = 'plan-editor-context-menu';
      contextMenu.hidden = true;
      contextMenu.innerHTML = `<button type="button" data-plan-context-action="copy">复制</button><button type="button" data-plan-context-action="cut">剪切</button><button type="button" data-plan-context-action="paste">粘贴</button><div class="plan-editor-context-divider"></div><button type="button" class="plan-context-ai-action" data-plan-context-action="ai">✦ AI 修改选中内容</button>`;
      modal.append(contextMenu);
      const aiPopover = document.createElement('section');
      aiPopover.className = 'plan-editor-ai-popover';
      aiPopover.hidden = true;
      aiPopover.innerHTML = `<div class="plan-editor-ai-popover-head"><div><b>AI 修改选中内容</b><small>只会替换下方这段文字；实验事实、数据与条件不会被擅自改写。</small></div><button type="button" class="close-button" data-plan-ai-close aria-label="关闭">×</button></div><div class="plan-editor-ai-selection"></div><label class="plan-editor-ai-request"><span>修改要求</span><textarea maxlength="600" placeholder="例如：让表述更专业、条理更清晰，但不要改变实验条件和数据"></textarea></label><div class="plan-editor-ai-actions"><button type="button" class="secondary-button" data-plan-ai-close>取消</button><button type="button" class="primary-button" data-plan-ai-submit>开始修改</button></div>`;
      modal.append(aiPopover);
      const aiRequest = aiPopover.querySelector('textarea');
      const aiSubmit = aiPopover.querySelector('[data-plan-ai-submit]');

      const selectionInEditor = (allowCollapsed = false) => {
        const selection = window.getSelection();
        if (!selection?.rangeCount || (!allowCollapsed && selection.isCollapsed)) return null;
        const range = selection.getRangeAt(0);
        return editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
      };
      const restoreSavedRange = () => {
        if (!savedRange || !editor.contains(savedRange.commonAncestorContainer)) return false;
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(savedRange);
        editor.focus({ preventScroll: true });
        return true;
      };
      const hideContextMenu = () => { contextMenu.hidden = true; };
      const hideAiPopover = () => {
        aiPopover.hidden = true;
        aiRequest.value = '';
      };
      const insertPlainTextAtSavedRange = text => {
        if (!restoreSavedRange()) return false;
        const range = savedRange;
        const fragment = document.createDocumentFragment();
        const tail = document.createTextNode('');
        const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
        lines.forEach((line, index) => {
          if (index) fragment.append(document.createElement('br'));
          fragment.append(document.createTextNode(line));
        });
        fragment.append(tail);
        range.deleteContents();
        range.insertNode(fragment);
        const nextRange = document.createRange();
        nextRange.setStartAfter(tail);
        nextRange.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(nextRange);
        savedRange = nextRange.cloneRange();
        savedText = String(text || '');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      const showContextMenu = event => {
        const range = selectionInEditor();
        savedRange = range || selectionInEditor(true);
        savedText = range ? range.toString().trim() : '';
        event.preventDefault();
        contextMenu.querySelector('[data-plan-context-action="copy"]').disabled = !savedText;
        contextMenu.querySelector('[data-plan-context-action="cut"]').disabled = !savedText;
        contextMenu.querySelector('[data-plan-context-action="ai"]').disabled = !savedText || aiBusy;
        contextMenu.hidden = false;
        contextMenu.style.left = `${event.clientX}px`;
        contextMenu.style.top = `${event.clientY}px`;
        requestAnimationFrame(() => {
          const box = contextMenu.getBoundingClientRect();
          contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - box.width - 8))}px`;
          contextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - box.height - 8))}px`;
        });
      };
      const openAiPopover = () => {
        if (!savedRange || !savedText) { toast('请先选中需要修改的文字'); return; }
        hideContextMenu();
        aiPopover.querySelector('.plan-editor-ai-selection').textContent = savedText.length > 360 ? `${savedText.slice(0, 360)}…` : savedText;
        aiPopover.hidden = false;
        aiRequest.focus();
      };
      const copySelectedText = async () => {
        if (!savedText || !restoreSavedRange()) { toast('请先选中需要复制的文字'); return; }
        let copied = false;
        try { copied = document.execCommand('copy'); } catch (_) { /* 尝试现代剪贴板 API */ }
        if (!copied && navigator.clipboard?.writeText) {
          try { await navigator.clipboard.writeText(savedText); copied = true; } catch (_) { /* 浏览器可能禁止读取剪贴板 */ }
        }
        hideContextMenu();
        if (!copied) toast('浏览器未允许复制，请使用 Ctrl+C');
      };
      const cutSelectedText = async () => {
        if (!savedText || !restoreSavedRange()) { toast('请先选中需要剪切的文字'); return; }
        let cut = false;
        try { cut = document.execCommand('cut'); } catch (_) { /* 尝试现代剪贴板 API */ }
        if (!cut && navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(savedText);
            cut = insertPlainTextAtSavedRange('');
          } catch (_) { /* 浏览器可能禁止写入剪贴板 */ }
        }
        hideContextMenu();
        if (!cut) toast('浏览器未允许剪切，请使用 Ctrl+X');
      };
      const pastePlainText = async () => {
        let text = '';
        try { text = await navigator.clipboard?.readText(); } catch (_) { /* 浏览器可能拒绝读取剪贴板 */ }
        if (!text) { toast('浏览器未允许读取剪贴板，请使用 Ctrl+V'); hideContextMenu(); return; }
        if (!savedRange) savedRange = selectionInEditor(true);
        if (!savedRange || !insertPlainTextAtSavedRange(text)) toast('请先在方案正文中放置光标或选中文字');
        hideContextMenu();
      };
      editor.addEventListener('contextmenu', showContextMenu);
      editor.addEventListener('scroll', hideContextMenu);
      contextMenu.addEventListener('mousedown', event => event.preventDefault());
      contextMenu.addEventListener('click', event => {
        const action = event.target.closest('[data-plan-context-action]')?.dataset.planContextAction;
        if (action === 'copy') copySelectedText();
        if (action === 'cut') cutSelectedText();
        if (action === 'paste') pastePlainText();
        if (action === 'ai') openAiPopover();
      });
      aiPopover.querySelectorAll('[data-plan-ai-close]').forEach(button => button.addEventListener('click', () => {
        if (!aiBusy) hideAiPopover();
      }));
      aiSubmit.addEventListener('click', async () => {
        const request = aiRequest.value.trim();
        if (!request) { toast('请先输入希望 AI 如何修改'); aiRequest.focus(); return; }
        if (!savedRange || !savedText) { toast('原选中文字已失效，请重新选中后再试'); hideAiPopover(); return; }
        aiBusy = true;
        aiSubmit.disabled = true;
        aiSubmit.textContent = 'AI 修改中…';
        editor.setAttribute('contenteditable', 'false');
        try {
          const result = (await askModel([
            { role: 'system', content: '你是严谨的中文科研实验方案编辑。只根据用户的修改要求改善所给选中文字的表达、结构或清晰度。绝对不得虚构、删除、替换或改变实验事实、数据、单位、条件、观察现象、样品编号、时间、结论、风险、限制或不确定性；信息不足时保留原样。仅返回可直接替换选中文字的纯文本；可保留必要换行，不要添加 Markdown 标记、代码块、标题、说明或引号。' },
            { role: 'user', content: `修改要求：${request}\n\n选中文字：\n${savedText}` }
          ])).trim();
          if (!result) throw new Error('AI 未返回可替换的内容');
          if (!insertPlainTextAtSavedRange(result)) throw new Error('选中文字已失效，请重新选中后重试');
          hideAiPopover();
          toast('AI 已按要求替换选中文字；保存后会写入 Markdown 方案书');
        } catch (error) {
          toast(`AI 修改失败：${error.message}`);
        } finally {
          aiBusy = false;
          editor.setAttribute('contenteditable', 'true');
          aiSubmit.disabled = false;
          aiSubmit.textContent = '开始修改';
        }
      });
      modal.addEventListener('pointerdown', event => {
        if (!contextMenu.contains(event.target) && event.target !== editor) hideContextMenu();
      });
      modal.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          hideContextMenu();
          if (!aiBusy) hideAiPopover();
        }
      });
      $('savePlanContentButton').addEventListener('click', async () => {
        const content = richPlanEditorToMarkdown(editor);
        if (!content) { toast('请填写实验方案正文'); return; }
        const button = $('savePlanContentButton');
        button.disabled = true;
        button.textContent = '保存中…';
        try {
          const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/content`, {
            method: 'PUT', body: JSON.stringify({ planContent: planContentWithStyle(content, { font: $('planEditorFont').value, fontSize: Number($('planEditorSize').value), layout: $('planEditorLayout').value }), subexperimentId })
          });
          R.plans = R.plans.map(item => item.id === response.plan.id ? response.plan : item);
          await loadAgents();
          closeModal();
          renderPlansView();
          openPlanBookPage(planId, subexperimentId);
          toast('实验方案书已保存');
        } catch (error) {
          toast(`保存方案失败：${error.message}`);
        } finally {
          const current = $('savePlanContentButton');
          if (current) { current.disabled = false; current.textContent = '保存并查看方案书'; }
        }
      });
    });
  }

  function planEditorForBook(book) {
    const editor = R.planEditor;
    return editor && editor.planId === book?.planId && editor.subexperimentId === book?.subexperimentId ? editor : null;
  }

  function planEditorSidePanelMarkup(editor) {
    const presentation = editor.presentation || PLAN_STYLE_DEFAULT;
    const editorStyle = `font-family:${esc(presentation.font)},sans-serif;font-size:${presentation.fontSize}pt`;
    const fontOptions = PLAN_FONT_OPTIONS.map(([value, label]) => `<option value="${esc(value)}" ${value === presentation.font ? 'selected' : ''}>${esc(label)}</option>`).join('');
    const sizeOptions = [9, 10, 11, 12, 13, 14, 16].map(size => `<option value="${size}" ${size === presentation.fontSize ? 'selected' : ''}>${size} pt</option>`).join('');
    const layoutOptions = PLAN_LAYOUT_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === presentation.layout ? 'selected' : ''}>${label}</option>`).join('');
    return `<aside id="planEditorPanel" class="plan-display-controls plan-editor-side-panel"><div><p class="eyebrow">编辑模式</p><h2>编辑方案书</h2><p>左侧会同步显示当前内容的 A4 分页效果；保存后只会写入 Markdown 与版式设置。</p></div><div class="plan-editor-toolbar" role="toolbar" aria-label="方案书编辑工具"><label>字体 <select id="planEditorFont">${fontOptions}</select></label><label>字号 <select id="planEditorSize">${sizeOptions}</select></label><label>排版 <select id="planEditorLayout">${layoutOptions}</select></label><span class="plan-editor-divider"></span><button type="button" data-plan-editor-command="bold" title="加粗"><b>B</b></button><button type="button" data-plan-editor-command="italic" title="斜体"><i>I</i></button><button type="button" data-plan-editor-command="insertUnorderedList" title="无序列表">• 列表</button><button type="button" data-plan-editor-command="insertOrderedList" title="有序列表">1. 列表</button><button type="button" data-plan-editor-command="undo" title="撤销">↶</button><button type="button" data-plan-editor-command="redo" title="重做">↷</button></div><p class="plan-editor-hint">可直接输入、删除和调整结构。外部内容会以纯文本粘贴，避免混入 Word 格式；选中文字后右键可复制、剪切、粘贴或让 AI 修改该段。</p><div id="planContentEditor" class="plan-rich-editor execution-document-body" data-layout="${presentation.layout}" contenteditable="true" role="textbox" aria-multiline="true" style="${editorStyle}">${executionPlanHtml(editor.content || '')}</div><section id="planEditorAiPopover" class="plan-editor-ai-popover" hidden><div class="plan-editor-ai-popover-head"><div><b>AI 修改选中内容</b><small>只会替换选中的文字；实验事实、数据与条件不会被擅自改写。</small></div><button type="button" class="close-button" data-plan-ai-close aria-label="关闭">×</button></div><div class="plan-editor-ai-selection"></div><label class="plan-editor-ai-request"><span>修改要求</span><textarea maxlength="600" placeholder="例如：让表述更专业、条理更清晰，但不要改变实验条件和数据"></textarea></label><div class="plan-editor-ai-actions"><button type="button" class="secondary-button" data-plan-ai-close>取消</button><button type="button" class="primary-button" data-plan-ai-submit>开始修改</button></div></section><div class="plan-editor-side-actions"><button id="cancelPlanEditingButton" type="button" class="secondary-button">取消编辑</button><button id="savePlanContentButton" type="button" class="primary-button">保存方案书</button></div></aside>`;
  }

  async function openPlanContentEditor(planId, subexperimentId = '') {
    const plan = R.plans.find(item => item.id === planId);
    if (!plan || !R.active) { toast('未找到实验方案'); return; }
    const scopeQuery = subexperimentId ? `?subexperimentId=${encodeURIComponent(subexperimentId)}` : '';
    try {
      const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/content${scopeQuery}`);
      R.planEditor?.dispose?.();
      R.planEditor = {
        planId,
        subexperimentId,
        content: editablePlanContent(response.content || ''),
        presentation: planPresentationStyle(response.content || ''),
        dispose: null
      };
      await renderPlanBookView();
    } catch (error) {
      toast(`读取方案正文失败：${error.message}`);
    }
  }

  function bindPlanContentEditor({ plan, scope, book, editorState, refreshPreview }) {
    const panel = $('planEditorPanel');
    const editor = $('planContentEditor');
    if (!panel || !editor) return;
    const font = $('planEditorFont');
    const size = $('planEditorSize');
    const layout = $('planEditorLayout');
    const aiPopover = $('planEditorAiPopover');
    const aiRequest = aiPopover.querySelector('textarea');
    const aiSubmit = aiPopover.querySelector('[data-plan-ai-submit]');
    let savedRange = null;
    let savedText = '';
    let aiBusy = false;
    const contextMenu = document.createElement('div');
    contextMenu.className = 'plan-editor-context-menu';
    contextMenu.dataset.planEditorTransient = 'true';
    contextMenu.hidden = true;
    contextMenu.innerHTML = `<button type="button" data-plan-context-action="copy">复制</button><button type="button" data-plan-context-action="cut">剪切</button><button type="button" data-plan-context-action="paste">粘贴</button><div class="plan-editor-context-divider"></div><button type="button" class="plan-context-ai-action" data-plan-context-action="ai">✦ AI 修改选中内容</button>`;
    document.body.append(contextMenu);

    const updatePreview = () => {
      editorState.content = richPlanEditorToMarkdown(editor);
      refreshPreview();
    };
    const applyPresentation = () => {
      editorState.presentation = { font: font.value, fontSize: Number(size.value), layout: layout.value };
      editor.style.fontFamily = editorState.presentation.font;
      editor.style.fontSize = `${editorState.presentation.fontSize}pt`;
      editor.dataset.layout = editorState.presentation.layout;
      book.layoutMode = editorState.presentation.layout;
      refreshPreview();
    };
    font.addEventListener('change', applyPresentation);
    size.addEventListener('change', applyPresentation);
    layout.addEventListener('change', applyPresentation);
    panel.querySelectorAll('[data-plan-editor-command]').forEach(button => button.addEventListener('click', () => {
      editor.focus();
      document.execCommand(button.dataset.planEditorCommand, false);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    editor.addEventListener('input', updatePreview);
    editor.addEventListener('paste', event => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') || '';
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const selectionInEditor = (allowCollapsed = false) => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || (!allowCollapsed && selection.isCollapsed)) return null;
      const range = selection.getRangeAt(0);
      return editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
    };
    const restoreSavedRange = () => {
      if (!savedRange || !editor.contains(savedRange.commonAncestorContainer)) return false;
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(savedRange);
      editor.focus({ preventScroll: true });
      return true;
    };
    const hideContextMenu = () => { contextMenu.hidden = true; };
    const hideAiPopover = () => { aiPopover.hidden = true; aiRequest.value = ''; };
    const insertPlainTextAtSavedRange = text => {
      if (!restoreSavedRange()) return false;
      const range = savedRange;
      const fragment = document.createDocumentFragment();
      const tail = document.createTextNode('');
      String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
        if (index) fragment.append(document.createElement('br'));
        fragment.append(document.createTextNode(line));
      });
      fragment.append(tail);
      range.deleteContents();
      range.insertNode(fragment);
      const nextRange = document.createRange();
      nextRange.setStartAfter(tail);
      nextRange.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(nextRange);
      savedRange = nextRange.cloneRange();
      savedText = String(text || '');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const showContextMenu = event => {
      const range = selectionInEditor();
      savedRange = range || selectionInEditor(true);
      savedText = range ? range.toString().trim() : '';
      event.preventDefault();
      contextMenu.querySelector('[data-plan-context-action="copy"]').disabled = !savedText;
      contextMenu.querySelector('[data-plan-context-action="cut"]').disabled = !savedText;
      contextMenu.querySelector('[data-plan-context-action="ai"]').disabled = !savedText || aiBusy;
      contextMenu.hidden = false;
      contextMenu.style.left = `${event.clientX}px`;
      contextMenu.style.top = `${event.clientY}px`;
      requestAnimationFrame(() => {
        const box = contextMenu.getBoundingClientRect();
        contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - box.width - 8))}px`;
        contextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - box.height - 8))}px`;
      });
    };
    const copySelectedText = async () => {
      if (!savedText || !restoreSavedRange()) { toast('请先选中需要复制的文字'); return; }
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_) { /* 尝试现代剪贴板 API */ }
      if (!copied && navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(savedText); copied = true; } catch (_) { /* 浏览器可能拒绝访问剪贴板 */ }
      }
      hideContextMenu();
      if (!copied) toast('浏览器未允许复制，请使用 Ctrl+C');
    };
    const cutSelectedText = async () => {
      if (!savedText || !restoreSavedRange()) { toast('请先选中需要剪切的文字'); return; }
      let cut = false;
      try { cut = document.execCommand('cut'); } catch (_) { /* 尝试现代剪贴板 API */ }
      if (!cut && navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(savedText); cut = insertPlainTextAtSavedRange(''); } catch (_) { /* 浏览器可能拒绝访问剪贴板 */ }
      }
      hideContextMenu();
      if (!cut) toast('浏览器未允许剪切，请使用 Ctrl+X');
    };
    const pastePlainText = async () => {
      let text = '';
      try { text = await navigator.clipboard?.readText(); } catch (_) { /* 浏览器可能拒绝访问剪贴板 */ }
      if (!text) { toast('浏览器未允许读取剪贴板，请使用 Ctrl+V'); hideContextMenu(); return; }
      if (!savedRange) savedRange = selectionInEditor(true);
      if (!savedRange || !insertPlainTextAtSavedRange(text)) toast('请先在方案正文中放置光标或选中文字');
      hideContextMenu();
    };
    const openAiPopover = () => {
      if (!savedRange || !savedText) { toast('请先选中需要修改的文字'); return; }
      hideContextMenu();
      aiPopover.querySelector('.plan-editor-ai-selection').textContent = savedText.length > 360 ? `${savedText.slice(0, 360)}…` : savedText;
      aiPopover.hidden = false;
      aiRequest.focus();
    };
    editor.addEventListener('contextmenu', showContextMenu);
    editor.addEventListener('scroll', hideContextMenu);
    contextMenu.addEventListener('mousedown', event => event.preventDefault());
    contextMenu.addEventListener('click', event => {
      const action = event.target.closest('[data-plan-context-action]')?.dataset.planContextAction;
      if (action === 'copy') copySelectedText();
      if (action === 'cut') cutSelectedText();
      if (action === 'paste') pastePlainText();
      if (action === 'ai') openAiPopover();
    });
    aiPopover.querySelectorAll('[data-plan-ai-close]').forEach(button => button.addEventListener('click', () => {
      if (!aiBusy) hideAiPopover();
    }));
    aiSubmit.addEventListener('click', async () => {
      const request = aiRequest.value.trim();
      if (!request) { toast('请先输入希望 AI 如何修改'); aiRequest.focus(); return; }
      if (!savedRange || !savedText) { toast('原选中文字已失效，请重新选中后再试'); hideAiPopover(); return; }
      aiBusy = true;
      aiSubmit.disabled = true;
      aiSubmit.textContent = 'AI 修改中…';
      editor.setAttribute('contenteditable', 'false');
      try {
        const result = (await askModel([
          { role: 'system', content: '你是严谨的中文科研实验方案编辑。只根据用户的修改要求改善所给选中文字的表达、结构或清晰度。绝对不得虚构、删除、替换或改变实验事实、数据、单位、条件、观察现象、样品编号、时间、结论、风险、限制或不确定性；信息不足时保留原样。仅返回可直接替换选中文字的纯文本；可保留必要换行，不要添加 Markdown 标记、代码块、标题、说明或引号。' },
          { role: 'user', content: `修改要求：${request}\n\n选中文字：\n${savedText}` }
        ])).trim();
        if (!result) throw new Error('AI 未返回可替换的内容');
        if (!insertPlainTextAtSavedRange(result)) throw new Error('选中文字已失效，请重新选中后重试');
        hideAiPopover();
        toast('AI 已按要求替换选中文字；保存后会写入 Markdown 方案书');
      } catch (error) {
        toast(`AI 修改失败：${error.message}`);
      } finally {
        aiBusy = false;
        editor.setAttribute('contenteditable', 'true');
        aiSubmit.disabled = false;
        aiSubmit.textContent = '开始修改';
      }
    });
    const dismissContextMenu = event => {
      if (!contextMenu.contains(event.target) && event.target !== editor) hideContextMenu();
    };
    document.addEventListener('pointerdown', dismissContextMenu);
    const leaveEditing = () => {
      editorState.dispose?.();
      if (R.planEditor === editorState) R.planEditor = null;
      renderPlanBookView();
    };
    $('cancelPlanEditingButton').addEventListener('click', leaveEditing);
    $('savePlanContentButton').addEventListener('click', async () => {
      const content = richPlanEditorToMarkdown(editor);
      if (!content) { toast('请填写实验方案正文'); return; }
      editorState.content = content;
      const button = $('savePlanContentButton');
      button.disabled = true;
      button.textContent = '保存中…';
      try {
        const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(plan.id)}/content`, {
          method: 'PUT',
          body: JSON.stringify({ planContent: planContentWithStyle(content, editorState.presentation), subexperimentId: editorState.subexperimentId })
        });
        R.plans = R.plans.map(item => item.id === response.plan.id ? response.plan : item);
        book.layoutMode = editorState.presentation.layout;
        editorState.dispose?.();
        if (R.planEditor === editorState) R.planEditor = null;
        await loadAgents();
        await renderPlanBookView();
        toast('实验方案书已保存');
      } catch (error) {
        toast(`保存方案失败：${error.message}`);
      } finally {
        const current = $('savePlanContentButton');
        if (current) { current.disabled = false; current.textContent = '保存方案书'; }
      }
    });
    editorState.dispose = () => {
      contextMenu.remove();
      document.removeEventListener('pointerdown', dismissContextMenu);
    };
    refreshPreview();
  }

  function inlineExecutionHtml(value) {
    return esc(value)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/_(.+?)_/g, '<em>$1</em>');
  }

  function executionPlanHtml(content) {
    const blocks = [];
    let list = null;
    let currentSection = '';
    const flushList = () => {
      if (!list) return;
      blocks.push(`<${list.type} class="execution-list${list.materials ? ' materials-list' : ''}">${list.items.map(item => `<li>${inlineExecutionHtml(item)}</li>`).join('')}</${list.type}>`);
      list = null;
    };
    editablePlanContent(content).split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('<!--')) { flushList(); return; }
      if (line === '---' || line === '***') { flushList(); blocks.push('<hr />'); return; }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushList();
        if (heading[1].length === 3) currentSection = heading[2].replace(/[*_`]/g, '').trim();
        const level = Math.min(heading[1].length + 1, 6);
        blocks.push(`<h${level}>${inlineExecutionHtml(heading[2])}</h${level}>`);
        return;
      }
      const bullet = line.match(/^[-*]\s+(.+)$/);
      const numbered = line.match(/^\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        const type = bullet ? 'ul' : 'ol';
        if (!list || list.type !== type) { flushList(); list = { type, items: [], materials: /(?:材料|试剂).*(?:仪器|耗材)|(?:仪器|耗材).*(?:材料|试剂)|^(?:材料|仪器|试剂|耗材)$/.test(currentSection) }; }
        list.items.push((bullet || numbered)[1]);
        return;
      }
      flushList();
      if (line.startsWith('> ')) { blocks.push(`<aside>${inlineExecutionHtml(line.slice(2))}</aside>`); return; }
      blocks.push(`<p>${inlineExecutionHtml(line)}</p>`);
    });
    flushList();
    return blocks.join('') || '<div class="execution-empty">尚未生成实验执行方案。请先导入资料并使用 AI 生成，或编辑方案正文后保存。</div>';
  }

  function richPlanInlineToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const children = [...node.childNodes].map(richPlanInlineToMarkdown).join('');
    if (node.tagName === 'STRONG' || node.tagName === 'B') return `**${children}**`;
    if (node.tagName === 'EM' || node.tagName === 'I') return `_${children}_`;
    if (node.tagName === 'CODE') return `\`${children}\``;
    if (node.tagName === 'BR') return '\n';
    return children;
  }

  function richPlanEditorToMarkdown(editor) {
    const blockToMarkdown = node => {
      if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').trim();
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const inline = richPlanInlineToMarkdown(node).replace(/\u00a0/g, ' ').trim();
      const tag = node.tagName;
      if (/^H[2-6]$/.test(tag)) return `${'#'.repeat(Number(tag.slice(1)) - 1)} ${inline}`;
      if (tag === 'P') return inline;
      if (tag === 'ASIDE') return inline ? `> ${inline}` : '';
      if (tag === 'HR') return '---';
      if (tag === 'UL' || tag === 'OL') return [...node.children].filter(item => item.tagName === 'LI').map((item, index) => `${tag === 'OL' ? `${index + 1}.` : '-'} ${richPlanInlineToMarkdown(item).replace(/\u00a0/g, ' ').trim()}`).join('\n');
      if (tag === 'DIV') return [...node.childNodes].map(blockToMarkdown).filter(Boolean).join('\n\n') || inline;
      return inline;
    };
    return [...editor.childNodes].map(blockToMarkdown).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function planScopeDetails(plan, subexperimentId = '') {
    const subexperiment = plan?.subexperiments?.find(item => item.id === subexperimentId);
    return {
      subexperiment,
      title: subexperiment ? `${plan.name} · ${subexperiment.name}` : `${plan?.name || '实验方案'} · ${plan?.version || ''}`,
      query: subexperimentId ? `?subexperimentId=${encodeURIComponent(subexperimentId)}` : ''
    };
  }

  function planDisplaySections(content) {
    const seen = new Set();
    return editablePlanContent(content).split(/\r?\n/).map(line => line.trim().match(/^###\s+(.+)$/)).filter(Boolean).map(match => {
      const title = match[1].replace(/[*_`]/g, '').trim();
      return { key: title, title };
    }).filter(section => section.key && !seen.has(section.key) && (seen.add(section.key) || true));
  }

  function selectedPlanSections(book, sections) {
    const available = new Set(sections.map(section => section.key));
    if (!Array.isArray(book.selectedSections)) book.selectedSections = sections.map(section => section.key);
    else book.selectedSections = book.selectedSections.filter(section => available.has(section));
    return book.selectedSections;
  }

  function visiblePlanContent(content, selectedSections) {
    const lines = editablePlanContent(content).split(/\r?\n/);
    const hasSections = lines.some(line => /^###\s+/.test(line.trim()));
    if (!hasSections) return editablePlanContent(content);
    let current = null;
    const visible = [];
    for (const line of lines) {
      const heading = line.trim().match(/^###\s+(.+)$/);
      if (heading) current = heading[1].replace(/[*_`]/g, '').trim();
      if (current && selectedSections.includes(current)) visible.push(line);
    }
    return visible.join('\n').replace(/^\s+|\s+$/g, '');
  }

  function planStyleAttribute(style) {
    const font = PLAN_FONT_OPTIONS.find(([value]) => value === style.font)?.[0] || PLAN_STYLE_DEFAULT.font;
    const fontSize = [9, 10, 11, 12, 13, 14, 16].includes(Number(style.fontSize)) ? Number(style.fontSize) : PLAN_STYLE_DEFAULT.fontSize;
    return `--execution-font:${esc(font)},sans-serif;--execution-size:${fontSize}pt`;
  }

  function planLayoutMode(style, book) {
    return PLAN_LAYOUT_OPTIONS.some(([value]) => value === book?.layoutMode)
      ? book.layoutMode
      : (PLAN_LAYOUT_OPTIONS.some(([value]) => value === style?.layout) ? style.layout : PLAN_STYLE_DEFAULT.layout);
  }

  function planRecordSheetHtml() {
    const rows = Array.from({ length: 7 }, () => '<tr><td></td><td></td><td></td><td></td></tr>').join('');
    return `<section class="execution-record-sheet"><h2>实验记录表</h2><p>用于执行本方案时同步记录关键参数、现象和原始数据。</p><table><tbody><tr><th>实验日期</th><td></td></tr><tr><th>执行人</th><td></td></tr><tr><th>样品 / 批次</th><td></td></tr><tr><th>仪器 / 设备</th><td></td></tr></tbody></table><h3>步骤与数据记录</h3><table class="execution-record-table"><thead><tr><th>步骤</th><th>执行时间</th><th>关键参数、现象与原始数据</th><th>签名</th></tr></thead><tbody>${rows}</tbody></table><h3>偏差与处理</h3><table class="execution-record-table"><thead><tr><th>发现时间</th><th colspan="2">偏差或异常与处理措施</th><th>复核人</th></tr></thead><tbody><tr><td></td><td colspan="2"></td><td></td></tr><tr><td></td><td colspan="2"></td><td></td></tr></tbody></table></section>`;
  }

  function planA4PageMarkup(plan, scope, presentation, layoutMode, pageNumber, firstPage = false, recordSheet = false) {
    const title = firstPage
      ? `<div class="execution-title-block"><p>实验方案书</p><h1>${esc(scope.title)}</h1>${plan.description ? `<div>${esc(plan.description)}</div>` : ''}</div>`
      : `<div class="execution-continuation-title"><span>${esc(scope.title)}</span><small>${recordSheet ? '实验记录表' : '方案正文续页'}</small></div>`;
    return `<article class="execution-a4-page${recordSheet ? ' execution-record-sheet-page' : ''}" data-execution-plan-page data-layout="${layoutMode}" style="${planStyleAttribute(presentation)}"><div class="execution-running-head"><span>SciHub · 实验方案书</span><span>${esc(plan.version || '')}</span></div>${title}<div class="execution-document-body"></div><div class="execution-page-foot">SciHub 本地科研记录工作台 <span>· 第 ${pageNumber} 页</span></div></article>`;
  }

  function renderPlanA4Pages(host, { plan, scope, presentation, layoutMode, content, includeRecordSheet }) {
    if (!host) return;
    host.innerHTML = '';
    const source = document.createElement('template');
    source.innerHTML = executionPlanHtml(content);
    const blocks = [...source.content.children];
    let pageNumber = 0;
    let page;
    let body;
    const addPage = (firstPage = false, recordSheet = false) => {
      pageNumber += 1;
      host.insertAdjacentHTML('beforeend', planA4PageMarkup(plan, scope, presentation, layoutMode, pageNumber, firstPage, recordSheet));
      page = host.lastElementChild;
      body = page.querySelector('.execution-document-body');
      return body;
    };
    const overflowing = () => body.scrollHeight > body.clientHeight + 1;
    const placeListAcrossPages = list => {
      const items = [...list.children];
      let fragment = list.cloneNode(false);
      body.append(fragment);
      for (const item of items) {
        fragment.append(item);
        if (overflowing() && fragment.children.length > 1) {
          fragment.removeChild(item);
          addPage();
          fragment = list.cloneNode(false);
          body.append(fragment);
          fragment.append(item);
        }
      }
    };
    const placeBlock = block => {
      body.append(block);
      if (!overflowing()) return;
      if (body.children.length === 1) {
        if (!['UL', 'OL'].includes(block.tagName) || block.children.length < 2) return;
        body.removeChild(block);
        placeListAcrossPages(block);
        return;
      }
      body.removeChild(block);
      addPage();
      body.append(block);
      if (!overflowing() || !['UL', 'OL'].includes(block.tagName) || block.children.length < 2) return;
      body.removeChild(block);
      placeListAcrossPages(block);
    };
    addPage(true);
    blocks.forEach(placeBlock);
    if (includeRecordSheet) {
      addPage(false, true);
      body.innerHTML = planRecordSheetHtml();
    }
  }

  function planSectionControlsMarkup(sections, selectedSections, includeRecordSheet, layoutMode) {
    const options = sections.map(section => `<label><input type="checkbox" data-plan-section value="${esc(section.key)}" ${selectedSections.includes(section.key) ? 'checked' : ''} /><span>${esc(section.title)}</span></label>`).join('');
    const layoutOptions = PLAN_LAYOUT_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === layoutMode ? 'selected' : ''}>${label}</option>`).join('');
    return `<aside class="plan-display-controls"><div><p class="eyebrow">输出内容</p><h2>显示板块</h2><p>勾选的内容会立即显示在中间预览，并随导出方案一同保留。</p></div><label class="plan-layout-mode"><span>排版模式</span><select id="planLayoutMode">${layoutOptions}</select><small>紧凑模式会压缩材料、仪器等清单；宽松模式保持逐项清晰。</small></label><div class="plan-display-options">${options}</div><label class="plan-record-sheet-toggle"><input id="planRecordSheetToggle" type="checkbox" ${includeRecordSheet ? 'checked' : ''} /><span><b>附带实验记录表</b><small>生成可打印填写的步骤、数据与偏差记录表。</small></span></label></aside>`;
  }

  function openPlanBookPage(planId, subexperimentId = '', imported = null) {
    const plan = R.plans.find(item => item.id === planId);
    if (!plan || !R.active) { toast('未找到实验方案'); return; }
    const previous = R.planBook;
    const sameBook = previous?.planId === planId && previous?.subexperimentId === subexperimentId;
    R.planBook = { planId, subexperimentId, imported, selectedSections: sameBook ? previous.selectedSections : null, includeRecordSheet: sameBook ? Boolean(previous.includeRecordSheet) : false, layoutMode: sameBook ? previous.layoutMode : null };
    window.switchView('planBook');
  }

  function planTaskElapsed(task) {
    const seconds = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function runningPlanTaskFor(book) {
    const task = R.planGeneration;
    if (!task || task.status !== 'running' || task.projectSlug !== R.active?.slug) return null;
    return task.planId === book.planId && task.subexperimentId === book.subexperimentId ? task : null;
  }

  function planGenerationMarkup(task) {
    return `<div class="plan-book-generating" role="status" aria-live="polite"><div class="plan-book-generating-orbit" aria-hidden="true"></div><p class="eyebrow">AI 任务正在运行</p><h2>正在生成实验方案书</h2><p>正在按统一模板整理实验目的、设计、材料、步骤、记录与风险。你可以切换页面，任务会继续在当前网站中运行。</p><div class="plan-book-task-time">已运行 <b data-plan-task-elapsed>${planTaskElapsed(task)}</b></div><div class="plan-book-task-progress" aria-hidden="true"><span></span></div><p class="plan-book-task-note">请保持本网站打开；关闭或刷新页面会中断本次生成。</p></div>`;
  }

  function renderPlanTaskBanner() {
    const task = R.planGeneration;
    const isHome = currentView() === 'home';
    [$('planTaskBanner'), $('planTaskFloatingBanner')].filter(Boolean).forEach(banner => {
      const isFloating = banner.id === 'planTaskFloatingBanner';
      const show = Boolean(task?.status === 'running') && (isFloating ? isHome : !isHome);
      if (!show) {
        banner.hidden = true;
        banner.innerHTML = '';
        return;
      }
      banner.hidden = false;
      banner.title = `正在生成：${task.title}。点击返回任务。`;
      banner.innerHTML = `<span class="plan-task-spinner" aria-hidden="true"></span><span class="plan-task-banner-copy"><span>正在生成实验方案书</span><small>${esc(task.title)} · 已运行 <b data-plan-task-elapsed>${planTaskElapsed(task)}</b></small></span><span class="plan-task-open" aria-hidden="true">↗</span>`;
      banner.onclick = () => { openPlanGenerationTask(); };
    });
  }

  function refreshPlanTaskStatus() {
    const task = R.planGeneration;
    if (!task || task.status !== 'running') return;
    document.querySelectorAll('[data-plan-task-elapsed]').forEach(node => { node.textContent = planTaskElapsed(task); });
  }

  function startPlanTaskTicker(task) {
    renderPlanTaskBanner();
    refreshPlanTaskStatus();
    task.timerId = window.setInterval(refreshPlanTaskStatus, 1000);
  }

  function stopPlanTask(task) {
    if (task?.timerId) window.clearInterval(task.timerId);
    if (R.planGeneration === task) R.planGeneration = null;
    renderPlanTaskBanner();
  }

  async function openPlanGenerationTask() {
    const task = R.planGeneration;
    if (!task || task.status !== 'running') return;
    R.planBook = { planId: task.planId, subexperimentId: task.subexperimentId, imported: task.imported };
    if (R.active?.slug !== task.projectSlug) {
      await loadProject(task.projectSlug);
      renderProjectSidebar();
    }
    if (!R.active) { toast('无法打开正在生成的实验方案书。'); return; }
    window.switchView('planBook');
  }

  function notifyPlanGenerationFinished(task) {
    const message = `实验方案书已生成：${task.title}`;
    toast(message);
    document.title = `已完成 · ${task.title} · SciHub`;
    if (window.Notification && window.Notification.permission === 'granted') {
      new window.Notification('SciHub 实验方案书已生成', { body: task.title });
    }
  }

  async function renderPlanBookView() {
    const book = R.planBook;
    const host = $('planBookBody');
    if (!book || !host || !R.active) { window.switchView('plans'); return; }
    const plan = R.plans.find(item => item.id === book.planId);
    if (!plan) { toast('未找到实验方案'); window.switchView('plans'); return; }
    const scope = planScopeDetails(plan, book.subexperimentId);
    const editorState = planEditorForBook(book);
    host.innerHTML = '<div class="empty-state"><span>◌</span><strong>正在载入实验方案书…</strong></div>';
    let content = '';
    let rawContent = '';
    if (editorState) {
      content = editorState.content;
      rawContent = planContentWithStyle(content, editorState.presentation);
    } else {
      try {
        const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(book.planId)}/content${scope.query}`);
        rawContent = response.content || '';
        content = editablePlanContent(rawContent);
      } catch (error) {
        host.innerHTML = `<div class="empty-state"><span>!</span><strong>无法读取实验方案书</strong><p>${esc(error.message)}</p></div>`;
        return;
      }
    }
    const imported = book.imported;
    const task = runningPlanTaskFor(book);
    const sections = planDisplaySections(content);
    const selectedSections = selectedPlanSections(book, sections);
    const presentation = planPresentationStyle(rawContent);
    const isEditing = Boolean(editorState && !imported && !task);
    const layoutMode = isEditing ? editorState.presentation.layout : planLayoutMode(presentation, book);
    const sourceAction = task
      ? planGenerationMarkup(task)
      : imported
      ? `<div class="plan-book-source"><p class="eyebrow">已导入方案资料</p><h2>准备生成实验方案书</h2><p>资料已转换为 Markdown 并保存到 <b>${esc(imported.storedPath || '导入资料')}</b>。点击下方按钮后，AI 会依照统一模板整理为实验目的、设计、材料、步骤、记录与风险等板块。${content ? '生成后将替换当前方案书。' : ''}</p><button id="generatePlanBookButton" type="button" class="primary-button">生成实验方案书</button></div>`
      : content
        ? `<div class="plan-book-preview-layout"><div class="plan-a4-preview-wrap"><div id="executionPlanPages" class="execution-a4-pages"></div></div>${isEditing ? planEditorSidePanelMarkup(editorState) : planSectionControlsMarkup(sections, selectedSections, book.includeRecordSheet, layoutMode)}</div>`
        : '<div class="plan-book-empty"><h2>尚未导入方案资料</h2><p>请使用右上角的“导入方案资料”，系统会先转换为 Markdown，再按统一模板生成可执行的实验方案书。</p></div>';
    const currentContentReady = Boolean(content && !imported && !task);
    host.innerHTML = `<div class="plan-book-shell"><div class="plan-book-top"><div><p class="eyebrow">实验方案书 · A4 预览</p><h1>${esc(scope.title)}</h1><p>${isEditing ? '正在页内编辑：左侧预览会随输入同步更新。' : '此页面展示排版后的方案书，不直接展示 Markdown 源文件。'}</p></div><div class="plan-book-actions"><button id="backToPlansButton" class="secondary-button" type="button">← 返回实验方案</button>${task ? '' : '<button id="importPlanBookButton" class="secondary-button" type="button">⇧ 导入方案资料</button>'}${currentContentReady ? `${isEditing ? '' : '<button id="editPlanBookButton" class="secondary-button" type="button">编辑方案书</button>'}<button id="exportPlanBookButton" class="primary-button" type="button">导出实验方案</button>` : ''}</div></div><div class="plan-book-stage">${sourceAction}</div></div>`;
    $('backToPlansButton').onclick = () => {
      editorState?.dispose?.();
      if (R.planEditor === editorState) R.planEditor = null;
      window.switchView('plans');
    };
    $('importPlanBookButton')?.addEventListener('click', () => openPlanSourceImportDialog(book.planId, book.subexperimentId));
    $('editPlanBookButton')?.addEventListener('click', () => openPlanContentEditor(book.planId, book.subexperimentId));
    $('exportPlanBookButton')?.addEventListener('click', () => openPlanExportDialog(book.planId, book.subexperimentId, book.selectedSections, book.includeRecordSheet, book.layoutMode || layoutMode));
    $('generatePlanBookButton')?.addEventListener('click', () => generatePlanBook(book, scope));
    const refreshA4Pages = () => {
      const currentContent = isEditing ? editorState.content : content;
      const currentPresentation = isEditing ? editorState.presentation : presentation;
      const currentSections = planDisplaySections(currentContent);
      const currentSelectedSections = Array.isArray(book.selectedSections)
        ? book.selectedSections.filter(section => currentSections.some(item => item.key === section))
        : currentSections.map(section => section.key);
      renderPlanA4Pages($('executionPlanPages'), {
        plan,
        scope,
        presentation: currentPresentation,
        layoutMode: isEditing ? editorState.presentation.layout : planLayoutMode(currentPresentation, book),
        content: visiblePlanContent(currentContent, currentSelectedSections),
        includeRecordSheet: Boolean(book.includeRecordSheet)
      });
    };
    if (content && !imported && !task) refreshA4Pages();
    if (isEditing) {
      bindPlanContentEditor({ plan, scope, book, editorState, refreshPreview: refreshA4Pages });
    } else {
      document.querySelectorAll('[data-plan-section]').forEach(control => control.addEventListener('change', () => {
        book.selectedSections = [...document.querySelectorAll('[data-plan-section]:checked')].map(input => input.value);
        refreshA4Pages();
      }));
      $('planRecordSheetToggle')?.addEventListener('change', event => {
        book.includeRecordSheet = event.target.checked;
        refreshA4Pages();
      });
      $('planLayoutMode')?.addEventListener('change', event => {
        book.layoutMode = event.target.value;
        refreshA4Pages();
      });
    }
  }

  function generatePlanBook(book, scope) {
    const imported = book.imported;
    if (!imported) { toast('请先导入方案资料'); return; }
    if (R.planGeneration?.status === 'running') {
      toast('已有实验方案书正在生成；已为你保留任务。');
      openPlanGenerationTask();
      return;
    }
    const task = {
      status: 'running',
      projectSlug: R.active.slug,
      planId: book.planId,
      subexperimentId: book.subexperimentId,
      imported,
      title: scope.title,
      startedAt: Date.now(),
      timerId: null,
    };
    R.planGeneration = task;
    startPlanTaskTicker(task);
    renderPlanBookView();
    runPlanGeneration(task);
  }

  async function runPlanGeneration(task) {
    try {
      const content = (await askModel(standardPlanPrompt(task.imported.markdown || task.imported.source || ''))).trim();
      if (!content) throw new Error('AI 未返回可保存的方案内容');
      const response = await api(`${slugPath(task.projectSlug)}/plans/${encodeURIComponent(task.planId)}/content`, {
        method: 'PUT', body: JSON.stringify({ planContent: content, subexperimentId: task.subexperimentId })
      });
      task.status = 'completed';
      stopPlanTask(task);
      if (R.active?.slug === task.projectSlug) {
        R.plans = R.plans.map(item => item.id === response.plan.id ? response.plan : item);
        if (R.planBook?.planId === task.planId && R.planBook?.subexperimentId === task.subexperimentId) R.planBook = { ...R.planBook, imported: null };
        await loadAgents();
        renderPlansView();
        if (currentView() === 'planBook' && R.planBook?.planId === task.planId && R.planBook?.subexperimentId === task.subexperimentId) await renderPlanBookView();
      }
      notifyPlanGenerationFinished(task);
    } catch (error) {
      task.status = 'failed';
      stopPlanTask(task);
      if (R.active?.slug === task.projectSlug && currentView() === 'planBook') renderPlanBookView();
      toast(`生成实验方案书失败：${error.message}`);
    }
  }

  function downloadPlanExport(planId, format, subexperimentId = '', includeRecordSheet = false, selectedSections = null, layoutMode = null) {
    if (!R.active || !['docx', 'pdf', 'md'].includes(format)) return;
    const plan = R.plans.find(item => item.id === planId);
    const scope = planScopeDetails(plan, subexperimentId);
    const query = new URLSearchParams();
    if (subexperimentId) query.set('subexperimentId', subexperimentId);
    if (includeRecordSheet) query.set('includeRecordSheet', 'true');
    if (Array.isArray(selectedSections)) query.set('sections', selectedSections.join('|'));
    if (PLAN_LAYOUT_OPTIONS.some(([value]) => value === layoutMode)) query.set('layout', layoutMode);
    const link = document.createElement('a');
    link.href = `${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/export/${format}?${query.toString()}`;
    link.download = `${scope.title}-实验执行方案.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast(`正在导出实验执行方案（${format.toUpperCase()}）${includeRecordSheet ? '，并附实验记录表' : ''}`);
  }

  function openPlanExportDialog(planId, subexperimentId = '', selectedSections = null, includeRecordSheet = false, layoutMode = null) {
    const plan = R.plans.find(item => item.id === planId);
    if (!plan || !R.active) { toast('未找到可导出的实验方案'); return; }
    const scope = planScopeDetails(plan, subexperimentId);
    openModal(`<div class="modal-header"><div><h2>导出实验方案</h2><p>用于实验执行、打印或归档；这不会更新项目记忆。项目记忆 MD 请使用右上角的独立导出按钮。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="planExportForm"><div class="modal-body"><div class="form-field full"><span>导出格式</span><div class="export-format-options"><label><input type="radio" name="planExportFormat" value="docx" checked /> Word（可继续编辑）</label><label><input type="radio" name="planExportFormat" value="pdf" /> PDF（打印版）</label><label><input type="radio" name="planExportFormat" value="md" /> 原生 Markdown</label></div></div><label class="export-record-sheet-option"><input id="includePlanRecordSheet" type="checkbox" ${includeRecordSheet ? 'checked' : ''} /><span><b>附带实验记录表</b><small>与预览页的选择保持一致；可在这里临时调整。</small></span></label><p class="import-tip">导出对象：<b>${esc(scope.title)}</b>。将使用预览页面当前勾选的显示板块。导出文件不会写入项目文件夹，项目内仍以 Markdown 为唯一持久格式。</p></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button type="submit" class="primary-button">开始导出</button></div></form>`, () => {
      $('planExportForm').addEventListener('submit', event => {
        event.preventDefault();
        const format = document.querySelector('input[name="planExportFormat"]:checked')?.value || 'docx';
        downloadPlanExport(planId, format, subexperimentId, $('includePlanRecordSheet').checked, selectedSections, layoutMode);
        closeModal();
      });
    });
  }

  function openSubexperimentDialog(planId) {
    openModal(`<div class="modal-header"><div><h2>新增关联子实验</h2><p>将直接创建为 V1 下的子文件夹；之后可在日志页选择它，使日志保存到该文件夹中。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="subexperimentForm"><div class="modal-body"><div class="form-grid">
        <label class="form-field full"><span>子实验名称</span><input id="subexperimentName" required placeholder="例如：不同 pH 条件" /></label>
        <label class="form-field full"><span>说明（可选）</span><textarea id="subexperimentDescription" placeholder="记录变量、样品或目的。"></textarea></label>
      </div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">创建子实验</button></div></form>`, () => {
      $('subexperimentForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('subexperimentForm').querySelector('[type=submit]');
        button.disabled = true;
        button.textContent = '创建中…';
        try {
          const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/subexperiments`, {
            method: 'POST',
            body: JSON.stringify({
              name: $('subexperimentName').value.trim(),
              description: $('subexperimentDescription').value.trim()
            })
          });
          R.plans = R.plans.map(plan => plan.id === response.plan.id ? response.plan : plan);
          closeModal();
          renderPlansView();
          toast('子实验文件夹已创建，可直接关联实验日志');
        } catch (error) {
          toast(`创建子实验失败：${error.message}`);
        } finally {
          const current = $('subexperimentForm')?.querySelector('[type=submit]');
          if (current) { current.disabled = false; current.textContent = '创建子实验'; }
        }
      });
    });
  }

  function openPlanDialog() {
    if (!R.active) { toast('请先选择或新建一个项目'); return; }
    const previous = [...R.plans].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    const previousPanel = previous
      ? `<div class="form-field full"><div class="plan-source-panel"><b>上一次方案文件</b><br>${esc(previous.relativePath || `${previous.version}/方案.md`)} · ${esc(previous.name)}<br><button type="button" class="text-button" id="loadPreviousPlan">载入作为新方案草稿</button><small>仅复制内容到当前输入框，不会修改旧方案文件。</small></div></div>`
      : `<div class="form-field full"><div class="plan-source-panel"><b>上一次方案文件</b><br>这是项目中的第一个方案；创建下一版后即可进行版本差异对比。</div></div>`;
    openModal(`<div class="modal-header"><div><h2>新建实验方案</h2><p>版本会创建为项目根目录下的文件夹，子实验会创建为其中的子文件夹。可载入上一次方案作为草稿，并用已配置的 API 模型一键润色生成新方案。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="planForm"><div class="modal-body"><div class="form-grid">
        <label class="form-field"><span>方案名称</span><input id="planName" required placeholder="例如：蛋白纯化条件筛选" /></label>
        <label class="form-field"><span>方案版本</span><input id="planVersion" required placeholder="例如：V1" /></label>
        <label class="form-field full"><span>方案说明（可选）</span><textarea id="planDescription" placeholder="记录方案目的、变量范围、判定标准等。"></textarea></label>
        ${previousPanel}
        <label class="form-field full"><span>实验方案草稿 / 生成结果（可选）</span><textarea id="planContent" style="min-height:210px" placeholder="可直接输入方案草稿，或先载入上一次方案文件。点击“AI 一键润色生成方案”后，结果会保留在这里并随新方案保存为 Markdown。"></textarea><div class="plan-ai-actions"><small>AI 仅修正错别字、表达和结构，不应虚构实验数据、条件或结论。</small><button type="button" class="secondary-button" id="polishPlanButton">✦ AI 一键润色生成方案</button></div></label>
        <label class="form-field full"><span>子实验（可选）</span><textarea id="planSubexperiments" placeholder="每行一个；可用“名称 | 说明”格式。&#10;例如：不同 pH 条件 | pH 6.5、7.0、7.5 的对照实验&#10;例如：重复验证 | 对 V1 最优条件进行三次重复"></textarea><small class="field-note">创建后子实验会成为日志的可选关联项。</small></label>
      </div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">创建方案</button></div></form>`, () => {
      $('loadPreviousPlan')?.addEventListener('click', async () => {
        try {
          const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(previous.id)}/content`);
          $('planContent').value = response.content || '';
          toast('已载入上一次方案文件作为草稿');
        } catch (error) {
          toast(`载入上一次方案失败：${error.message}`);
        }
      });
      $('polishPlanButton').addEventListener('click', async () => {
        const source = $('planContent').value.trim();
        if (!source) { toast('请先输入方案草稿，或载入上一次方案文件'); return; }
        const button = $('polishPlanButton');
        button.disabled = true;
        button.textContent = 'AI 生成中…';
        try {
          const result = await askModel([
            { role: 'system', content: '你是严谨的科研实验方案编辑。只修正错别字、语法、表达和结构，使方案清晰、专业、可执行。不得虚构或补充未提供的实验事实、数据、试剂、参数、条件、现象或结论；信息缺失时保留为待补充项。输出中文 Markdown 正文，不要 YAML front matter，也不要重复输出一级标题。' },
            { role: 'user', content: `请润色并整理以下实验方案草稿，保留原意：\n\n${source}` }
          ]);
          $('planContent').value = result.trim();
          toast('AI 已生成润色后的实验方案；确认后可创建新版本');
        } catch (error) {
          toast(`AI 生成失败：${error.message}`);
        } finally {
          button.disabled = false;
          button.textContent = '✦ AI 一键润色生成方案';
        }
      });
      $('planForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('planForm').querySelector('[type=submit]');
        const subexperiments = $('planSubexperiments').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
          const [name, ...rest] = line.split('|');
          return { name: name.trim(), description: rest.join('|').trim() };
        }).filter(item => item.name);
        button.disabled = true;
        button.textContent = '创建中…';
        try {
          const response = await api(`${slugPath(R.active.slug)}/plans`, {
            method: 'POST',
            body: JSON.stringify({
              name: $('planName').value.trim(),
              version: $('planVersion').value.trim(),
              description: $('planDescription').value.trim(),
              planContent: $('planContent').value.trim(),
              subexperiments
            })
          });
          R.plans = [response.plan, ...R.plans];
          closeModal();
          renderPlansView();
          toast('实验方案已创建；现在可以在日志中关联它或其子实验');
        } catch (error) {
          toast(`创建实验方案失败：${error.message}`);
        } finally {
          const current = $('planForm')?.querySelector('[type=submit]');
          if (current) { current.disabled = false; current.textContent = '创建方案'; }
        }
      });
    });
  }

  async function openPlanDiffDialog(planId) {
    if (!R.active) { toast('请先选择项目'); return; }
    try {
      const comparison = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(planId)}/compare`);
      if (!comparison.previous) {
        toast('这是当前项目最早创建的方案，尚无上一次方案可对比');
        return;
      }
      const diffLines = (comparison.lines || []).map(line => {
        const symbol = line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' ';
        const text = line.text ? esc(line.text) : '&nbsp;';
        return `<div class="plan-diff-line ${esc(line.kind)}"><i>${symbol}</i><span>${text}</span></div>`;
      }).join('') || '<div class="plan-diff-line same"><i>•</i><span>两个方案正文相同。</span></div>';
      openModal(`<div class="modal-header"><div><h2>方案版本改动</h2><p>对比 <b>${esc(comparison.previous.version)} · ${esc(comparison.previous.name)}</b> 与 <b>${esc(comparison.current.version)} · ${esc(comparison.current.name)}</b> 的方案正文。</p></div><button class="close-button" data-close-modal>×</button></div>
        <div class="modal-body"><div class="plan-diff-legend"><span class="old">灰色划线：上一次方案中删除或替换的内容</span><span class="new">绿色高亮：当前方案新增或替换的内容</span></div><div class="plan-diff">${diffLines}</div></div>
        <div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>关闭</button></div>`);
    } catch (error) {
      toast(`读取方案差异失败：${error.message}`);
    }
  }

  // ---------------------------------------------------------- 视图：日志 --
  function normalizeLog(log = {}) {
    const source = typeof log.source === 'string' ? log.source : '';
    const phenomena = typeof log.phenomena === 'string' ? log.phenomena : '';
    const record = typeof log.record === 'string' ? log.record : '';
    const planId = typeof log.planId === 'string' ? log.planId : '';
    const subexperimentId = typeof log.subexperimentId === 'string' ? log.subexperimentId : '';
    return {
      ...log,
      source,
      phenomena,
      record,
      images: Array.isArray(log.images) ? log.images : [],
      planId,
      planName: typeof log.planName === 'string' ? log.planName : '',
      planVersion: typeof log.planVersion === 'string' ? log.planVersion : '',
      subexperimentId,
      subexperimentName: typeof log.subexperimentName === 'string' ? log.subexperimentName : '',
      aiContext: typeof log.aiContext === 'string' ? log.aiContext : '',
      includePlanMemory: log.includePlanMemory !== false,
      formattedSource: source && (phenomena || record) ? source : ''
    };
  }

  function visibleLogSource(log) {
    if (log.source.trim()) return log.source;
    return [
      log.phenomena.trim() ? `实验现象：\n${log.phenomena.trim()}` : '',
      log.record.trim() ? `实验记录：\n${log.record.trim()}` : ''
    ].filter(Boolean).join('\n\n');
  }

  function planForLog(log = R.log) {
    return R.plans.find(plan => plan.id === log.planId) || null;
  }

  function logQuery(log = R.log) {
    const params = new URLSearchParams();
    if (log.planId) params.set('planId', log.planId);
    if (log.subexperimentId) params.set('subexperimentId', log.subexperimentId);
    const query = params.toString();
    return query ? `?${query}` : '';
  }

  function logAssociationText(log = R.log) {
    if (!log.planId) return '未关联方案';
    const plan = planForLog(log);
    const planText = plan ? `${plan.name} · ${plan.version}` : (log.planName || '已关联实验方案');
    const subexperiment = plan?.subexperiments?.find(item => item.id === log.subexperimentId);
    return subexperiment ? `${planText} · ${subexperiment.name}` : planText;
  }

  function renderLogsView() {
    if (!requireProject('logsProjectTitle', 'logsBody')) return;
    $('logsProjectTitle').textContent = R.active.name;
    const l = R.log;
    const textDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${R.date}T12:00:00`));
    const source = visibleLogSource(l);
    const hasContent = Boolean(source.trim());
    const selectedPlan = planForLog(l);
    const storagePath = logStoragePath(l, R.date);
    const planOptions = ['<option value="">不关联实验方案</option>'].concat(
      R.plans.map(plan => `<option value="${esc(plan.id)}" ${plan.id === l.planId ? 'selected' : ''}>${esc(plan.name)} · ${esc(plan.version)}</option>`)
    ).join('');
    const subexperimentOptions = ['<option value="">关联整个方案（不指定子实验）</option>'].concat(
      (selectedPlan?.subexperiments || []).map(item => `<option value="${esc(item.id)}" ${item.id === l.subexperimentId ? 'selected' : ''}>${esc(item.name)}</option>`)
    ).join('');
    $('logsBody').innerHTML = `
      <div class="record-panel">
        <div class="record-meta-row">
          <label class="record-field"><span>实验日期</span><input id="logDate" type="date" value="${R.date}" /></label>
          <label class="record-field log-association-field"><span>关联实验方案</span><select id="logPlan">${planOptions}</select></label>
          <label class="record-field log-association-field"><span>关联子实验</span><select id="logSubexperiment" ${selectedPlan ? '' : 'disabled'}>${subexperimentOptions}</select></label>
          <div class="record-association-summary"><p class="record-note">${textDate}<br><b>${esc(logAssociationText(l))}</b>；保存后会写入对应 Markdown，并更新 AGENTS.md。</p><code>关联保存路径：${esc(storagePath)}</code><small>需要更换保存位置时，在上方切换实验方案或子实验；路径会随选择立即更新。</small></div>
        </div>
        <div class="record-field"><div class="record-field-head"><span>实验日志内容</span><small id="logSourceCount">${source.length} 字</small></div>
          <textarea id="logSource" class="record-textarea log-source-input" placeholder="输入实验过程、现象、数据、条件、结论与后续计划；保存时可由 AI 自动整理为实验现象、实验记录等板块。">${esc(source)}</textarea>
          <p class="record-hint">${l.images.length ? `已记录导入文档中的 ${l.images.length} 项图片信息。` : '可直接输入，或导入 Word、PDF、Markdown / 文本文档。'}</p>
        </div>
        <div class="record-foot">
          <label class="auto-polish-toggle"><input id="autoPolish" type="checkbox" ${R.autoPolish ? 'checked' : ''} /><span>保存时使用 AI 自动整理与润色</span><small>默认开启；保留原意，不添加实验事实。</small></label>
          <div style="display:flex;gap:8px">
            <button id="importLogButton" class="secondary-button">导入文档</button>
            <button id="exportLogBtn" class="secondary-button" ${hasContent ? '' : 'disabled'}>↓ 导出 .md</button>
            <button id="saveLogBtn" class="primary-button">保存实验日志</button>
          </div>
        </div>
      </div>`;
    $('logDate').onchange = e => loadLog(e.target.value);
    $('logPlan').onchange = e => {
      const next = { ...R.log, planId: e.target.value, subexperimentId: '' };
      loadLog(R.date, next);
    };
    $('logSubexperiment').onchange = e => {
      const next = { ...R.log, subexperimentId: e.target.value };
      loadLog(R.date, next);
    };
    $('logSource').oninput = e => {
      R.log.source = e.target.value;
      R.log.formattedSource = '';
      $('logSourceCount').textContent = `${e.target.value.length} 字`;
      $('exportLogBtn').disabled = !e.target.value.trim();
    };
    $('autoPolish').onchange = e => { R.autoPolish = e.target.checked; };
    $('saveLogBtn').onclick = () => saveLog(true);
    $('importLogButton').onclick = openLogImport;
    $('exportLogBtn').onclick = exportLog;
  }

  async function loadLog(date, association = R.log) {
    R.date = date;
    const selected = {
      planId: association.planId || '',
      subexperimentId: association.subexperimentId || ''
    };
    try { R.log = normalizeLog((await api(`${slugPath(R.active.slug)}/logs/${date}${logQuery(selected)}`)).log); renderLogsView(); }
    catch (e) { toast(e.message); }
  }

  async function saveLog(announce) {
    const source = visibleLogSource(R.log).trim();
    R.log.source = source;
    if (!R.active || !source) {
      if (announce) toast('请先输入或导入实验日志内容');
      return false;
    }
    const autoPolish = $('autoPolish') ? $('autoPolish').checked : R.autoPolish;
    R.autoPolish = autoPolish;
    const saveButton = $('saveLogBtn');
    try {
      if (autoPolish && R.log.formattedSource !== source) {
        if (saveButton) { saveButton.disabled = true; saveButton.textContent = 'AI 整理中…'; }
        await formatLogWithAi(source);
      } else if (!autoPolish) {
        R.log.phenomena = '';
        R.log.record = source;
        R.log.formattedSource = '';
      }
      const data = await api(`${slugPath(R.active.slug)}/logs/${R.date}`, { method: 'POST', body: JSON.stringify(R.log) });
      R.log = normalizeLog(data.log);
      R.logs = (await api(`${slugPath(R.active.slug)}/logs`)).logs || [];
      await refreshProjects(true);
      if (announce) toast(autoPolish ? 'AI 已整理并保存实验日志与 AGENTS.md' : '实验日志与 AGENTS.md 已保存');
      return true;
    } catch (e) { toast(`保存失败：${e.message}`); }
    finally { const button = $('saveLogBtn'); if (button) { button.disabled = false; button.textContent = '保存实验日志'; } }
    return false;
  }

  async function buildLogAiContext() {
    const parts = [];
    const manualMemory = String(R.log.aiContext || '').trim();
    if (manualMemory) parts.push(`## 用户提供的实验方案记忆\n\n${manualMemory}`);
    if (R.log.includePlanMemory !== false && R.log.planId) {
      const plan = planForLog(R.log);
      const scope = planScopeDetails(plan, R.log.subexperimentId);
      const label = scope.subexperiment
        ? `${plan.name} · ${plan.version} · ${scope.subexperiment.name}`
        : `${plan?.name || '关联实验方案'} · ${plan?.version || ''}`;
      try {
        const response = await api(`${slugPath(R.active.slug)}/plans/${encodeURIComponent(R.log.planId)}/content${scope.query}`);
        const content = editablePlanContent(response.content || '').trim();
        if (content) {
          const maximum = 12000;
          const clipped = content.length > maximum
            ? `${content.slice(0, maximum)}\n\n[方案内容较长，以下部分未发送给 AI]`
            : content;
          parts.push(`## 当前关联实验方案：${label}\n\n${clipped}`);
        }
      } catch (error) {
        toast('未能读取关联方案内容；将仅依据导入文档和手动记忆进行整理。');
      }
    }
    return parts.join('\n\n---\n\n');
  }

  async function formatLogWithAi(source) {
    const context = await buildLogAiContext();
    const contextMessage = context
      ? `\n\n以下是仅用于术语、样品与步骤校对的实验方案记忆。它不是实验已经发生的证据，不能用它补写、修改或推断导入文档中没有的事实：\n\n${context}`
      : '';
    const reply = await askModel([
      { role: 'system', content: '你是严谨的中文科研实验日志编辑。请从导入文档中提取明确属于已执行实验的过程、条件、数据、观察现象、结果、异常和后续事项，整理为“实验现象”和“实验记录”两个板块，并润色错别字、语法、表达和结构。背景介绍、文献内容、计划步骤或模板字段若未明确已执行，不得写成实验记录。不得编造、删减、替换或推断任何实验事实、数据、单位、样品编号、日期、条件、观察现象、结论或不确定性；导入文档原文会被另外保存，整理结果必须忠于原意。实验方案记忆只能用于核对术语、样品与步骤，不得作为实验发生的依据。只返回 JSON：{"phenomena":"...","record":"..."}。' },
      { role: 'user', content: `# 待提取的导入文档\n\n${source}${contextMessage}` }
    ]);
    let parsed;
    try { const hit = reply.match(/\{[\s\S]*\}/); parsed = JSON.parse(hit ? hit[0] : reply); }
    catch { throw new Error('模型未返回可用的日志结构，请检查模型设置后重试。'); }
    R.log.phenomena = typeof parsed.phenomena === 'string' ? parsed.phenomena : '';
    R.log.record = typeof parsed.record === 'string' ? parsed.record : '';
    if (!R.log.phenomena.trim() && !R.log.record.trim()) throw new Error('模型未生成实验日志内容，请重试。');
    R.log.formattedSource = source;
  }

  function openLogImport() {
    if (!R.active) { toast('请先选择或新建一个项目'); return; }
    const associationHint = R.log.planId
      ? `将自动读取当前关联的“${esc(logAssociationText(R.log))}”作为校对上下文。`
      : '可先在日志页面选择关联实验方案，或在下方直接粘贴方案记忆。';
    openModal(`<div class="modal-header"><div><h2>导入文档生成日志</h2><p>支持 Word（.docx）、PDF、Markdown 与文本。文档仅在本机转换；原始输入和图片信息会写入实验日志 Markdown。</p></div><button class="close-button" data-close-modal>×</button></div>
      <div class="modal-body"><div class="form-grid"><div class="form-field full"><label>选择文档</label><input id="logImportFile" type="file" accept=".docx,.pdf,.md,.markdown,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/markdown,text/plain" /><small class="field-note">PDF 需包含可提取的文字；扫描件请先 OCR。Word 目前支持 .docx 格式。</small></div><label class="auto-polish-toggle form-field full"><input id="logImportUseAi" type="checkbox" checked /><span>使用 AI 提取并整理有用实验日志</span><small>只提取明确已执行的实验信息；原始导入内容会完整保留。</small></label><label class="auto-polish-toggle form-field full"><input id="logImportUsePlanMemory" type="checkbox" ${R.log.planId ? 'checked' : 'disabled'} /><span>使用当前关联实验方案进行校对</span><small>${associationHint}</small></label><label class="form-field full"><span>实验方案记忆（可选）</span><textarea id="logImportPlanMemory" style="min-height:120px" placeholder="可粘贴样品编号、变量范围、步骤名称、判定标准或方案摘要；仅供 AI 比对术语，不会作为实验事实写入日志。"></textarea></label></div><p class="import-tip">导入后会生成当前日期的实验日志。仅当勾选 AI 整理时，文档内容和上述方案记忆才会发送给你已配置的模型接口。</p></div>
      <div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button id="logImportConfirm" type="button" class="primary-button">导入并生成日志</button></div>`,
      () => { $('logImportConfirm').onclick = importLogDocument; });
  }

  function fileToBase64(file) {
    return file.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const size = 0x8000;
      for (let start = 0; start < bytes.length; start += size) binary += String.fromCharCode(...bytes.subarray(start, start + size));
      return btoa(binary);
    });
  }

  async function importLogDocument() {
    const file = $('logImportFile').files[0];
    if (!file) { toast('请选择要导入的文档'); return; }
    if (file.size > 15 * 1024 * 1024) { toast('文档超过 15 MB，暂不能导入'); return; }
    const button = $('logImportConfirm');
    button.disabled = true; button.textContent = '正在导入…';
    try {
      const imported = await api(`${slugPath(R.active.slug)}/logs/${R.date}/import`, {
        method: 'POST', body: JSON.stringify({ filename: file.name, contentBase64: await fileToBase64(file) })
      });
      const source = (imported.source || '').trim();
      if (!source) throw new Error('文档中没有可导入的文本内容。');
      R.log = {
        source,
        phenomena: '',
        record: '',
        images: imported.images || [],
        formattedSource: '',
        planId: R.log.planId || '',
        subexperimentId: R.log.subexperimentId || '',
        aiContext: $('logImportPlanMemory')?.value.trim() || '',
        includePlanMemory: Boolean($('logImportUsePlanMemory')?.checked)
      };
      R.autoPolish = Boolean($('logImportUseAi')?.checked);
      closeModal();
      renderLogsView();
      await saveLog(true);
    } catch (e) { toast(`文档导入失败：${e.message}`); }
    finally { const current = $('logImportConfirm'); if (current) { current.disabled = false; current.textContent = '导入并生成日志'; } }
  }

  async function exportLog() {
    if (!R.log.source.trim()) { toast('请先输入或导入实验日志内容'); return; }
    if (!await saveLog(false)) return;
    const link = document.createElement('a');
    link.href = `${slugPath(R.active.slug)}/logs/${R.date}/export${logQuery(R.log)}`;
    link.download = `${R.date}-实验日志.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast('已导出 Markdown 实验日志');
  }

  function exportProject() {
    if (!R.active) { toast('请先选择项目'); return; }
    const link = document.createElement('a');
    link.href = `${slugPath(R.active.slug)}/export`;
    link.download = `${R.active.name}-项目记忆.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast('正在更新 scihub-memory/项目记忆.md，并下载同一份项目记忆');
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
        <div class="record-composer"><div style="display:grid;gap:7px;flex:1"><textarea id="recordInput" placeholder="继续提问；系统默认附带 AGENTS.md 项目上下文。（Ctrl/⌘ + Enter 发送）"></textarea><label class="project-memory-toggle"><input id="recordFullMemory" type="checkbox" ${R.useFullProjectMemory ? 'checked' : ''} /><span>本次同时附带完整项目记忆 MD（所有 Markdown；内容较大时可能增加 API 用量）</span></label></div><button id="recordSend" class="primary-button">发送</button></div>`;
    }
    $('recordsBody').innerHTML = `<div class="content-layout conversation-layout"><section class="conversation-list-panel"><div class="list-toolbar"><span>${R.conversations.length} 段对话</span></div><div class="conversation-list">${listHtml}</div></section><section class="conversation-detail-panel">${chatHtml}</section></div>`;
    $('recordsBody').querySelectorAll('[data-record]').forEach(b => b.onclick = () => loadConversation(b.dataset.record));
    if (c) {
      $('recordSend').onclick = sendMessage;
      $('recordFullMemory').onchange = e => { R.useFullProjectMemory = e.target.checked; };
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
      const s = settingsForUse();
      if (!s.model || !(s.key || R.sessionKey)) { await saveConversation(); renderRecordsView(); toast('问题已记录。配置 AI 设置后可基于项目记忆获得回复。'); return; }
      if (!c.model || c.model === '手工记录') c.model = s.model;
      await saveConversation(); renderRecordsView();
      const b = $('recordSend'); if (b) { b.disabled = true; b.textContent = '思考中…'; }
      const memory = R.useFullProjectMemory
        ? (await api(`${slugPath(R.active.slug)}/memory`)).content
        : (await api(`${slugPath(R.active.slug)}/agents`)).content;
      const history = c.messages.map(m => ({ role: m.role, content: m.content }));
      const answer = await askModel([
        { role: 'system', content: `你是科研协作助手。以下是${R.useFullProjectMemory ? '完整项目记忆 Markdown' : '项目 AGENTS.md 上下文'}；它包含原始记录或索引，不能把模型建议当作已验证事实。请用中文清楚回答，区分证据、推测和待验证事项。\n\n${memory}` },
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

  function openProjectEditDialog(slug) {
    const project = R.projects.find(item => item.slug === slug);
    if (!project) { toast('未找到项目'); return; }
    openModal(`<div class="modal-header"><div><h2>编辑项目信息</h2><p>会更新该项目的 README.md 与 AGENTS.md；项目文件夹名保持不变，避免移动已有记录。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="editProjectForm"><div class="modal-body"><div class="form-grid">
        <label class="form-field full"><span>项目名称</span><input id="editProjectName" required maxlength="80" value="${esc(project.name)}" /></label>
        <label class="form-field full"><span>项目说明</span><textarea id="editProjectDescription" maxlength="800" placeholder="研究目标、样品信息或范围">${esc(project.description || '')}</textarea></label>
        <label class="form-field full"><span>重要信息</span><textarea id="editProjectImportant" maxlength="2000" placeholder="已知事实、样品编号、固定约束、待验证事项。会同步进入 AGENTS.md。">${esc(project.importantInfo || '')}</textarea></label>
        <p class="field-note full">项目路径保持为：科研项目/${esc(project.slug)}/</p>
      </div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">保存项目信息</button></div></form>`, () => {
      $('editProjectForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('editProjectForm').querySelector('[type=submit]');
        button.disabled = true;
        button.textContent = '保存中…';
        try {
          const response = await api(slugPath(slug), {
            method: 'POST',
            body: JSON.stringify({
              name: $('editProjectName').value.trim(),
              description: $('editProjectDescription').value.trim(),
              importantInfo: $('editProjectImportant').value.trim()
            })
          });
          if (R.active?.slug === slug) {
            R.active = response.project;
            await loadAgents();
          }
          closeModal();
          await refreshProjects(true);
          renderHomeView();
          toast('项目信息已更新');
        } catch (error) {
          toast(`保存项目信息失败：${error.message}`);
        } finally {
          const current = $('editProjectForm')?.querySelector('[type=submit]');
          if (current) { current.disabled = false; current.textContent = '保存项目信息'; }
        }
      });
    });
  }

  async function openProjectDeleteDialog(slug) {
    const project = R.projects.find(item => item.slug === slug);
    if (!project) { toast('未找到项目'); return; }
    try {
      const preview = await api(`${slugPath(slug)}/delete-preview`);
      const items = preview.items || [];
      const fileList = items.map(item => `<li><i>${item.kind === 'folder' ? '▣' : '▤'}</i>${esc(item.path)}</li>`).join('');
      openModal(`<div class="modal-header"><div><h2>删除研究项目</h2><p>该操作会删除整个项目文件夹中的方案、日志、对话、项目记忆及其他文件，无法撤销。</p></div><button class="close-button" data-close-modal>×</button></div>
        <form id="deleteProjectForm"><div class="modal-body"><div class="delete-warning"><b>删除原因：删除研究项目「${esc(project.name)}」</b><br>待删除目录：科研项目/${esc(preview.folder)}/。以下 ${items.length} 项会被逐项删除，请完整核对后确认。</div><ul class="delete-target-list">${fileList || '<li>目录为空</li>'}</ul><label class="form-field full" style="margin-top:16px"><span>输入项目文件夹名 <b>${esc(preview.folder)}</b> 以确认删除</span><input id="deleteProjectConfirmation" required autocomplete="off" placeholder="${esc(preview.folder)}" /></label></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit" style="background:#a85349">删除项目</button></div></form>`, () => {
        $('deleteProjectConfirmation').focus();
        $('deleteProjectForm').addEventListener('submit', async event => {
          event.preventDefault();
          const confirmation = $('deleteProjectConfirmation').value.trim();
          if (confirmation !== preview.folder) { toast('请输入完整且正确的项目文件夹名'); return; }
          const button = $('deleteProjectForm').querySelector('[type=submit]');
          button.disabled = true;
          button.textContent = '删除中…';
          try {
            await api(slugPath(slug), { method: 'DELETE', body: JSON.stringify({ confirmation }) });
            const deletedActive = R.active?.slug === slug;
            if (deletedActive) {
              R.active = null;
              R.logs = [];
              R.plans = [];
              R.conversations = [];
              R.conversation = null;
              R.agents = '';
            }
            closeModal();
            await refreshProjects(false);
            renderHomeView();
            toast('项目文件夹及确认清单中的内容已删除');
          } catch (error) {
            toast(`删除项目失败：${error.message}`);
            const current = $('deleteProjectForm')?.querySelector('[type=submit]');
            if (current) { current.disabled = false; current.textContent = '删除项目'; }
          }
        });
      });
    } catch (error) {
      toast(`无法读取项目删除清单：${error.message}`);
    }
  }

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
    const s = settingsForUse();
    const provider = s.provider;
    const models = PROVIDERS[provider].models;
    const customModel = models.includes(s.model) ? '' : s.model;
    const modelOptions = models.map(model => `<option value="${esc(model)}" ${model === s.model ? 'selected' : ''}>${esc(model)}</option>`).join('');
    openModal(`<div class="modal-header"><div><h2>AI 设置</h2><p>用于实验日志润色，以及携带项目记忆继续对话。</p></div><button class="close-button" data-close-modal>×</button></div>
      <form id="apiForm"><div class="modal-body"><p class="import-tip" style="border-left:3px solid #c7dccd;background:#f4f8f3;padding:10px 12px;margin-top:0">API Key 仅保存在本浏览器。项目 Markdown、实验数据与对话只有在你点击润色或发送时才会发送给所选服务商。</p>
      <div class="form-grid"><div class="form-field"><label>服务商</label><select id="apiProvider">${Object.entries(PROVIDERS).map(([id, item]) => `<option value="${id}" ${id === provider ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></div>
      <div class="form-field"><label>模型</label><select id="apiModel">${modelOptions}<option value="__custom__" ${customModel ? 'selected' : ''}>自定义模型…</option></select></div>
      <div id="customModelField" class="form-field full" ${customModel ? '' : 'hidden'}><label>自定义模型名称</label><input id="apiCustomModel" maxlength="160" value="${esc(customModel)}" placeholder="填写服务商提供的模型 ID" /></div>
      <div class="form-field full"><label>接口地址（可选）</label><input id="apiEndpoint" type="url" value="${esc(s.endpoint)}" placeholder="留空将使用所选服务商的默认接口" /><span class="field-note" id="providerEndpointHint"></span></div>
      <div class="form-field"><label>推理强度</label><select id="apiReasoning">${Object.entries(REASONING_EFFORTS).map(([id, label]) => `<option value="${id}" ${id === s.reasoningEffort ? 'selected' : ''}>${label}</option>`).join('')}</select><span class="field-note" id="reasoningHint"></span></div>
      <div class="form-field"><label>API Key</label><input id="apiKey" type="password" autocomplete="off" value="${esc(s.key || R.sessionKey || '')}" placeholder="粘贴 API Key" /></div></div>
      <label class="field-note" style="display:flex;align-items:center;gap:8px;margin-top:13px"><input id="apiStore" type="checkbox" ${s.persist ? 'checked' : ''} style="width:16px;height:16px" /> 保存 API Key 到本浏览器</label>
      <p id="apiTestStatus" class="api-test-status" aria-live="polite"></p>
      <p class="import-tip">GPT 与 DeepSeek 使用兼容 Chat Completions；Gemini 与 Claude 使用各自的官方消息格式。模型列表仅作快捷选择，也可填写自定义模型 ID。</p></div>
      <div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button id="apiTestButton" type="button" class="secondary-button">测试连接</button><button class="primary-button" type="submit">保存设置</button></div></form>`,
      () => {
        const renderModels = (selected) => {
          const id = $('apiProvider').value;
          const knownModels = PROVIDERS[id].models;
          const chosen = knownModels.includes(selected) ? selected : knownModels[0];
          $('apiModel').innerHTML = `${knownModels.map(model => `<option value="${esc(model)}" ${model === chosen ? 'selected' : ''}>${esc(model)}</option>`).join('')}<option value="__custom__" ${knownModels.includes(selected) ? '' : 'selected'}>自定义模型…</option>`;
          $('apiCustomModel').value = knownModels.includes(selected) ? '' : selected;
          $('customModelField').hidden = $('apiModel').value !== '__custom__';
          const defaultEndpoint = PROVIDERS[id].endpoint;
          $('providerEndpointHint').textContent = id === 'gemini'
            ? 'Gemini 留空时会按所选模型自动生成官方接口地址。'
            : `留空时使用：${defaultEndpoint}`;
        };
        const updateReasoningControl = () => {
          const providerId = $('apiProvider').value;
          const supported = providerId === 'openai' || providerId === 'deepseek';
          $('apiReasoning').disabled = !supported;
          $('reasoningHint').textContent = providerId === 'deepseek'
            ? 'DeepSeek 会启用思考模式；低/中会映射为高，极高会映射为 max。'
            : providerId === 'openai'
              ? '仅在所选 GPT 模型原生支持时发送；不支持时请选择“模型默认”。'
              : '当前服务商不使用此参数，已禁用。';
        };
        $('apiProvider').addEventListener('change', () => { renderModels(PROVIDERS[$('apiProvider').value].models[0]); updateReasoningControl(); $('apiEndpoint').value = ''; });
        $('apiModel').addEventListener('change', () => { $('customModelField').hidden = $('apiModel').value !== '__custom__'; if ($('apiModel').value === '__custom__') $('apiCustomModel').focus(); });
        renderModels(s.model);
        updateReasoningControl();
        const readDraftSettings = () => {
          const providerId = $('apiProvider').value;
          const model = $('apiModel').value === '__custom__' ? $('apiCustomModel').value.trim() : $('apiModel').value;
          return {
            provider: providerId,
            endpoint: $('apiEndpoint').value.trim(),
            model,
            reasoningEffort: $('apiReasoning').value,
            key: $('apiKey').value.trim()
          };
        };
        const setTestStatus = (message, type = '') => {
          const status = $('apiTestStatus');
          status.textContent = message;
          status.className = `api-test-status ${type}`;
        };
        $('apiTestButton').addEventListener('click', async () => {
          const draft = readDraftSettings();
          if (!draft.model) { setTestStatus('请先选择模型或填写自定义模型名称。', 'error'); return; }
          if (!draft.key) { setTestStatus('请填写 API Key 后再测试。', 'error'); return; }
          const button = $('apiTestButton');
          button.disabled = true;
          button.textContent = '测试中…';
          setTestStatus('正在发送一条最短测试请求；当前设置尚未保存。', 'pending');
          try {
            const answer = await askModel([
              { role: 'system', content: '这是 API 连通性测试。请只回复：OK' },
              { role: 'user', content: '请确认连接。' }
            ], draft);
            const preview = answer.replace(/\s+/g, ' ').trim().slice(0, 80);
            setTestStatus(`连接成功 · ${PROVIDERS[draft.provider].label} / ${draft.model}${preview ? ` · 返回：${preview}` : ''}`, 'success');
          } catch (error) {
            setTestStatus(`连接失败：${error.message}`, 'error');
          } finally {
            const currentButton = $('apiTestButton');
            if (currentButton) { currentButton.disabled = false; currentButton.textContent = '测试连接'; }
          }
        });
        $('apiForm').addEventListener('submit', e => {
          e.preventDefault();
          const draft = readDraftSettings();
          if (!draft.model) { toast('请选择模型或填写自定义模型名称'); return; }
          const persist = $('apiStore').checked;
          R.sessionKey = draft.key;
          saveSettings({ ...draft, key: persist ? draft.key : '', persist });
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
    if (v === 'home') renderHomeView();
    else if (v === 'plans') renderPlansView();
    else if (v === 'planBook') renderPlanBookView();
    else if (v === 'logs') renderLogsView();
    else if (v === 'records') renderRecordsView();
    else if (v === 'memory') renderMemoryView();
  }

  function onViewActivated(view) {
    updateTopbarActions(view);
    renderPlanTaskBanner();
    if (view === 'home') renderHomeView();
    else if (view === 'plans') renderPlansView();
    else if (view === 'planBook') renderPlanBookView();
    else if (view === 'logs') renderLogsView();
    else if (view === 'records') renderRecordsView();
    else if (view === 'memory') renderMemoryView();
  }

  // 事件绑定
  document.addEventListener('DOMContentLoaded', () => {
    renderPlanTaskBanner();
    $('apiSettingsButton')?.addEventListener('click', openApiDialog);
    $('exportProjectButton')?.addEventListener('click', exportProject);
    $('newPlanButton')?.addEventListener('click', openPlanDialog);
    $('homeNewProjectButton')?.addEventListener('click', openProjectDialog);
    $('viewAgentsButton')?.addEventListener('click', showAgents);
    $('newRecordButton')?.addEventListener('click', openRecordDialog);
    window.addEventListener('beforeunload', event => {
      if (R.planGeneration?.status === 'running') {
        event.preventDefault();
        event.returnValue = '实验方案书仍在生成，关闭或刷新页面会中断任务。';
        return event.returnValue;
      }
      return undefined;
    });
    $('recordImportButton')?.addEventListener('click', openRecordImport);
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && ['logs'].includes(currentView())) { e.preventDefault(); saveLog(true); }
    });
    refreshProjects(false).then(() => { renderActiveView(); if (window.SciHubApp) window.SciHubApp.renderAll(); });
  });

  // 暴露给 app.js
  window.SciHubRecords = {
    get projects() { return R.projects; },
    renderProjectSidebar,
    renderHomeView,
    selectProject,
    openProjectDialog,
    onViewActivated
  };
})();
