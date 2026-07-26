const STORAGE_KEY = 'scihub-prototype-v1';

const seedData = {
  projects: [
    { id: 'p1', name: '蛋白质折叠机制', color: '#5d8a75' },
    { id: 'p2', name: '文献综述 · LLM 可信性', color: '#8878a8' },
    { id: 'p3', name: '实验设计 · 代谢组学', color: '#bc8b3e' }
  ],
  conversations: [
    { id: 'c1', title: 'AlphaFold 3 的实验验证路径', model: 'Claude', projectId: 'p1', createdAt: '2026-07-25T10:34:00', messages: [
      { role: 'user', content: '如果我想验证 AlphaFold 3 对蛋白—配体复合物的预测，实验上可以如何设计？', createdAt: '2026-07-25T10:28:00' },
      { role: 'assistant', content: '可以将验证分为结构、结合与功能三个层次。结构层面可优先考虑 X-ray 晶体学或冷冻电镜；结合层面可用 SPR、ITC 或 MST 给出亲和力；功能层面则需要选择与体系对应的活性读出。\n\n建议先明确预测中置信度最低的界面残基，再以点突变建立可证伪的假设。注意：具体方法适用性仍需结合蛋白大小、稳定性与实验条件核验。', createdAt: '2026-07-25T10:31:00' }
    ] },
    { id: 'c2', title: '系统综述中的幻觉文献风险', model: 'ChatGPT', projectId: 'p2', createdAt: '2026-07-24T16:02:00', messages: [
      { role: 'user', content: '写系统综述时，如何降低大模型生成虚构引文的风险？', createdAt: '2026-07-24T15:51:00' },
      { role: 'assistant', content: '不要将模型输出的参考文献直接作为引用。可以要求模型仅基于你提供的 DOI 或已检索的文献库做归纳；之后通过 Crossref、PubMed 或出版社页面逐条核对题名、作者、年份和 DOI。\n\n将“模型建议的线索”与“已验证的文献”分开存放，是一个有效的工作流。', createdAt: '2026-07-24T15:56:00' }
    ] },
    { id: 'c3', title: '非靶向代谢组学的批次效应', model: 'Gemini', projectId: 'p3', createdAt: '2026-07-22T09:18:00', messages: [
      { role: 'user', content: '非靶向 LC-MS 数据的批次效应应该在哪一步校正？', createdAt: '2026-07-22T09:10:00' },
      { role: 'assistant', content: '通常需要先完成峰提取、对齐与基础质量控制，再结合 QC 样本评估信号漂移。批次校正方法需与实验设计相匹配，且应保留原始数据并报告校正前后的评估结果。', createdAt: '2026-07-22T09:14:00' }
    ] }
  ],
  cards: [
    { id: 'k1', title: '将验证分为结构、结合与功能三个层次', content: '针对蛋白—配体复合物预测，可分别设计结构解析、亲和力测定与功能读出；优先围绕低置信度界面残基设计点突变，从而建立可证伪假设。具体实验选择仍需结合体系条件核验。', type: '研究方法', status: '待验证', projectId: 'p1', conversationId: 'c1', model: 'Claude', tags: ['实验设计', '结构生物学'], createdAt: '2026-07-25T10:34:00' },
    { id: 'k2', title: 'AI 建议的引文不能直接进入参考文献', content: '仅将模型输出视作检索线索。应通过 Crossref、PubMed 或出版社页逐条核对题名、作者、年份和 DOI，并将已验证文献与模型建议分开管理。', type: '研究结论', status: '已验证', projectId: 'p2', conversationId: 'c2', model: 'ChatGPT', tags: ['文献核验', '科研诚信'], createdAt: '2026-07-24T16:02:00' },
    { id: 'k3', title: '先提供 DOI，再让模型进行归纳', content: '提示词模板：以下内容仅基于我提供的 DOI 与摘要归纳。不得补充未在材料中出现的作者、年份、实验结果或参考文献；对不确定之处明确标注。', type: '提示词', status: '已验证', projectId: 'p2', conversationId: 'c2', model: 'ChatGPT', tags: ['提示词', '综述'], createdAt: '2026-07-24T16:00:00' },
    { id: 'k4', title: '批次校正前应先保留原始 QC 评估', content: '非靶向 LC-MS 中，需先完成峰提取、对齐和基础质量控制，并使用 QC 样本评估信号漂移。校正方法与评价指标需要依据实验设计进一步确定。', type: '文献线索', status: '未核验', projectId: 'p3', conversationId: 'c3', model: 'Gemini', tags: ['LC-MS', '质量控制'], createdAt: '2026-07-22T09:18:00' },
    { id: 'k5', title: '检索适合复合物体系的 SPR 方案', content: '比较固定化方式、缓冲液与可能的非特异结合控制；记录可支持或推翻预测的实验边界。', type: '待办', status: '待验证', projectId: 'p1', conversationId: 'c1', model: 'Claude', tags: ['SPR', '下一步'], createdAt: '2026-07-25T10:38:00' }
  ]
};

