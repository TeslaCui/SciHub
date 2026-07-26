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

  function switchView(view) {
    const target = document.getElementById(`${view}View`);
    if (!target) return;
    document.querySelectorAll('.view').forEach(item => item.classList.toggle('active-view', item === target));
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    document.querySelector('.sidebar')?.classList.remove('open');
    window.SciHubRecords?.onViewActivated(view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderAll() {
    // records.js owns all rendered content in the streamlined application.
  }

  window.switchView = switchView;
  window.SciHubApp = { renderAll, toast, escapeHtml, switchView };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
    document.getElementById('addProjectButton')?.addEventListener('click', () => window.SciHubRecords?.openProjectDialog());
    document.getElementById('topNewProjectButton')?.addEventListener('click', () => window.SciHubRecords?.openProjectDialog());
    document.getElementById('menuButton')?.addEventListener('click', () => document.querySelector('.sidebar')?.classList.toggle('open'));
    switchView('home');
  });
})();
