/* Build both public guides from one reviewed source. No third-party dependencies. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const SOURCE = 'docs/user-guide.source.cjs';
const REVIEW = 'docs/user-guide-review.json';
const REVIEW_SOURCES = ['index.html', 'app.js', 'experiment.js', 'platinum.js', 'merge.js', 'data-safety.js', 'supabase_schema.sql',
  'guide.js', 'supabase/functions/_shared/ai.ts', 'supabase/functions/parse-plan/index.ts',
  'supabase/functions/match-params/index.ts', 'supabase/functions/check-link/index.ts', 'supabase/functions/todo-plan/index.ts'];
const normalize = text => text.replace(/\r\n/g, '\n');
const hash = text => crypto.createHash('sha256').update(normalize(text)).digest('hex');
const escape = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function load(source) {
  const context = { module: { exports: {} } };
  vm.runInNewContext(source, context, { timeout: 1000, filename: SOURCE });
  return JSON.parse(JSON.stringify(context.module.exports));
}
function validate(guide, release) {
  assert.equal(guide.version, release.version, '教程版本必须与软件版本一致；先审阅操作说明，再更新教程版本');
  assert.equal(guide.updated, release.updated, '教程发布日期必须与软件版本一致');
  const pair = value => assert.ok(value && typeof value.en === 'string' && value.en.trim()
    && typeof value.zh === 'string' && value.zh.trim(), '每项内容必须含英文与中文');
  const sentence = (value, limit) => {
    pair(value);
    for (const part of value.en.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const words = part.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) || [];
      assert.ok(words.length <= limit, `英文句子超过 ${limit} 词：${part}`);
    }
    assert.ok(!/\b(?:can't|don't|won't|isn't|it's|you'll)\b/i.test(value.en), '英文不得使用缩写式否定或缩约词');
  };
  const groups = new Set(), ids = new Set();
  for (const group of guide.groups) { assert.ok(!groups.has(group.id)); groups.add(group.id); pair(group.title); }
  for (const item of guide.procedures) {
    assert.match(item.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(!ids.has(item.id), '重复操作 ID：' + item.id); ids.add(item.id);
    assert.ok(groups.has(item.group), '未知章节：' + item.group);
    pair(item.title); sentence(item.before, 25); sentence(item.result, 25);
    assert.ok(item.steps.length, '流程不能缺少步骤：' + item.id);
    item.steps.forEach(step => sentence(step, 20));
    [...item.notes, ...item.caution].forEach(note => sentence(note, 25));
    if (['todo-remove', 'record-delete', 'plan-order', 'plan-delete', 'run-extra', 'run-delete', 'media-delete', 'merge-review'].includes(item.id)) {
      assert.ok(item.caution.length, '涉及删除或冻结的流程必须保留操作前提醒：' + item.id);
    }
  }
  for (const group of guide.groups) assert.ok(guide.procedures.some(item => item.group === group.id), '章节无操作');
  for (const item of guide.glossary) { pair(item.term); sentence(item.definition, 25); }
  pair(guide.standard.status);
  return guide;
}
const label = (en, zh) => ({ en, zh });
function render(guide) {
  const dual = (value, tag = 'span') => `<${tag} class="guide-en" lang="en">${escape(value.en)}</${tag}><${tag} class="guide-zh" lang="zh-CN">${escape(value.zh)}</${tag}>`;
  const heading = value => `<span class="guide-zh" lang="zh-CN">${escape(value.zh)}</span><span class="guide-en" lang="en">${escape(value.en)}</span>`;
  const labels = {before:label('Before you start','开始前'), steps:label('Procedure','操作步骤'), result:label('Result','预期结果'),
    caution:label('CAUTION — Data and operation limits','注意 — 数据及操作影响'),notes:label('Notes','说明')};
  const list = (items, type = 'ul') => `<${type}>${items.map(item => '<li>' + dual(item, 'p') + '</li>').join('')}</${type}>`;
  const contents = guide.groups.map(group => `<details class="guide-toc-group"><summary>${heading(group.title)}</summary><ul>`
    + guide.procedures.filter(item => item.group === group.id).map(item => `<li><a href="#${item.id}">${heading(item.title)}</a></li>`).join('') + '</ul></details>').join('\n');
  const sections = guide.groups.map(group => `<section class="guide-group" data-group="${group.id}"><h2>${heading(group.title)}</h2>`
    + guide.procedures.filter(item => item.group === group.id).map(item => `<details class="guide-procedure" id="${item.id}"><summary><h3>${heading(item.title)}</h3></summary><div class="guide-procedure-body">`
      + `<h4>${dual(labels.before)}</h4>${dual(item.before,'p')}`
      + (item.caution.length ? `<aside class="guide-caution"><h4>${dual(labels.caution)}</h4>${list(item.caution)}</aside>` : '')
      + `<h4>${dual(labels.steps)}</h4>${list(item.steps,'ol')}<div class="guide-result"><h4>${dual(labels.result)}</h4>${dual(item.result,'p')}</div>`
      + (item.notes.length ? `<h4>${dual(labels.notes)}</h4>${list(item.notes)}` : '')
      + `<a class="guide-permalink" href="#${item.id}">${dual(label('Link to this procedure','此流程链接'))}</a></div></details>`).join('\n') + '</section>').join('\n');
  const html = `<!DOCTYPE html>
<!-- Generated by tools/build-guide.cjs. Edit docs/user-guide.source.cjs. -->
<html lang="zh-CN" data-guide-view="both"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="guide-version" content="${guide.version}"><meta name="description" content="SciHub 使用教程：账号、方案、实验、附件、合并与数据保护。英文简明技术写作与中文对照。">
<title>SciHub 使用教程 · v${guide.version}</title><link rel="stylesheet" href="guide.css?v=${guide.version}"><script src="guide.js?v=${guide.version}" defer></script></head>
<body><a class="guide-skip" href="#guide-content">跳到操作说明 / Skip to procedures</a>
<header class="guide-header"><a class="guide-brand" href="./index.html"><span class="guide-logo">Sci</span><span>SciHub <small>使用教程 · User guide</small></span></a>
<nav aria-label="教程链接"><a href="./index.html">返回软件</a><a href="https://github.com/TeslaCui/SciHub/blob/master/docs/USER-GUIDE.md" target="_blank" rel="noopener">GitHub 教程</a></nav></header>
<main class="guide-layout"><aside class="guide-sidebar"><div class="guide-controls"><label for="guide-search">搜索操作 / Find a procedure</label>
<input id="guide-search" type="search" placeholder="如：合并、照片、save" autocomplete="off"><label for="guide-language">显示语言 / Language</label>
<select id="guide-language"><option value="both">English + 中文</option><option value="zh">中文</option><option value="en">English</option></select>
<p id="guide-count" role="status" aria-live="polite">${guide.procedures.length} 个操作流程</p><div class="guide-control-actions"><button id="guide-expand" type="button">展开结果 / Expand</button><button id="guide-print" type="button">打印 / Print</button></div></div>
<nav class="guide-toc" aria-label="操作目录">${contents}<a href="#glossary">术语表 / Technical terms</a></nav></aside>
<article id="guide-content"><div class="guide-intro"><p class="guide-eyebrow">SCIHUB · USER GUIDE</p><h1>按步骤完成科研记录<span>Work with clear procedures</span></h1>
<p class="guide-version">软件与教程 v${guide.version} · ${guide.updated} · ${guide.procedures.length} 个流程</p>
<p>英文操作说明采用 ASD-STE100 简明技术写作原则。中文逐项对照，按钮名称与软件一致。</p>
<p class="guide-standard">${dual(guide.standard.status)} <a href="${guide.standard.reference}" target="_blank" rel="noopener">ASD-STE100 官方说明</a></p>
<p id="guide-update" role="status" hidden></p><noscript><p>未启用 JavaScript：目录和流程仍可阅读；搜索、语言切换及版本检查不可用。</p></noscript>
<div class="guide-quick"><a href="#plan-import">导入方案</a><a href="#run-data">填写数据</a><a href="#merge-review">合并审核</a><a href="#save-recovery">保存失败</a></div></div>
<p id="guide-empty" hidden>没有匹配的操作。清空搜索或换一个关键词。 / No matching procedure. Change the search text.</p>
${sections}<section id="glossary" class="guide-glossary"><h2>术语表 / Technical terms</h2><dl>${guide.glossary.map(item => `<div><dt>${dual(item.term)}</dt><dd>${dual(item.definition,'p')}</dd></div>`).join('')}</dl></section>
<footer class="guide-footer">v${guide.version} · 教程随软件发布同步更新；旧版可在 GitHub 提交历史查看。</footer></article></main></body></html>
`;
  const mdPair = value => `${value.en}\n\n${value.zh}`;
  const mdList = items => items.map(item => `- ${item.en}\n\n  ${item.zh}`).join('\n\n');
  let markdown = `<!-- Generated by tools/build-guide.cjs. Edit user-guide.source.cjs. -->\n# SciHub User Guide · 使用教程\n\nSoftware and guide version: **v${guide.version}** · ${guide.updated}\n\n软件与教程版本：**v${guide.version}** · ${guide.updated}\n\n[网站教程](https://teslacui.github.io/SciHub/guide.html?v=${guide.version}) · [返回软件](https://teslacui.github.io/SciHub/)\n\n${mdPair(guide.standard.status)}\n\n[ASD-STE100 官方说明](${guide.standard.reference})。英文流程采用短句、主动指令和一致术语；中文为逐项对照。\n\n## Contents · 目录\n\n`;
  markdown += guide.groups.map(group => `- [${group.title.en} · ${group.title.zh}](#group-${group.id})`).join('\n') + '\n\n';
  for (const group of guide.groups) {
    markdown += `<a id="group-${group.id}"></a>\n\n## ${group.title.en} · ${group.title.zh}\n\n`;
    for (const item of guide.procedures.filter(item => item.group === group.id)) {
      markdown += `<a id="${item.id}"></a>\n\n### ${item.title.en} · ${item.title.zh}\n\n**Before you start · 开始前**\n\n${mdPair(item.before)}\n\n`;
      if (item.caution.length) markdown += `**CAUTION · 注意**\n\n${mdList(item.caution)}\n\n`;
      markdown += '**Procedure · 操作步骤**\n\n' + item.steps.map((step, i) => `${i+1}. ${step.en}\n\n   ${step.zh}`).join('\n\n') + '\n\n';
      markdown += `**Result · 预期结果**\n\n${mdPair(item.result)}\n\n`;
      if (item.notes.length) markdown += `**Notes · 说明**\n\n${mdList(item.notes)}\n\n`;
    }
  }
  markdown += '## Technical terms · 术语表\n\n| Term · 术语 | Meaning · 含义 |\n| --- | --- |\n';
  markdown += guide.glossary.map(item => `| ${item.term.en} · ${item.term.zh} | ${item.definition.en} ${item.definition.zh} |`).join('\n') + '\n';
  return { 'guide.html': html, 'docs/USER-GUIDE.md': markdown };
}
function check(read) {
  const guide = validate(load(read(SOURCE)), JSON.parse(read('version.json')));
  const review = JSON.parse(read(REVIEW));
  assert.equal(review.version, guide.version, '教程审阅记录版本过期');
  assert.equal(review.guideSourceHash, hash(read(SOURCE)), '教程内容已改变，需要重新审阅');
  for (const file of REVIEW_SOURCES) assert.equal(review.sourceHashes[file], hash(read(file)), '功能源码变化，需复核教程：' + file);
  for (const [file, content] of Object.entries(render(guide))) assert.equal(normalize(read(file)), content, '教程产物过期：' + file);
  return guide;
}
module.exports = { load, validate, render, check, hash, REVIEW_SOURCES, SOURCE, REVIEW };
if (require.main === module) {
  try {
    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    if (process.argv.includes('--check')) {
      const guide = check(read); console.log(`教程检查通过：v${guide.version}，${guide.procedures.length} 个双语流程`);
    } else {
      const guide = validate(load(read(SOURCE)), JSON.parse(read('version.json')));
      if (process.argv.includes('--review')) {
        const review = { version: guide.version, reviewed: guide.updated, guideSourceHash: hash(read(SOURCE)),
          sourceHashes: Object.fromEntries(REVIEW_SOURCES.map(file => [file, hash(read(file))])) };
        fs.writeFileSync(path.join(root, REVIEW), JSON.stringify(review, null, 2) + '\n');
      }
      for (const [file, content] of Object.entries(render(guide))) fs.writeFileSync(path.join(root, file), content);
      console.log('已生成网站和 GitHub 教程；请使用 --check 核对审阅记录。');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
