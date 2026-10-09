'use strict';
/* Public guide only: no account, research data, or external runtime dependencies. */
(() => {
  function mount(root, onAnchor, version) {
    const find = id => root.querySelector('#' + id);
    const search = find('guide-search');
    const language = find('guide-language');
    const procedures = Array.from(root.querySelectorAll('.guide-procedure'));
    const groups = Array.from(root.querySelectorAll('.guide-group'));
    const anchorOf = link => link.hash.replace(/^#guide\//, '#').slice(1);
    root.querySelectorAll('a[href^="#"]').forEach(link => { link.href = '#guide/' + link.hash.slice(1); });
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
      for (const link of root.querySelectorAll('.guide-toc a[href^="#"]')) {
        const target = find(anchorOf(link));
        if (target && target.classList.contains('guide-procedure')) link.closest('li').hidden = target.hidden;
      }
      for (const group of root.querySelectorAll('.guide-toc-group')) {
        group.hidden = !group.querySelector('li:not([hidden])');
        if (terms.length && !group.hidden) group.open = true;
      }
      find('guide-count').textContent = language.value === 'en'
        ? `${count} of ${procedures.length} procedures` : `${count} / ${procedures.length} 个操作流程`;
      find('guide-empty').hidden = count > 0;
    };
    const openAnchor = anchor => {
      if (!/^[a-z][a-z0-9-]*$/.test(anchor || '')) return;
      const target = find(anchor);
      if (target) {
        search.value = ''; filter(); if (target.classList.contains('guide-procedure')) target.open = true;
        const toc = root.querySelector('.guide-toc a[href="#guide/' + target.id + '"]');
        if (toc) toc.closest('details').open = true;
        target.scrollIntoView({ block: 'start' });
      }
    };
    search.addEventListener('input', filter);
    language.addEventListener('change', () => {
      root.dataset.guideView = language.value;
      filter();
    });
    find('guide-expand').addEventListener('click', () => {
      const visible = procedures.filter(item => !item.hidden);
      const open = visible.some(item => !item.open);
      visible.forEach(item => { item.open = open; });
    });
    root.addEventListener('click', event => {
      const link = event.target.closest('a[href^="#"]');
      if (!link || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onAnchor(anchorOf(link));
    });
    let printState = null;
    const beforePrint = () => {
      if (printState || root.hidden) return;
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
    find('guide-print').addEventListener('click', () => window.print());
    filter();
    async function checkVersion() {
      try {
        const response = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
        if (!response.ok) return;
        const latest = (await response.json()).version;
        const host = find('guide-update');
        if (!/^\d+\.\d+\.\d+$/.test(latest) || latest === version) { host.hidden = true; return; }
        const link = document.createElement('a');
        link.href = 'index.html?v=' + latest + location.hash;
        link.textContent = `教程有新版本 v${latest}，点击更新 / Load the latest guide`;
        host.replaceChildren(link); host.hidden = false;
      } catch (_) { /* A cached guide still works offline. */ }
    }
    checkVersion(); setInterval(checkVersion, 5 * 60 * 1000);
    return { open: openAnchor };
  }
  window.SciHubGuide = { mount };
  if (document.querySelector('meta[name="guide-version"]')) {
    const anchor = /^[a-z][a-z0-9-]*$/.test(location.hash.slice(1)) ? '/' + location.hash.slice(1) : '';
    location.replace('index.html' + location.search + '#guide' + anchor);
  }
})();
