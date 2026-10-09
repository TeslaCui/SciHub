const test = require('node:test');
const assert = require('node:assert/strict');
const pt = require('../platinum.js');
const synthetic = { mass: 50, fePercent: 2, ratio: '3:2', ptPercent: 10 };
const close = (a,b) => assert.ok(Math.abs(a-b) <= Math.max(1e-12,Math.abs(b)*1e-12), `${a} != ${b}`);

test('platinum calculator follows molar stoichiometry and reagent Pt mass fraction', () => {
  const r=pt.calculate(synthetic);
  close(r.feMassMg,1); close(r.feMmol,1/55.845); close(r.ptMmol,1.5/55.845);
  close(r.ptMassMg,5.2399677679291); close(r.reagentMg,52.399677679291);
  close(r.reagentG,0.052399677679291);
  assert.equal(r.ratio,1.5);
  assert.deepEqual(pt.calculate({...synthetic,mass:0.05,massUnit:'g'}),r);
  assert.deepEqual(pt.calculate({...synthetic,ratio:'1.5'}),r);
  assert.deepEqual(pt.calculate({...synthetic,ratio:'3：2'}),r);
});

test('platinum calculator preserves zero and tiny valid outputs without accepting missing input', () => {
  for (const item of [{mass:0},{fePercent:0},{ratio:0}]) assert.equal(pt.calculate({...synthetic,...item}).reagentMg,0);
  const tiny=pt.calculate({...synthetic,mass:1e-10}).reagentMg;
  assert.ok(tiny>0); assert.ok(Number(pt.format(tiny))>0);
  for (const key of ['mass','fePercent','ratio','ptPercent']) {
    for (const blank of ['',null,' ']) assert.throws(()=>pt.calculate({...synthetic,[key]:blank}),/请填写/);
    if (key !== 'ptPercent') assert.throws(()=>pt.calculate({...synthetic,[key]:undefined}),/请填写/);
  }
});

test('invalid percentages, mass units, ratios, and overflow cannot produce plausible dosing results', () => {
  for (const item of [{mass:-1},{mass:'NaN'},{mass:Infinity},{mass:'0x10'},{massUnit:'mL'},
    {fePercent:-1},{fePercent:100.1},{ptPercent:0},{ptPercent:-1},{ptPercent:103.8},
    {ratio:'1:0'},{ratio:'-1:1'},{ratio:'1:-2'},{ratio:'1:2:3'},{ratio:'1:'},{mass:1e308,massUnit:'g'}]) {
    assert.throws(()=>pt.calculate({...synthetic,...item}));
  }
  close(pt.calculate({...synthetic,ptPercent:20}).reagentMg,pt.calculate(synthetic).reagentMg/2);
});
