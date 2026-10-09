const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('reviewed plan updates: legacy upgrade, snapshots, atomic adoption, stale review and ownership', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const db = new PGlite();
  const uid = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002';
  try {
    await db.exec(`create role authenticated; create role anon; create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated,anon;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id uuid primary key,bucket_id text,name text);
      create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
      create publication supabase_realtime; insert into auth.users values('${uid}'),('${other}');`);
    // Applied migrations form the old version; the candidate must not rewrite the fixture.
    for (const file of ['20260914120000_init.sql','20261008090000_atomic_experiment_writes.sql','20261008110000_parallel_experiment_merge.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations',file),'utf8'));
    }
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${uid}';`);
    const steps = Array.from({length:4},(_,position)=>({title:['称量','反应','洗涤','干燥'][position],instruction:'原始操作 '+position,fields:[{label:'质量',unit:'g',type:'number'}],notice:'原注意事项',duration_hint:'',pyro_seq:'',checklist:[]}));
    steps[0].checklist=['检查容器','记录批号'];
    const save = (id,stamp,items) => db.query('select research_save_plan($1,$2,$3,$4::jsonb,4,$5::jsonb,$6::timestamptz) as id',[id,'虚构方案','test.docx',JSON.stringify(items),'[]',stamp]);
    const id = (await save(null,null,steps)).rows[0].id;
    const run = (await db.query("insert into experiment_runs(user_id,plan_id,title,current_step) values(auth.uid(),$1,'进行中',1) returning id",[id])).rows[0].id;
    await db.query(`insert into run_steps(user_id,run_id,position,title,instruction,fields,notice,status,values,images,note,finished_at)
      select user_id,$1,position,title,instruction,fields,notice,case when position=0 then 'done' else 'pending' end,
      case when position=0 then '{"质量":0}'::jsonb else '{}'::jsonb end,
      case when position=0 then '[{"path":"${uid}/synthetic.jpg"}]'::jsonb else '[]'::jsonb end,
      case when position=0 then '保留备注' else '' end,case when position=0 then now() else null end from plan_steps where plan_id=$2`,[run,id]);
    await db.query(`update run_steps set checks='{"记录批号":false,"检查容器":true}' where run_id=$1 and position=0`,[run]);
    const snapshot = async () => (await db.query('select * from run_steps where run_id=$1 order by position',[run])).rows;
    await db.query("update run_steps set note='当前步骤已有记录' where run_id=$1 and position=1",[run]);
    const initial = await snapshot();
    await db.exec('reset role;');
    const proposal = fs.readFileSync(path.join(__dirname,'../docs/proposals/reviewed-plan-updates.sql'),'utf8');
    await db.exec(proposal); await db.exec(proposal);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${uid}';`);
    assert.deepEqual(await snapshot(),initial);
    const stamp = async () => (await db.query('select updated_at::text as s from experiment_plans where id=$1',[id])).rows[0].s;
    const review = async (candidate,runId=null) => (await db.query('select research_review_plan_update($1,$2::jsonb,$3) as r',[id,JSON.stringify(candidate),runId])).rows[0].r;
    const changed = structuredClone(steps); changed[2].instruction='新版洗涤'; changed.push({...steps[3],title:'新增表征'});
    const renamedCheck=structuredClone(changed); renamedCheck[0].checklist=['检查容器','记录新批号'];
    assert.equal((await review(renamedCheck)).allowed,false);
    for (const bad of [Object.assign(structuredClone(changed),{0:{...steps[0],instruction:'改写称量'}}),Object.assign(structuredClone(changed),{1:{...steps[1],fields:[{label:'质量',unit:'mg',type:'number'}]}}),[steps[1],steps[0],...steps.slice(2)]]) {
      assert.equal((await review(bad)).allowed,false);
      await assert.rejects(save(id,await stamp(),bad),/审核不通过/);
      assert.deepEqual(await snapshot(),initial);
    }
    const checked = await review(changed);
    assert.equal(checked.allowed,true); assert.equal(checked.runs[0].locked_through,1);
    const commit = (expected,candidate=changed) => db.query('select research_commit_plan_update($1,$2,$3,$4::jsonb,4,$5::jsonb,$6::timestamptz,$7::jsonb)',[id,'虚构方案','new.docx',JSON.stringify(candidate),'[]',expected.plan_updated_at,JSON.stringify(expected)]);
    await db.query("update run_steps set note='审核后记录' where run_id=$1 and position=1",[run]);
    await assert.rejects(commit(checked),/重新审核/);
    await commit(await review(changed));
    const savedSnapshot = await snapshot();
    assert.equal(savedSnapshot[2].instruction,'原始操作 2');
    assert.equal(savedSnapshot[0].values.质量,0); assert.deepEqual(savedSnapshot[0].images,initial[0].images);
    assert.deepEqual((await db.query('select id from plan_steps where plan_id=$1 order by position',[id])).rows.slice(0,4).map(x=>x.id),(await db.query('select before_snapshot from experiment_plan_update_audits where plan_id=$1',[id])).rows[0].before_snapshot.steps.map(x=>x.id));
    await assert.rejects(db.query("update run_steps set instruction='旁路改写' where run_id=$1",[run]),/permission denied/);
    await assert.rejects(db.query("update plan_steps set instruction='旁路改写' where plan_id=$1",[id]),/permission denied/);
    await assert.rejects(db.query('delete from run_steps where run_id=$1',[run]),/permission denied/);
    const candidates = async () => (await db.query('select * from plan_steps where plan_id=$1 order by position',[id])).rows;
    const adopt = expected => db.query('select research_adopt_plan_update($1,$2::jsonb,false)',[run,JSON.stringify(expected)]);
    const adoptReview = await review(await candidates(),run);
    // A legacy gap outside the protected prefix must not shift future definitions by array index.
    await db.exec('reset role;');
    await db.query('update plan_steps set position=9 where plan_id=$1 and position=4',[id]);
    await db.exec('set role authenticated;');
    await assert.rejects(adopt(await review(await candidates(),run)),/顺序异常/);
    assert.deepEqual(await snapshot(),savedSnapshot);
    await db.exec('reset role;');
    await db.query('update plan_steps set position=4 where plan_id=$1 and position=9',[id]);
    await db.exec('set role authenticated;');
    await db.query("update run_steps set values='{\"质量\":5}' where run_id=$1 and position=3",[run]);
    await assert.rejects(adopt(adoptReview),/重新审核/);
    assert.equal((await review(await candidates(),run)).allowed,false);
    // The later measurement must remain; clear only our isolated fictional fixture to test the alternate path.
    await db.query("update run_steps set values='{}' where run_id=$1 and position=3",[run]);
    const prefix = (await snapshot()).slice(0,2);
    const beforeAdopt = await snapshot();
    await db.exec(`reset role; alter table run_steps add constraint test_tail_failure check(title<>'新增表征'); set role authenticated;`);
    await assert.rejects(adopt(await review(await candidates(),run)),/test_tail_failure/);
    assert.deepEqual(await snapshot(),beforeAdopt);
    await db.exec('reset role; alter table run_steps drop constraint test_tail_failure; set role authenticated;');
    const accepted = await review(await candidates(),run);
    await adopt(accepted);
    await assert.rejects(adopt(accepted),/重新审核/);
    assert.deepEqual((await snapshot()).slice(0,2),prefix);
    assert.equal((await snapshot())[2].instruction,'新版洗涤');
    assert.equal((await snapshot()).length,5);
    const audit = (await db.query('select * from experiment_plan_update_audits order by id')).rows;
    assert.deepEqual(audit.map(x=>x.action),['save_plan','adopt_tail']);
    assert.deepEqual(audit[1].before_snapshot.steps[0].values,{质量:0});
    const fresh = (await db.query('select research_start_run($1,$2::timestamptz) as id',[id,await stamp()])).rows[0].id;
    assert.equal((await db.query('select count(*)::int n from run_steps where run_id=$1',[fresh])).rows[0].n,5);
    const shorter = (await candidates()).slice(0,4);
    await save(id,await stamp(),shorter);
    const shorterReview = await review(await candidates(),run);
    const beforeShorten = await snapshot();
    await assert.rejects(adopt(shorterReview),/明确批准/);
    assert.deepEqual(await snapshot(),beforeShorten);
    await db.query('select research_adopt_plan_update($1,$2::jsonb,true)',[run,JSON.stringify(shorterReview)]);
    assert.equal((await snapshot()).length,4);
    assert.deepEqual((await snapshot()).slice(0,2),prefix);
    const tailAudit=(await db.query("select before_snapshot from experiment_plan_update_audits where action='adopt_tail' order by id desc limit 1")).rows[0];
    assert.equal(tailAudit.before_snapshot.steps.length,5);
    await db.query("update run_steps set status='done' where run_id=$1",[fresh]);
    await db.query("select research_finish_run($1,'虚构完成日志',current_date)",[fresh]);
    const finishedBefore=(await db.query('select * from run_steps where run_id=$1 order by position',[fresh])).rows;
    const next=await candidates(); next[2].instruction='又一版后续操作';
    await save(id,await stamp(),next);
    assert.deepEqual((await db.query('select * from run_steps where run_id=$1 order by position',[fresh])).rows,finishedBefore);
    await db.exec(`set request.jwt.claim.sub='${other}';`);
    assert.equal((await db.query('select * from experiment_plan_update_audits')).rows.length,0);
    await assert.rejects(review(changed),/无权/);
    await assert.rejects(adopt(adoptReview),/不存在/);
    await db.exec('set role anon;');
    await assert.rejects(review(changed),/permission denied/);
  } finally {await db.close();}
});
