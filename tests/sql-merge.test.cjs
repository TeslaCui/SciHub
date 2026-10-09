const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('PostgreSQL merge gates, atomicity, ownership, freeze and retry', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const db = new PGlite();
  const owner = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002';
  try {
    await db.exec(`create role authenticated; create role anon; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated,anon;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id uuid primary key,bucket_id text,name text);
      create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
      create publication supabase_realtime; insert into auth.users values('${owner}'),('${other}');`);
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase_schema.sql'), 'utf8'));
    const migration = path.join(__dirname, '../supabase/migrations/20261008110000_parallel_experiment_merge.sql');
    const source = fs.readFileSync(fs.existsSync(migration) ? migration : path.join(__dirname, '../docs/proposals/parallel-experiment-merge.sql'), 'utf8');
    await db.exec(source); await db.exec(source);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${owner}';`);
    async function fixture(label, count = 6) {
      await db.exec('reset role;');
      const id = (await db.query('insert into experiment_runs(user_id,title) values(auth.uid(),$1) returning id', [label])).rows[0].id;
      for (let position = 0; position < count; position++) await db.query(`insert into run_steps(user_id,run_id,position,title,instruction,fields,values,status)
        values(auth.uid(),$1,$2,$3,'80 ℃ 12 h','[{"label":"质量","unit":"g","type":"number"}]',$4::jsonb,$5)`,
      [id, position, '操作 '+position, position<3 ? JSON.stringify({ 质量: label }) : '{}', position<3 ? 'done' : 'pending']);
      await db.exec('set role authenticated;');
      return id;
    }
    const review = async (ids, after = 2) => (await db.query('select research_review_merge($1::bigint[],$2) as review', [ids,after])).rows[0].review;
    const merge = async (ids, checked) => (await db.query('select research_merge_runs($1::bigint[],2,$2,$3::jsonb) as id', [ids,'混合 A/B 样品',JSON.stringify(checked.versions)])).rows[0].id;
    const a = await fixture('A'), b = await fixture('B');
    // Reproduce the legacy client: merely visiting a suffix stored empty keys.
    await db.query(`update run_steps set values='{"质量":"","时间":null}',checks='{"核对":false}',started_at=now() where run_id=$1 and position=3`,[a]);
    await assert.rejects(review([a,b]), /已有记录/);
    const legacy = (await db.query('select * from run_steps order by id')).rows;
    const upgradeFile = path.join(__dirname, '../supabase/migrations/20261009080000_merge_record_evidence.sql');
    const upgrade = fs.readFileSync(fs.existsSync(upgradeFile) ? upgradeFile : path.join(__dirname,'../docs/proposals/merge-record-evidence.sql'),'utf8');
    await db.exec(`reset role;`); await db.exec(upgrade); await db.exec(upgrade);
    await db.exec(`set role authenticated;`);
    assert.deepEqual((await db.query('select * from run_steps order by id')).rows,legacy);
    assert.equal((await review([a,b])).allowed,true);
    for (const checks of [{check:0}, 'legacy-record', {check:true}, {check:'true'}]) {
      await db.query('update run_steps set checks=$1::jsonb where run_id=$2 and position=3',[JSON.stringify(checks),a]);
      await assert.rejects(review([a,b]), /已有记录/);
    }
    for (const checks of [{check:false}, {check:'false'}, {check:null}, {check:'  '}, {}]) {
      await db.query('update run_steps set checks=$1::jsonb where run_id=$2 and position=3',[JSON.stringify(checks),a]);
      assert.equal((await review([a,b])).allowed,true);
    }
    const safety = require('../data-safety.js');
    for (const value of [null,'',' \t\n','　','\u00a0','\ufeff',0,'0',false,true,{质量:''},[null,''],{质量:{值:0}}]) {
      assert.equal((await db.query('select research_has_recorded_value($1::jsonb) as yes',[JSON.stringify(value)])).rows[0].yes,safety.meaningfulValue(value));
    }
    await assert.rejects(review([a,a]), /不同/);
    await assert.rejects(review([a,b],5), /保留一个共同步骤/);
    for (const position of [0,5]) {
      await db.exec('reset role;');
      await db.query("update run_steps set instruction='120 ℃ 12 h' where run_id=$1 and position=$2", [b,position]);
      await db.exec('set role authenticated;');
      await assert.rejects(review([a,b]), /前置或后置步骤不一致/);
      await db.exec('reset role;');
      await db.query("update run_steps set instruction='80 ℃ 12 h' where run_id=$1 and position=$2", [b,position]);
      await db.exec('set role authenticated;');
    }
    await db.query("update run_steps set status='pending' where run_id=$1 and position=2", [b]);
    await assert.rejects(review([a,b]), /完成合并前/);
    await db.query("update run_steps set status='done' where run_id=$1 and position=2", [b]);
    await db.query("update run_steps set values='{\"质量\":0}' where run_id=$1 and position=3", [b]);
    await assert.rejects(review([a,b]), /已有记录/);
    await db.query("update run_steps set values='{}' where run_id=$1 and position=3", [b]);
    const stale = await review([a,b]);
    await db.query("update run_steps set note='新增支路记录' where run_id=$1 and position=0", [b]);
    await assert.rejects(merge([a,b],stale), /重新审核/);
    const fresh = await review([a,b]);
    const before = (await db.query('select * from run_steps where run_id=any($1::bigint[]) order by id', [[a,b]])).rows;
    const result = await merge([a,b],fresh);
    assert.equal(await merge([a,b],fresh),result);
    assert.deepEqual((await db.query('select * from run_steps where run_id=any($1::bigint[]) order by id', [[a,b]])).rows,before);
    const suffix = (await db.query('select position,title,values from run_steps where run_id=$1 order by position',[result])).rows;
    assert.deepEqual(suffix.map((row) => [row.position,row.title,row.values]), [[0,'操作 3',{}],[1,'操作 4',{}],[2,'操作 5',{}]]);
    await assert.rejects(review([a,b]), /重复或嵌套/);
    await assert.rejects(db.query("update run_steps set note='改写历史' where run_id=$1 and position=0",[a]), /只读/);
    await assert.rejects(db.query("update experiment_runs set title='改写支路' where id=$1",[a]), /不可修改/);
    await assert.rejects(db.query("update run_steps set instruction='改写共同步骤' where run_id=$1 and position=0",[result]), /定义已经锁定|permission denied/);
    await assert.rejects(db.query("update experiment_runs set status='done' where id=$1",[result]), /所有步骤必须完成/);
    await assert.rejects(db.query("insert into experiment_merge_members(group_id,user_id,parent_run_id) values(1,auth.uid(),$1)",[result]), /permission denied/);
    await db.query("update run_steps set status='done',values='{\"质量\":12}' where run_id=$1",[result]);
    await db.query("select research_finish_run($1,'共同阶段日志',current_date)",[result]);
    await assert.rejects(db.query("update run_steps set note='完成后改写' where run_id=$1 and position=0",[result]), /不可修改/);
    const c = await fixture('C'), d = await fixture('D');
    const checked = await review([c,d]);
    const originalCount = (await db.query('select count(*)::int as n from experiment_runs')).rows[0].n;
    await db.exec(`reset role; alter table experiment_merge_members add constraint test_fail_member check(parent_run_id<>${d}); set role authenticated;`);
    await assert.rejects(merge([c,d],checked), /test_fail_member/);
    assert.equal((await db.query('select count(*)::int as n from experiment_runs')).rows[0].n,originalCount);
    assert.equal((await db.query('select count(*)::int as n from experiment_merge_groups')).rows[0].n,1);
    await db.exec(`set request.jwt.claim.sub='${other}';`);
    assert.equal((await db.query('select * from experiment_merge_groups')).rows.length,0);
    assert.equal((await db.query('select * from experiment_merge_members')).rows.length,0);
    await assert.rejects(review([c,d]), /无权访问/);
    await db.exec('set role anon;');
    await assert.rejects(review([c,d]), /permission denied/);
  } finally { await db.close(); }
});
