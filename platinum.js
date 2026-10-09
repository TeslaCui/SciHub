'use strict';

/* Reagent mass from FeNC mass, Fe mass percent, and the Pt:Fe molar ratio.
 * Calculation constants follow the supplied workbook's calculation sheet.
 * No experiment records or account data are read or written. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SciHubPlatinum = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  const FE_MOLAR_MASS = 55.845;
  const PT_MOLAR_MASS = 195.084;
  const DEFAULT_PT_PERCENT = 3.80761816451526;

  function number(value, label) {
    const text = String(value == null ? '' : value).trim();
    if (!text) throw new Error('请填写' + label + '。');
    if (!/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?$/i.test(text)) throw new Error(label + '须为有效数字。');
    const result = Number(text);
    if (!Number.isFinite(result)) throw new Error(label + '超出可计算范围。');
    return result;
  }

  function molarRatio(value) {
    const parts = String(value == null ? '' : value).trim().split(/[:：]/);
    if (parts.length > 2) throw new Error('Pt:Fe 摩尔比请填写数字或 Pt:Fe，例如 2 或 2:1。');
    const pt = number(parts[0], 'Pt:Fe 摩尔比');
    const fe = parts.length === 2 ? number(parts[1], 'Fe 比例') : 1;
    if (pt < 0 || fe <= 0) throw new Error('Pt 比例不可小于 0，Fe 比例须大于 0。');
    const ratio = pt / fe;
    if (!Number.isFinite(ratio)) throw new Error('Pt:Fe 摩尔比超出可计算范围。');
    return ratio;
  }

  function calculate({ mass, massUnit = 'mg', fePercent, ratio, ptPercent = DEFAULT_PT_PERCENT }) {
    const amount = number(mass, 'FeNC 用量');
    if (massUnit !== 'mg' && massUnit !== 'g') throw new Error('FeNC 用量单位须为 mg 或 g。');
    if (amount < 0) throw new Error('FeNC 用量不可小于 0。');
    const ironPercent = number(fePercent, 'Fe wt%');
    if (ironPercent < 0 || ironPercent > 100) throw new Error('Fe wt% 须在 0–100% 之间。');
    const platinumPercent = number(ptPercent, '试剂 Pt 质量分数');
    if (platinumPercent <= 0 || platinumPercent > 100) throw new Error('试剂 Pt 质量分数须大于 0%，且不可超过 100%。');
    const ratioNumber = molarRatio(ratio);
    const massMg = amount * (massUnit === 'g' ? 1000 : 1);
    const feMassMg = massMg * (ironPercent / 100);
    const feMmol = feMassMg / FE_MOLAR_MASS;
    const ptMmol = feMmol * ratioNumber;
    const ptMassMg = ptMmol * PT_MOLAR_MASS;
    const reagentMg = ptMassMg / (platinumPercent / 100);
    const result = { massMg, fePercent: ironPercent, ratio: ratioNumber, ptPercent: platinumPercent,
      feMassMg, feMmol, ptMmol, ptMassMg, reagentMg, reagentG: reagentMg / 1000 };
    if (Object.values(result).some(value => !Number.isFinite(value))) throw new Error('输入数值超出可计算范围，请使用实验实际用量。');
    return result;
  }

  function format(value) {
    if (value === 0) return '0';
    // Display significant figures without rounding tiny valid masses down to zero.
    return Number(value.toPrecision(10)).toString();
  }
  return { calculate, molarRatio, format, FE_MOLAR_MASS, PT_MOLAR_MASS, DEFAULT_PT_PERCENT };
});

(function () {
  if (typeof window === 'undefined') return;
  const calculator = window.SciHubPlatinum;
  const byId = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  // Keep trial input only in memory during this page session.
  let inputs = { mass: '', massUnit: 'mg', fePercent: '', ratio: '', ptPercent: String(calculator.DEFAULT_PT_PERCENT) };

  function openMenu() {
    openModal('小工具', '<div class="lab-tool-menu">'
      + '<button type="button" class="ghost" id="tool-solution">配制溶液计算器<span>硝酸、盐酸的原液体积与质量</span></button>'
      + '<button type="button" class="ghost" id="tool-platinum">铂氯酸计算器<span>FeNC 用量、Fe wt% 与 Pt:Fe 摩尔比</span></button>'
      + '<button type="button" class="ghost" id="tool-pyro">热解程序计算器<span>程序串与分段时长</span></button></div>',
    [{ label: '关闭', onClick: closeModal }]);
    byId('tool-platinum').addEventListener('click', openCalculator);
    byId('tool-solution').addEventListener('click', () => window.SolutionTool.open());
    byId('tool-pyro').addEventListener('click', () => {
      if (window.Tools && window.Tools.openPyroCalculator) window.Tools.openPyroCalculator();
      else setStatus('热解计算器暂不可用，请刷新重试。', 'warn');
    });
  }

  function openCalculator() {
    openModal('铂氯酸计算器', [
      '<p class="hint">按 FeNC 中的 Fe 质量及目标 Pt:Fe 摩尔比计算投料。</p>',
      '<div class="platinum-input-grid">',
      '<label>FeNC 用量<input id="pt-mass" type="number" inputmode="decimal" min="0" step="any" placeholder="输入用量" value="' + escape(inputs.mass) + '"></label>',
      '<label>用量单位<select id="pt-mass-unit"><option value="mg"' + (inputs.massUnit === 'mg' ? ' selected' : '') + '>mg</option><option value="g"' + (inputs.massUnit === 'g' ? ' selected' : '') + '>g</option></select></label>',
      '<label>Fe wt%<input id="pt-fe-percent" type="number" inputmode="decimal" min="0" max="100" step="any" placeholder="1 表示 1%" value="' + escape(inputs.fePercent) + '"></label>',
      '<label>Pt:Fe 摩尔比<input id="pt-ratio" type="text" inputmode="text" placeholder="如 2 或 2:1" value="' + escape(inputs.ratio) + '"></label>',
      '</div>',
      '<p class="hint">Fe wt% 填百分数；Pt:Fe 按物质的量计算。例如 2:1 表示 n(Pt)/n(Fe) = 2。</p>',
      '<details class="platinum-parameters"><summary>试剂参数与计算公式</summary>',
      '<label>试剂 Pt 质量分数（%）<input id="pt-reagent-percent" type="number" inputmode="decimal" min="0" max="100" step="any" value="' + escape(inputs.ptPercent) + '"></label>',
      '<p class="hint">请按实际试剂或溶液的 Pt 质量分数设置。此项不是试剂纯度。</p>',
      '<p class="hint">Fe = 55.845 g/mol；Pt = 195.084 g/mol。</p>',
      '<p class="platinum-formula">m(试剂) = m(FeNC) × Fe wt% ÷ 100 ÷ 55.845 × n(Pt)/n(Fe) × 195.084 ÷ (试剂 Pt 质量分数 ÷ 100)</p>',
      '</details>',
      '<div id="pt-result" role="status" aria-live="polite"></div>',
      '<p class="hint">结果为含铂试剂的质量。溶液按质量计量；如需体积，还需要密度。请在实验记录中注明 Fe wt% 来源及实际投料，试算不自动写入记录。</p>',
    ].join(''), [{ label: '返回小工具', onClick: openMenu }, { label: '关闭', onClick: closeModal }]);

    function draw() {
      inputs = { mass: byId('pt-mass').value, massUnit: byId('pt-mass-unit').value,
        fePercent: byId('pt-fe-percent').value, ratio: byId('pt-ratio').value, ptPercent: byId('pt-reagent-percent').value };
      const out = byId('pt-result');
      try {
        const r = calculator.calculate(inputs);
        const show = calculator.format;
        out.innerHTML = '<div class="platinum-result"><span>需加入铂氯酸质量</span><strong>' + show(r.reagentMg)
          + ' <small>mg</small></strong><p>' + show(r.reagentG) + ' g</p></div>'
          + '<dl class="platinum-breakdown"><div><dt>Fe 质量</dt><dd>' + show(r.feMassMg) + ' mg</dd></div>'
          + '<div><dt>Fe 物质的量</dt><dd>' + show(r.feMmol) + ' mmol</dd></div>'
          + '<div><dt>目标 Pt 物质的量</dt><dd>' + show(r.ptMmol) + ' mmol</dd></div>'
          + '<div><dt>目标 Pt 质量</dt><dd>' + show(r.ptMassMg) + ' mg</dd></div>'
          + '<div><dt>试剂 Pt 质量分数</dt><dd>' + show(r.ptPercent) + '%</dd></div></dl>';
      } catch (err) {
        out.innerHTML = '<p class="platinum-error">' + escape(err.message) + '</p>';
      }
    }
    ['pt-mass', 'pt-mass-unit', 'pt-fe-percent', 'pt-ratio', 'pt-reagent-percent'].forEach(id => byId(id).addEventListener('input', draw));
    draw();
  }
  window.LabTools = { open: openMenu, openPlatinumCalculator: openCalculator };
})();
