const test = require('node:test');
const assert = require('node:assert/strict');
const safety = require('../data-safety.js');
const steps = [0,1,2].map(position=>({position,title:'工序 '+position,instruction:'原操作 '+position,fields:[{label:'质量',unit:'g',type:'number'}],values:{},images:[],status:'pending'}));
const run={id:1,status:'running',title:'虚构实验',current_step:1};
test('plan review protects completed and recorded prefix; browsing current step does not lock it',()=>{
  const baseline=structuredClone(steps); baseline[0].status='done'; baseline[0].values={质量:0}; baseline[0].images=[{path:'synthetic.jpg'}];
  const candidate=structuredClone(steps); candidate[2].instruction='允许修改未来操作';
  assert.equal(safety.reviewPlanUpdate(candidate,[run],{1:baseline}).allowed,true);
  candidate[1].fields[0].unit='mg';
  assert.equal(safety.reviewPlanUpdate(candidate,[run],{1:baseline}).allowed,true);
  candidate[1].fields[0].unit='g'; baseline[2].values={质量:0};
  assert.equal(safety.reviewPlanUpdate(candidate,[run],{1:baseline}).allowed,false);
  assert.equal(safety.reviewPlanUpdate(candidate,[{...run,status:'done'}],{1:baseline}).allowed,true);
  baseline[2].values={}; baseline[2].started_at='2026-10-08T00:00:00Z';
  assert.equal(safety.reviewPlanUpdate(candidate,[run],{1:baseline}).allowed,true);
});
test('review does not hide changed numeric whitespace, field metadata, order or deletions',()=>{
  const before=structuredClone(steps), after=structuredClone(steps);
  before[0].instruction='1 0 mg'; after[0].instruction='10 mg'; before[0].status='done'; before[2].values={质量:0};
  assert.equal(safety.reviewPlanUpdate(after,[run],{1:before}).allowed,false);
  assert.equal(safety.reviewPlanUpdate([steps[1],steps[0],steps[2]],[run],{1:before}).allowed,false);
  assert.equal(safety.reviewPlanUpdate([steps[0]],[run],{1:before}).allowed,false);
  const changed=safety.planUpdateChanges(steps,[steps[0],steps[1]]);
  assert.equal(changed[0].action,'移除'); assert.equal(changed[0].position,2);
  assert.equal(JSON.stringify(safety.updateStepSchema({fields:[{label:'x',unit:'g'}]})),JSON.stringify(safety.updateStepSchema({fields:[{unit:'g',label:'x',type:''}]})));
});

test('legacy completion names match run check keys without comparing completion values',()=>{
  const candidate=structuredClone(steps), before=structuredClone(steps);
  candidate[0].checklist=['检查容器','记录批号'];
  before[0].checks={'记录批号':false,'检查容器':true};
  assert.equal(safety.reviewPlanUpdate(candidate,[run],{1:before}).allowed,true);
  candidate[0].checklist=['检查容器','记录新批号'];
  assert.equal(safety.reviewPlanUpdate(candidate,[run],{1:before}).allowed,false);
  assert.deepEqual(before[0].checks,{'记录批号':false,'检查容器':true});
});
