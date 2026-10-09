'use strict';
/* Dilution calculations are local; no experiment or account data is accessed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SciHubSolution = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  const REAGENTS = {
    nitric: { name: '硝酸 HNO₃', molarMass: 63.012, percent: '65', density: '1.40' },
    hydrochloric: { name: '盐酸 HCl', molarMass: 36.458, percent: '37', density: '1.19' }
  };
  function positive(value, label) {
    const text = String(value == null ? '' : value).trim();
    if (!text) throw new Error('请填写' + label + '。');
    if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?$/i.test(text)) throw new Error(label + '须为大于 0 的有效数字。');
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) throw new Error(label + '须为大于 0 的有效数字。');
    return n;
  }
  function calculate({ reagent, target, volume, volumeUnit = 'mL', mode = 'percent', percent, density, stockM }) {
    if (!Object.hasOwn(REAGENTS, reagent)) throw new Error('请选择硝酸或盐酸。');
    if (!['mL', 'L'].includes(volumeUnit)) throw new Error('配制体积单位须为 mL 或 L。');
    if (!['percent', 'molar'].includes(mode)) throw new Error('请选择原液浓度形式。');
    const targetM = positive(target, '目标浓度');
    const finalMl = positive(volume, '配制体积') * (volumeUnit === 'L' ? 1000 : 1);
    const rho = positive(density, '原液密度');
    const fraction = mode === 'percent' ? positive(percent, '原液质量分数') / 100 : null;
    if (fraction !== null && fraction > 1) throw new Error('原液质量分数不可超过 100%。');
    const concentration = mode === 'percent' ? 1000 * rho * fraction / REAGENTS[reagent].molarMass : positive(stockM, '原液摩尔浓度');
    if (!Number.isFinite(concentration) || concentration <= 0) throw new Error('原液参数超出可计算范围。');
    if (targetM > concentration) throw new Error('目标浓度超过原液浓度，无法通过稀释配制。');
    const stockMl = targetM / concentration * finalMl;
    const stockGrams = stockMl * rho;
    const moles = targetM * (finalMl / 1000);
    const result = { targetM, finalMl, density: rho, stockM: concentration, stockMl, stockGrams, moles };
    if (Object.values(result).some(n => !Number.isFinite(n) || n <= 0)) throw new Error('输入数值超出可计算范围。');
    return result;
  }
  const format = n => Number(n.toPrecision(8)).toString();
  return { REAGENTS, calculate, format };
});

(function () {
  if (typeof window === 'undefined') return;
  const api = window.SciHubSolution;
  const byId = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let inputs = { reagent: 'nitric', target: '', volume: '', volumeUnit: 'mL', mode: 'percent', percent: '65', density: '1.40', stockM: '' };
  function open() {
    const field = (id, label, value) => '<label>' + label + '<input id="sol-' + id + '" type="number" min="0" step="any" inputmode="decimal" value="' + escape(value) + '"></label>';
    const options = (values, current) => values.map(([value, label]) => '<option value="' + value + '"' + (value === current ? ' selected' : '') + '>' + label + '</option>').join('');
    openModal('配制溶液计算器',
      '<div class="platinum-input-grid">'
      + '<label>试剂<select id="sol-reagent">' + options(Object.entries(api.REAGENTS).map(([key, r]) => [key, r.name]), inputs.reagent) + '</select></label>'
      + field('target', '目标浓度（mol/L）', inputs.target)
      + field('volume', '配制体积', inputs.volume)
      + '<label>体积单位<select id="sol-volume-unit">' + options([['mL','mL'],['L','L']], inputs.volumeUnit) + '</select></label></div>'
      + '<h3>原液参数</h3><p class="hint">硝酸预设为 65%、1.40 g/mL；盐酸预设为 37%、1.19 g/mL。仅供参考，请按瓶签或证书核对实际浓度、密度及适用温度。</p>'
      + '<div class="platinum-input-grid"><label>浓度形式<select id="sol-mode">' + options([['percent','质量分数（%）'],['molar','摩尔浓度（mol/L）']], inputs.mode) + '</select></label>'
      + field('density','原液密度（g/mL）',inputs.density)
      + '<div id="sol-percent-field">' + field('percent','原液质量分数（%）',inputs.percent) + '</div>'
      + '<div id="sol-molar-field">' + field('stock-m','原液摩尔浓度（mol/L）',inputs.stockM) + '</div></div>'
      + '<div id="sol-result" role="status" aria-live="polite"></div>'
      + '<p class="hint">缓慢将酸加入水中，冷却后定容至目标体积。不要将水加入浓酸。加水量不能直接用配制体积减去原液体积。</p>'
      + '<p class="hint">结果为需加入原液的体积和质量。试算不自动写入实验记录。</p>',
      [{ label: '返回小工具', onClick: () => window.LabTools.open() }, { label: '关闭', onClick: closeModal }]);
    function draw() {
      inputs = { reagent: byId('sol-reagent').value, target: byId('sol-target').value, volume: byId('sol-volume').value,
        volumeUnit: byId('sol-volume-unit').value, mode: byId('sol-mode').value, percent: byId('sol-percent').value,
        density: byId('sol-density').value, stockM: byId('sol-stock-m').value };
      byId('sol-percent-field').hidden = inputs.mode !== 'percent';
      byId('sol-molar-field').hidden = inputs.mode !== 'molar';
      const out = byId('sol-result');
      try {
        const r = api.calculate(inputs), f = api.format;
        out.innerHTML = '<div class="platinum-result"><span>需加入原液</span><strong>' + f(r.stockMl) + ' <small>mL</small></strong><strong>' + f(r.stockGrams) + ' <small>g</small></strong></div>'
          + '<dl class="platinum-breakdown"><div><dt>原液摩尔浓度</dt><dd>' + f(r.stockM) + ' mol/L</dd></div><div><dt>最终配制体积</dt><dd>' + f(r.finalMl) + ' mL</dd></div></dl>';
      } catch (err) { out.innerHTML = '<p class="platinum-error">' + escape(err.message) + '</p>'; }
    }
    byId('sol-reagent').addEventListener('change', () => {
      const r = api.REAGENTS[byId('sol-reagent').value];
      byId('sol-percent').value = r.percent; byId('sol-density').value = r.density;
      byId('sol-stock-m').value = ''; draw();
    });
    ['target','volume','volume-unit','mode','density','percent','stock-m'].forEach(id => byId('sol-' + id).addEventListener('input', draw));
    draw();
  }
  window.SolutionTool = { open };
})();