let state = loadState();
let activeView = 'dashboard';
let selectedConversationId = state.conversations[0]?.id || null;
let cardFilters = { search: '', type: 'all', status: 'all', project: 'all' };
let pendingImport = null;

function loadState() {
  try { const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)); return stored?.projects ? stored : structuredClone(seedData); }
  catch { return structuredClone(seedData); }
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }
function dateText(value) { const d = new Date(value); const diff = Math.round((Date.now() - d) / 86400000); if (diff === 0) return '今天'; if (diff === 1) return '昨天'; if (diff < 7) return `${diff} 天前`; return `${d.getMonth() + 1}月${d.getDate()}日`; }
function projectById(id) {
  if (window.SciHubRecords && window.SciHubRecords.projects.length) {
    const sp = window.SciHubRecords.projects.find(p => p.slug === id);
    if (sp) return { id: sp.slug, name: sp.name, color: '#5d8a75' };
  }
  return state.projects.find(p => p.id === id);
}
function allProjectsForForms() {
  if (window.SciHubRecords && window.SciHubRecords.projects.length) {
    return window.SciHubRecords.projects.map(p => ({ id: p.slug, name: p.name, color: '#5d8a75' }));
  }
  return state.projects;
}
function conversationById(id) { return state.conversations.find(c => c.id === id); }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[c])); }
function iconForType(type) { return ({ '研究结论':'◇', '研究方法':'⌬', '提示词':'✦', '代码片段':'⌘', '文献线索':'↗', '待办':'✓' })[type] || '◇'; }

