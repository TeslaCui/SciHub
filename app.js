(() => {
  'use strict';

  const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[c]));

  function toast(message) {
    const element = document.getElementById('toast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 2800);
  }

  const SIDEBAR_STATE_KEY = 'scihub-sidebar-collapsed';

  function setSidebarCollapsed(collapsed) {
    const shell = document.querySelector('.app-shell');
    const button = document.getElementById('sidebarCollapseButton');
    shell?.classList.toggle('sidebar-collapsed', collapsed);
    if (button) {
      button.textContent = collapsed ? '›' : '‹';
      button.setAttribute('aria-label', collapsed ? '展开左侧栏' : '收起左侧栏');
      button.title = collapsed ? '展开左侧栏' : '收起左侧栏';
    }
    try { localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? '1' : '0'); } catch { /* 存储不可用时不影响界面 */ }
  }

  function switchView(view) {
    const target = document.getElementById(`${view}View`);
    if (!target) return;
    document.querySelectorAll('.view').forEach(item => item.classList.toggle('active-view', item === target));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    // 子实验版本切换仅服务于方案书阅览；切换离开时立即收起，
    // 不依赖异步的方案数据渲染完成。
    const planBookSwitcher = document.getElementById('planBookSwitcher');
    if (planBookSwitcher) planBookSwitcher.hidden = view !== 'planBook';
    document.querySelector('.sidebar')?.classList.remove('open');
    window.SciHubRecords?.onViewActivated(view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderAll() {
    // records.js owns all rendered content in the streamlined application.
  }

  window.switchView = switchView;
  window.SciHubApp = { renderAll, toast, escapeHtml, switchView, setSidebarCollapsed };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
    document.getElementById('addProjectButton')?.addEventListener('click', () => window.SciHubRecords?.openProjectDialog());
    document.getElementById('homeLogoButton')?.addEventListener('click', () => switchView('home'));
    document.getElementById('menuButton')?.addEventListener('click', () => document.querySelector('.sidebar')?.classList.toggle('open'));
    let sidebarCollapsed = false;
    try { sidebarCollapsed = localStorage.getItem(SIDEBAR_STATE_KEY) === '1'; } catch { /* 使用默认展开 */ }
    setSidebarCollapsed(sidebarCollapsed);
    document.getElementById('sidebarCollapseButton')?.addEventListener('click', () => {
      setSidebarCollapsed(!document.querySelector('.app-shell')?.classList.contains('sidebar-collapsed'));
    });
    switchView('home');
  });
})();
