'use strict';
/* Public guide only: no account, research data, or external runtime dependencies. */
(() => {
  const search = document.getElementById('guide-search');
  const language = document.getElementById('guide-language');
  const procedures = Array.from(document.querySelectorAll('.guide-procedure'));
  const groups = Array.from(document.querySelectorAll('.guide-group'));
  const normalize = value => value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const text = new Map(procedures.map(item => [item.id, normalize(item.textContent)]));
  const filter = () => {
    const terms = normalize(search.value).split(' ').filter(Boolean);
    let count = 0;
    for (const item of procedures) {
      item.hidden = !terms.every(term => text.get(item.id).includes(term));
      if (!item.hidden) { count++; if (terms.length) item.open = true; }
    }
    for (const group of groups) group.hidden = !group.querySelector('.guide-procedure:not([hidden])');
    for (const link of document.querySelectorAll('.guide-toc a[href^="#"]')) {
      const target = document.getElementById(link.hash.slice(1));
      if (target && target.classList.contains('guide-procedure')) link.closest('li').hidden = target.hidden;
    }
    for (const group of document.querySelectorAll('.guide-toc-group')) {
      group.hidden = !group.querySelector('li:not([hidden])');
      if (terms.length && !group.hidden) group.open = true;
    }
    document.getElementById('guide-count').textContent = language.value === 'en'
      ? `${count} of ${procedures.length} procedures` : `${count} / ${procedures.length} 个操作流程`;
    document.getElementById('guide-empty').hidden = count > 0;
  };
  const openHash = () => {
    const target = document.getElementById(location.hash.slice(1));
    if (target && target.classList.contains('guide-procedure')) {
      search.value = ''; filter(); target.open = true;
      const toc = document.querySelector('.guide-toc a[href="#' + target.id + '"]');
      if (toc) toc.closest('details').open = true;
      target.scrollIntoView({ block: 'start' });
    }
  };
  search.addEventListener('input', filter);
  language.addEventListener('change', () => {
    document.documentElement.dataset.guideView = language.value;
    document.documentElement.lang = language.value === 'en' ? 'en' : 'zh-CN';
    filter();
  });
  document.getElementById('guide-expand').addEventListener('click', () => {
    const visible = procedures.filter(item => !item.hidden);
    const open = visible.some(item => !item.open);
    visible.forEach(item => { item.open = open; });
  });
  document.querySelector('.guide-toc').addEventListener('click', event => {
    if (event.target.closest('a[href^="#"]')) setTimeout(openHash, 0);
  });
  document.querySelector('.guide-quick').addEventListener('click', event => {
    if (event.target.closest('a[href^="#"]')) setTimeout(openHash, 0);
  });
  window.addEventListener('hashchange', openHash);
  let printState = null;
  const beforePrint = () => {
    if (printState) return;
    printState = [...groups, ...procedures].map(item => ({ item, hidden: item.hidden, open: item.open }));
    for (const entry of printState) {
      entry.item.hidden = false;
      if (entry.item instanceof HTMLDetailsElement) entry.item.open = true;
    }
  };
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', () => {
    if (!printState) return;
    for (const entry of printState) {
      entry.item.hidden = entry.hidden;
      if (entry.item instanceof HTMLDetailsElement) entry.item.open = entry.open;
    }
    printState = null;
  });
  document.getElementById('guide-print').addEventListener('click', () => window.print());
  filter(); openHash();
  const version = document.querySelector('meta[name="guide-version"]').content;
  async function checkVersion() {
    try {
      const response = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) return;
      const latest = (await response.json()).version;
      const host = document.getElementById('guide-update');
      if (!/^\d+\.\d+\.\d+$/.test(latest) || latest === version) { host.hidden = true; return; }
      const link = document.createElement('a');
      link.href = 'guide.html?v=' + latest + location.hash;
      link.textContent = `教程有新版本 v${latest}，点击更新 / Load the latest guide`;
      host.replaceChildren(link); host.hidden = false;
    } catch (_) { /* A cached guide still works offline. */ }
  }
  checkVersion(); setInterval(checkVersion, 5 * 60 * 1000);
})();