function renderAll() { renderSidebar(); renderStats(); renderActivity(); renderVerification(); renderProjectOptions(); renderConversations(); renderCards(); }
function renderSidebar() {
  document.getElementById('conversationNavCount').textContent = state.conversations.length;
  document.getElementById('cardNavCount').textContent = state.cards.length;
  // 侧栏的研究项目列表由 records.js（文件后端）负责渲染。
  if (window.SciHubRecords && typeof window.SciHubRecords.renderProjectSidebar === 'function') {
    window.SciHubRecords.renderProjectSidebar();
  }
}
function renderStats() {
  const waiting = state.cards.filter(c => c.status === '待验证').length;
  const items = [
    ['活跃项目', state.projects.length, '个正在推进的课题', '◫', ''],
    ['已导入对话', state.conversations.length, `来自 ${new Set(state.conversations.map(c => c.model)).size || 0} 个模型`, '◌', ''],
    ['知识卡片', state.cards.length, `本周新增 <b>${state.cards.filter(c => Date.now() - new Date(c.createdAt) < 7*86400000).length}</b> 条`, '◇', ''],
    ['待验证线索', waiting, '避免将模型内容直接视为事实', '!', 'warning']
  ];
  document.getElementById('statsGrid').innerHTML = items.map(([label,value,caption,icon,cls]) => `<article class="stat-card ${cls}"><div class="stat-label"><span>${label}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-caption">${caption}</div></article>`).join('');
}
function renderActivity() {
  const cards = [...state.cards].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,4);
  document.getElementById('recentActivity').innerHTML = cards.length ? cards.map(card => `<div class="activity-item"><div class="activity-icon ${card.type}">${iconForType(card.type)}</div><div><h3>${escapeHtml(card.title)}</h3><p>${escapeHtml(projectById(card.projectId)?.name || '未归类')} · ${escapeHtml(card.model || '手工记录')}</p></div><time class="activity-date">${dateText(card.createdAt)}</time></div>`).join('') : '<div class="empty-state"><span>◇</span><strong>还没有研究记录</strong>从一段对话开始沉淀吧。</div>';
}
function renderVerification() {
  const cards = state.cards.filter(c => c.status === '待验证' || c.status === '未核验').slice(0,3);
  document.getElementById('verificationList').innerHTML = cards.length ? cards.map(card => `<div class="verification-item"><div class="verification-top"><span class="status-badge ${card.status}">${card.status}</span><span class="model-badge">${escapeHtml(card.model || '手工')}</span></div><h3>${escapeHtml(card.title)}</h3><p>${escapeHtml(projectById(card.projectId)?.name || '未归类')}</p></div>`).join('') : '<div class="empty-state"><span>✓</span><strong>没有待验证线索</strong>研究状态清晰可见。</div>';
}
function projectOptions(value = 'all', allLabel = '全部项目') { return `<option value="all">${allLabel}</option>${allProjectsForForms().map(p => `<option value="${p.id}" ${value === p.id ? 'selected':''}>${escapeHtml(p.name)}</option>`).join('')}`; }
function renderProjectOptions() {
  document.getElementById('projectFilter').innerHTML = projectOptions(cardFilters.project);
  document.getElementById('conversationProjectFilter').innerHTML = projectOptions(document.getElementById('conversationProjectFilter').value || 'all');
}
function filteredConversations() { const project = document.getElementById('conversationProjectFilter')?.value || 'all'; return state.conversations.filter(c => project === 'all' || c.projectId === project).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); }
function renderConversations() {
  const list = filteredConversations();
  if (!list.some(c => c.id === selectedConversationId)) selectedConversationId = list[0]?.id || null;
  document.getElementById('conversationCount').textContent = `${list.length} 段对话`;
  document.getElementById('conversationList').innerHTML = list.length ? list.map(c => `<button class="conversation-list-item ${c.id === selectedConversationId ? 'selected':''}" data-conversation="${c.id}"><h3>${escapeHtml(c.title)}</h3><p>${escapeHtml(c.messages[c.messages.length - 1]?.content || '无内容')}</p><div class="conversation-meta"><span class="model-badge">${escapeHtml(c.model || '导入')}</span><time>${dateText(c.createdAt)}</time></div></button>`).join('') : '<div class="empty-state"><span>↓</span><strong>还没有对话</strong>导入第一段 AI 对话。</div>';
  const c = conversationById(selectedConversationId);
  document.getElementById('conversationDetail').innerHTML = c ? `<div class="conversation-head"><p class="eyebrow">${escapeHtml(projectById(c.projectId)?.name || '未归类')}</p><h2>${escapeHtml(c.title)}</h2><div class="detail-meta"><span class="model-badge">${escapeHtml(c.model || '导入')}</span><span>·</span><span>${new Date(c.createdAt).toLocaleString('zh-CN', {year:'numeric',month:'long',day:'numeric'})}</span><span>·</span><span>${c.messages.length} 条消息</span></div></div><div class="messages">${c.messages.map((m, index) => `<article class="message"><div class="message-avatar ${m.role === 'assistant' ? 'assistant':''}">${m.role === 'assistant' ? escapeHtml(c.model?.slice(0,1) || 'A') : '林'}</div><div class="message-content"><div class="message-meta">${m.role === 'assistant' ? escapeHtml(c.model || 'AI 助手') : '你'} <small>${m.createdAt ? new Date(m.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : ''}</small></div><div class="message-bubble">${escapeHtml(m.content)}</div>${m.role === 'assistant' ? `<div class="message-actions"><button class="save-message" data-save-message="${c.id}:${index}">◇ 沉淀为知识卡片</button></div>` : ''}</div></article>`).join('')}</div>` : '<div class="conversation-detail-empty"><div><span>◌</span><p>选择一段对话，查看它的完整研究上下文。</p></div></div>';
}
function getFilteredCards() { return state.cards.filter(c => (!cardFilters.search || [c.title,c.content,c.tags.join(' '),projectById(c.projectId)?.name,c.model].join(' ').toLowerCase().includes(cardFilters.search.toLowerCase())) && (cardFilters.type === 'all' || c.type === cardFilters.type) && (cardFilters.status === 'all' || c.status === cardFilters.status) && (cardFilters.project === 'all' || c.projectId === cardFilters.project)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); }
function renderCards() {
  const cards = getFilteredCards();
  document.getElementById('cardResultSummary').textContent = `显示 ${cards.length} / ${state.cards.length} 张知识卡片`;
  document.getElementById('cardGrid').innerHTML = cards.length ? cards.map(c => `<article class="knowledge-card"><div class="card-top"><span class="type-badge ${c.type}">${escapeHtml(c.type)}</span><span class="status-badge ${c.status}">${escapeHtml(c.status)}</span></div><h3>${escapeHtml(c.title)}</h3><p class="card-content">${escapeHtml(c.content)}</p><div class="card-tags">${c.tags.map(t=>`<span class="tag"># ${escapeHtml(t)}</span>`).join('')}</div><div class="card-footer"><span class="source-dot"></span><span>${escapeHtml(projectById(c.projectId)?.name || '未归类')}</span><span class="source-link" data-source="${c.conversationId || ''}">${c.conversationId ? '查看来源' : '手工记录'}</span></div></article>`).join('') : '<div class="empty-state"><span>⌕</span><strong>没有找到匹配的卡片</strong>换个关键词，或清除筛选条件后再试。</div>';
}
function switchView(view) { activeView = view; document.querySelectorAll('.view').forEach(v => v.classList.toggle('active-view', v.id === `${view}View`)); document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view)); document.querySelector('.sidebar').classList.remove('open'); if (view === 'conversations') renderConversations(); if(view === 'cards') renderCards(); if((view === 'logs' || view === 'records' || view === 'memory') && window.SciHubRecords) window.SciHubRecords.onViewActivated(view); window.scrollTo({top:0,behavior:'smooth'}); }
window.switchView = switchView;
function toast(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(()=>el.classList.remove('show'),2600); }

