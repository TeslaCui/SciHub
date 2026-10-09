const test = require('node:test');
const assert = require('node:assert/strict');
const sol = require('../solution.js');
const nitric = { reagent:'nitric', target:0.1, volume:100, percent:65, density:1.4 };
const close = (a,b) => assert.ok(Math.abs(a-b) < Math.abs(b)*1e-12, `${a} != ${b}`);
test('100 mL of 0.1 M nitric acid conserves 0.01 mol with 65 percent stock', () => {
  const r = sol.calculate(nitric);
  close(r.moles,0.01); close(r.stockGrams,0.9694153846153846); close(r.stockMl,0.6924395604395605);
  close(r.stockGrams*0.65,0.63012);
  assert.deepEqual(r,sol.calculate({...nitric,volume:0.1,volumeUnit:'L'}));
});
test('hydrochloric mass fraction and molar stock modes produce the same dose', () => {
  const r = sol.calculate({...nitric,reagent:'hydrochloric',percent:37,density:1.19});
  close(r.stockGrams,0.9853513513513513); close(r.stockMl,0.8280263456734045);
  const m = sol.calculate({...nitric,reagent:'hydrochloric',density:1.19,mode:'molar',stockM:r.stockM,percent:''});
  assert.deepEqual(r,m);
  const standard = sol.calculate({...nitric,mode:'molar',stockM:1,density:1.02});
  close(standard.stockMl,10); close(standard.stockGrams,10.2);
});
test('dilution rejects missing, negative, zero, concentrated targets and invalid units', () => {
  for (const key of ['target','volume','percent','density']) for (const value of ['',null,undefined,0,-1,Infinity,'0x10','NaN']) {
    assert.throws(() => sol.calculate({...nitric,[key]:value}));
  }
  for (const item of [{reagent:'__proto__'},{volumeUnit:'g'},{mode:'unknown'},{percent:101},{target:100},{volume:1e308,volumeUnit:'L'},
    {density:1e-320},{mode:'molar',stockM:''},{mode:'molar',stockM:0},{mode:'molar',stockM:Infinity}]) assert.throws(()=>sol.calculate({...nitric,...item}));
});
test('equal stock concentration and tiny doses retain valid results', () => {
  const r = sol.calculate({...nitric,mode:'molar',stockM:0.1});
  assert.equal(r.stockMl,100);
  assert.ok(Number(sol.format(sol.calculate({...nitric,volume:1e-10}).stockMl))>0);
});
