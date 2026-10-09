const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness(hash = '#home', user = {id:'test-owner'}) {
  const events = {}, nodes = new Map(), renders = [], messages = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden:false, classList:{toggle(){}}, innerHTML:'' });
    return nodes.get(id);
  };
  const location = { hash };
  const entries = [{hash,state:{scihubIndex:0}}]; let cursor = 0;
  const history = {
    get state() { return entries[cursor].state; },
    replaceState(state, _, hash) { entries[cursor] = {hash,state}; location.hash=hash; },
    pushState(state, _, hash) { entries.splice(cursor+1); entries.push({hash,state}); cursor++; location.hash=hash; },
    go(delta) { cursor+=delta; location.hash=entries[cursor].hash; return events.popstate(); },
  };
  const run = { busy:()=>false, flush:async()=>true, render:id=>renders.push('run/'+id) };
  const plans = { hasDraft:()=>false, stashDraft(){}, showDraft:()=>renders.push('draft'), list:()=>renders.push('plans'), editor:id=>renders.push('plan/'+id), closeMenu(){} };
  const context = vm.createContext({ history, location, state:{user}, $:node,
    window:{Run:run, Plans:plans, addEventListener:(name,fn)=>events[name]=fn, scrollTo(){}},
    document:{body:node('body'),querySelectorAll:()=>[],addEventListener(){}},
    setStatus:msg=>messages.push(msg),closeModal(){},closeUserMenu(){},renderHome:()=>renders.push('home'),
  });
  const source = fs.readFileSync(require.resolve('../app.js'),'utf8');
  vm.runInContext("let savingRecord=false, recordFormTarget=null; const ROUTES = ['home','plans','plan','draft','run','records','record','guide'];\n" + source.slice(source.indexOf('function showView('),source.indexOf('/* experiment.js 执行完')) + '\nrenderGuide = async () => {}; function showRecordForm(record) { recordFormTarget = record ? record.id : "new"; }',context);
  return {context,run,plans,history,location,entries,renders,messages,node,events,route:(...args)=>context.route(...args)};
}
test('back and forward restore views without adding history; repeated routes replace',async()=>{
  const h=harness(); await h.route('plans'); await h.route('plan',7); await h.route('plan',7);
  assert.equal(h.entries.length,3);
  await h.history.go(-1); assert.equal(h.location.hash,'#plans'); assert.equal(h.node('view-plans').hidden,false);
  await h.history.go(1); assert.equal(h.location.hash,'#plan/7'); assert.equal(h.node('view-plan').hidden,false);
  assert.equal(h.entries.length,3);
});
test('busy writes and failed saves restore the browser position and keep the current view',async()=>{
  const h=harness(); await h.route('run',9); h.run.busy=()=>true;
  await h.history.go(-1); assert.equal(h.location.hash,'#run/9'); assert.equal(h.node('view-run').hidden,false);
  h.run.busy=()=>false; h.run.flush=async()=>false;
  await h.history.go(-1); assert.equal(h.location.hash,'#run/9');
  h.run.flush=async()=>true; await h.history.go(-1); assert.equal(h.location.hash,'#home');
});
test('a slower save cannot navigate over a newer request',async()=>{
  const h=harness(); let release; h.run.flush=()=>new Promise(resolve=>release=resolve);
  const first=h.route('plans'); h.run.flush=async()=>true; await h.route('records'); release(true); await first;
  assert.equal(h.location.hash,'#records'); assert.equal(h.node('view-records').hidden,false);
});
test('draft history preserves editing in memory and falls back to preview after reload',async()=>{
  const h=harness(); let stashed=0; h.plans.hasDraft=()=>true; h.plans.stashDraft=()=>stashed++;
  await h.route('draft',4); await h.route('home'); await h.history.go(-1);
  assert.equal(stashed,1); assert.equal(h.location.hash,'#draft/4');
  h.plans.hasDraft=()=>false; await h.history.go(1); await h.history.go(-1);
  assert.equal(h.location.hash,'#plan/4'); await h.history.go(1); assert.equal(h.location.hash,'#home');
});
test('logged-out history cannot display private views; public guide remains accessible',async()=>{
  const h=harness('#run/8',null); await h.route('run',8,{replace:true});
  assert.equal(h.location.hash,'#home'); assert.equal(h.node('app-view').hidden,true);
  await h.route('guide','plan-import'); assert.equal(h.location.hash,'#guide/plan-import');
  assert.equal(h.node('auth-view').hidden,true); assert.equal(h.node('view-guide').hidden,false);
});
test('record forms participate in history and record saves block navigation',async()=>{
  const h=harness(); await h.route('records'); await h.route('record','new');
  assert.equal(h.location.hash,'#record/new'); assert.equal(h.node('record-form').hidden,false);
  await h.history.go(-1); assert.equal(h.node('record-form').hidden,true);
  await h.history.go(1); assert.equal(h.node('record-form').hidden,false);
  vm.runInContext('savingRecord=true',h.context); await h.history.go(-1);
  assert.equal(h.location.hash,'#record/new');
});