function showCardModal(initial = {}) {
  const projectOptionsForForm = allProjectsForForms().map(p=>`<option value="${p.id}" ${initial.projectId === p.id ? 'selected':''}>${escapeHtml(p.name)}</option>`).join('');
  openModal(`<div class="modal-header"><div><h2>新建知识卡片</h2><p>记录内容时请标明来源与核验状态。</p></div><button class="close-button" data-close-modal aria-label="关闭">×</button></div><form id="cardForm"><div class="modal-body"><div class="form-grid"><div class="form-field full"><label for="cardTitle">标题</label><input id="cardTitle" required maxlength="120" placeholder="用一句话概括这条发现" value="${escapeHtml(initial.title || '')}" /></div><div class="form-field"><label for="cardType">类型</label><select id="cardType"><option ${initial.type==='研究结论'?'selected':''}>研究结论</option><option ${initial.type==='研究方法'?'selected':''}>研究方法</option><option ${initial.type==='提示词'?'selected':''}>提示词</option><option ${initial.type==='代码片段'?'selected':''}>代码片段</option><option ${initial.type==='文献线索'?'selected':''}>文献线索</option><option ${initial.type==='待办'?'selected':''}>待办</option></select></div><div class="form-field"><label for="cardProject">所属项目</label><select id="cardProject">${projectOptionsForForm}</select></div><div class="form-field"><label for="cardStatus">核验状态</label><select id="cardStatus"><option ${initial.status==='未核验'?'selected':''}>未核验</option><option ${initial.status==='待验证'?'selected':''}>待验证</option><option ${initial.status==='已验证'?'selected':''}>已验证</option><option ${initial.status==='存疑'?'selected':''}>存疑</option></select></div><div class="form-field"><label for="cardTags">标签</label><input id="cardTags" placeholder="例如：实验设计, 蛋白质" value="${escapeHtml((initial.tags || []).join(', '))}" /></div><div class="form-field full"><label for="cardContent">内容</label><textarea id="cardContent" required placeholder="记录原始结论、适用条件与仍需核验之处…">${escapeHtml(initial.content || '')}</textarea><span class="field-note">来源：${initial.model ? `${escapeHtml(initial.model)} 对话` : '手工记录'} ${initial.conversationId ? '· 将保留原始对话链接' : ''}</span></div></div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" type="submit">保存知识卡片</button></div></form>`, () => {
    document.getElementById('cardForm').addEventListener('submit', e => { e.preventDefault(); const card = { id:uid('k'), title:document.getElementById('cardTitle').value.trim(), type:document.getElementById('cardType').value, projectId:document.getElementById('cardProject').value, status:document.getElementById('cardStatus').value, tags:document.getElementById('cardTags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean), content:document.getElementById('cardContent').value.trim(), conversationId:initial.conversationId || null, model:initial.model || '手工记录', createdAt:new Date().toISOString() }; state.cards.unshift(card); saveState(); closeModal(); renderAll(); switchView('cards'); toast('知识卡片已保存到本地'); });
  });
}
function showImportModal() {
  pendingImport = null;
  openModal(`<div class="modal-header"><div><h2>导入 AI 对话</h2><p>原始文件只在本地浏览器中处理，不会上传。</p></div><button class="close-button" data-close-modal aria-label="关闭">×</button></div><div class="modal-body"><div class="file-drop"><span>↓</span><b>选择对话导出文件</b><p>支持 ChatGPT、Claude、Gemini 等导出的 JSON，或纯文本 / Markdown 文件。</p><button class="secondary-button" id="chooseFileButton">选择文件</button></div><div id="importPreview"></div><p class="import-tip">提示：不同平台的导出格式并不完全相同。SciHub 会保留可识别的标题、消息、模型和时间；其余内容将作为原始文本保存，供你随时追溯。</p></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button" id="confirmImport" disabled>导入到项目</button></div>`, () => { document.getElementById('chooseFileButton').addEventListener('click',()=>document.getElementById('fileInput').click()); document.getElementById('confirmImport').addEventListener('click', confirmImport); });
}
function parseImport(text, fileName) {
  const titleBase = fileName.replace(/\.[^.]+$/, '') || '导入的 AI 对话';
  let raw; try { raw = JSON.parse(text); } catch { return { title:titleBase, model:'文本导入', messages:[{role:'assistant',content:text.slice(0,20000),createdAt:new Date().toISOString()}] }; }
  const root = Array.isArray(raw) ? raw[0] : raw;
  const title = root.title || root.name || titleBase;
  const model = root.model || root.model_name || root.default_model_slug || (root.mapping ? 'ChatGPT' : 'JSON 导入');
  let messages = [];
  if (Array.isArray(root.messages)) messages = root.messages.map(m=>({ role: m.role || m.author?.role || 'assistant', content: typeof m.content === 'string' ? m.content : m.content?.parts?.join('\n') || m.text || '', createdAt:m.createdAt || m.create_time || new Date().toISOString() })).filter(m=>m.content.trim());
  else if (root.mapping) messages = Object.values(root.mapping).map(n=>n.message).filter(Boolean).map(m=>({role:m.author?.role || 'assistant',content:m.content?.parts?.filter(Boolean).join('\n') || '',createdAt:m.create_time ? new Date(m.create_time * 1000).toISOString() : new Date().toISOString()})).filter(m=>m.content.trim());
  else if (root.content) messages = [{ role:'assistant', content: typeof root.content === 'string' ? root.content : JSON.stringify(root.content,null,2), createdAt:new Date().toISOString() }];
  if (!messages.length) messages = [{role:'assistant',content:JSON.stringify(root,null,2).slice(0,20000),createdAt:new Date().toISOString()}];
  return { title, model, messages };
}
function handleFile(file) { if (!file) return; const reader = new FileReader(); reader.onload = e => { pendingImport = parseImport(e.target.result, file.name); document.getElementById('importPreview').innerHTML = `<div class="import-preview"><b>已识别：${escapeHtml(pendingImport.title)}</b><br />${escapeHtml(pendingImport.model)} · ${pendingImport.messages.length} 条消息 · ${escapeHtml(file.name)}</div>`; document.getElementById('confirmImport').disabled = false; }; reader.readAsText(file); }
function confirmImport() { if (!pendingImport) return; const projectId = allProjectsForForms()[0]?.id; const conversation = { id:uid('c'), ...pendingImport, projectId, createdAt:new Date().toISOString() }; state.conversations.unshift(conversation); selectedConversationId=conversation.id; saveState(); closeModal(); renderAll(); switchView('conversations'); toast(`已导入「${conversation.title}」`); }
function showProjectModal() { openModal(`<div class="modal-header"><div><h2>新建研究项目</h2><p>项目用于集中管理对话、知识卡片与后续证据。</p></div><button class="close-button" data-close-modal>×</button></div><form id="projectForm"><div class="modal-body"><div class="form-field"><label for="projectName">项目名称</label><input id="projectName" required placeholder="例如：肿瘤微环境文献综述" /></div></div><div class="modal-footer"><button type="button" class="secondary-button" data-close-modal>取消</button><button class="primary-button">创建项目</button></div></form>`,()=>document.getElementById('projectForm').addEventListener('submit',e=>{e.preventDefault(); const colors=['#5d8a75','#8878a8','#bc8b3e','#6b92a1'];state.projects.push({id:uid('p'),name:document.getElementById('projectName').value.trim(),color:colors[state.projects.length%colors.length]});saveState();closeModal();renderAll();toast('研究项目已创建');})); }
function openModal(content, init) { document.getElementById('modalRoot').innerHTML = `<div class="modal-backdrop" role="dialog" aria-modal="true"><div class="modal">${content}</div></div>`; document.querySelectorAll('[data-close-modal]').forEach(b=>b.addEventListener('click',closeModal)); document.querySelector('.modal-backdrop').addEventListener('click',e=>{if(e.target === e.currentTarget)closeModal()}); init?.(); }
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }
function addEvidence() { toast('证据关联将在正式数据库版本中提供；请先在卡片内容中记录 DOI 或链接。'); }

document.addEventListener('click', e => {
  const nav=e.target.closest('[data-view]'); if(nav) return switchView(nav.dataset.view);
  const goto=e.target.closest('[data-goto]'); if(goto) { if(goto.dataset.filterStatus){cardFilters.status=goto.dataset.filterStatus;document.getElementById('statusFilter').value=cardFilters.status;} return switchView(goto.dataset.goto || 'cards'); }
  const action=e.target.closest('[data-action]'); if(action){ if(action.dataset.action==='import')showImportModal(); else if(action.dataset.action==='card')showCardModal({projectId:cardFilters.project==='all'?allProjectsForForms()[0]?.id:cardFilters.project,status:'未核验'}); else {cardFilters.status='待验证';document.getElementById('statusFilter').value='待验证';switchView('cards');} return; }
  const conversation=e.target.closest('[data-conversation]'); if(conversation){selectedConversationId=conversation.dataset.conversation;renderConversations();return;}
  const saveMessage=e.target.closest('[data-save-message]'); if(saveMessage){const [conversationId,index]=saveMessage.dataset.saveMessage.split(':');const c=conversationById(conversationId);const m=c.messages[Number(index)];showCardModal({title:m.content.slice(0,32)+(m.content.length>32?'…':''),content:m.content,type:'研究结论',status:'待验证',projectId:c.projectId,conversationId:c.id,model:c.model,tags:[]});return;}
  const source=e.target.closest('[data-source]'); if(source && source.dataset.source){selectedConversationId=source.dataset.source; switchView('conversations');return;}
  const project=e.target.closest('[data-project-select]');if(project){ if(window.SciHubRecords){ window.SciHubRecords.selectProject(project.dataset.projectSelect); return; } cardFilters.project=project.dataset.projectSelect;document.getElementById('projectFilter').value=cardFilters.project;switchView('cards');renderAll();return;}
});
document.getElementById('newCardButton').addEventListener('click',()=>showCardModal({projectId:allProjectsForForms()[0]?.id,status:'未核验'}));
document.getElementById('importButton').addEventListener('click',showImportModal);
document.getElementById('addProjectButton').addEventListener('click',()=>{ if(window.SciHubRecords) window.SciHubRecords.openProjectDialog(); else showProjectModal(); });
document.getElementById('addEvidenceButton')?.addEventListener('click',addEvidence);
document.getElementById('helpButton').addEventListener('click',()=>toast('提示：从对话中的 AI 消息可以直接沉淀为可追溯的知识卡片。'));
document.getElementById('privacyButton').addEventListener('click',()=>toast('实验日志、对话与项目记忆保存为本地 Markdown 文件；知识卡片仍保存在本浏览器。'));
document.getElementById('notificationButton')?.addEventListener('click',()=>toast('当前有需要核验的研究线索，请在知识卡片中查看。'));
document.getElementById('fileInput').addEventListener('change',e=>handleFile(e.target.files[0]));
document.getElementById('conversationProjectFilter').addEventListener('change',renderConversations);
document.getElementById('cardSearch').addEventListener('input',e=>{cardFilters.search=e.target.value;renderCards();});
document.getElementById('typeFilter').addEventListener('change',e=>{cardFilters.type=e.target.value;renderCards();});
document.getElementById('statusFilter').addEventListener('change',e=>{cardFilters.status=e.target.value;renderCards();});
document.getElementById('projectFilter').addEventListener('change',e=>{cardFilters.project=e.target.value;renderCards();renderSidebar();});
document.getElementById('clearFilters').addEventListener('click',()=>{cardFilters={search:'',type:'all',status:'all',project:'all'};document.getElementById('cardSearch').value='';document.getElementById('typeFilter').value='all';document.getElementById('statusFilter').value='all';document.getElementById('projectFilter').value='all';renderCards();renderSidebar();});
document.getElementById('globalSearch').addEventListener('input',e=>{const q=e.target.value.trim();if(!q)return;cardFilters.search=q;document.getElementById('cardSearch').value=q;switchView('cards');renderCards();});
document.getElementById('menuButton').addEventListener('click',()=>document.querySelector('.sidebar').classList.toggle('open'));
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();document.getElementById('globalSearch').focus();}if(e.key==='Escape')closeModal();});

const now = new Date(); document.getElementById('todayLabel').textContent = `${now.getMonth()+1}月${now.getDate()}日 · 研究空间`;
// 供 records.js 复用
window.SciHubApp = { renderAll, toast, escapeHtml, switchView };
renderAll();
