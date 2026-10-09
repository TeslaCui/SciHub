const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('real PostgreSQL: atomic writes, idempotency, RLS and stale versions', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const db = new PGlite();
  const uid = '00000000-0000-0000-0000-000000000001';
  const other = '00000000-0000-0000-0000-000000000002';
  try {
    await db.exec(`create role authenticated; create role anon;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated,anon;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id uuid primary key,bucket_id text,name text);
      create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
      create publication supabase_realtime;
      insert into auth.users values('${uid}'),('${other}');`);
    const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase_schema.sql'), 'utf8');
    await db.exec(schema); await db.exec(schema);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${uid}';`);
    const step = { title: '称量', fields: [{ label: '质量', unit: 'g' }] };
    const save = (id, expected, steps) => db.query('select research_save_plan($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::timestamptz) as id', [id, '测试方案', 'test.docx', JSON.stringify(steps), 4, '[]', expected]);
    const id = (await save(null, null, [step])).rows[0].id;
    let version = (await db.query('select updated_at::text as stamp from experiment_plans where id=$1', [id])).rows[0].stamp;
    await assert.rejects(save(id, version, [{ ...step, fields: null }]), /格式/);
    assert.equal((await db.query('select count(*)::int as n from plan_steps where plan_id=$1', [id])).rows[0].n, 1);
    // Use a deliberately violated constraint to prove transaction rollback.
    await db.exec('reset role; alter table plan_steps add constraint test_reject_bad check(title<>\'bad\'); set role authenticated;');
    version = (await db.query('select updated_at::text as stamp from experiment_plans where id=$1', [id])).rows[0].stamp;
    await assert.rejects(save(id, version, [{ title: 'bad', fields: [] }]), /check constraint/);
    assert.equal((await db.query('select title from plan_steps where plan_id=$1', [id])).rows[0].title, '称量');
    await save(id, version, [{ title: '干燥', fields: [] }]);
    await assert.rejects(save(id, version, [step]), /其他设备/);
    await db.exec(`set request.jwt.claim.sub='${other}';`);
    assert.equal((await db.query('select * from experiment_plans')).rows.length, 0);
    await assert.rejects(save(id, version, [step]), /无权/);
    await db.exec(`set request.jwt.claim.sub='${uid}';`);
    const runId = (await db.query("insert into experiment_runs(user_id,title) values(auth.uid(),'测试实验') returning id")).rows[0].id;
    // Seed a deliberately completed legacy fixture as database owner, not through production grants.
    await db.exec('reset role;');
    await db.query("insert into run_steps(user_id,run_id,position,title,status) values(auth.uid(),$1,0,'称量','done')", [runId]);
    await db.exec('set role authenticated;');
    const finish = (content = '成功日志') => db.query('select research_finish_run($1,$2,$3::date) as id', [runId, content, '2026-10-08']);
    await db.exec('reset role; alter table research_records add constraint test_log_failure check(content<>\'测试日志\'); set role authenticated;');
    await assert.rejects(finish('测试日志'), /check constraint/);
    assert.equal((await db.query('select status from experiment_runs where id=$1', [runId])).rows[0].status, 'running');
    const [first, second] = await Promise.all([finish(), finish()]);
    assert.equal(first.rows[0].id, second.rows[0].id);
    assert.equal((await db.query('select count(*)::int as n from research_records')).rows[0].n, 1);
    assert.equal((await db.query('select status from experiment_runs where id=$1', [runId])).rows[0].status, 'done');
    await db.exec('set role anon;');
    await assert.rejects(finish(), /permission denied/);
  } finally { await db.close(); }
});
