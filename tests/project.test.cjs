const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261010180000_projects.sql'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const experiment = fs.readFileSync(path.join(root, 'experiment.js'), 'utf8');

test('project migration preserves legacy rows and enforces account-scoped project links', () => {
  assert.match(migration, /create table if not exists public\.research_projects/);
  assert.match(migration, /add column if not exists project_id bigint references public\.research_projects\(id\) on delete set null/);
  assert.match(migration, /alter table public\.research_projects enable row level security/);
  assert.match(migration, /auth\.uid\(\) = user_id/);
  assert.match(migration, /p_migrate_unassigned boolean default false/);
  assert.match(migration, /project_id is null/);
  assert.doesNotMatch(migration, /delete from public\.(research_records|experiment_plans|experiment_runs)/);
});

test('project UI separates all data from a project workspace and keeps repeated runs distinct', () => {
  assert.match(app, /renderHome\(options = \{\}\)/);
  assert.match(app, /data-project-open/);
  assert.match(app, /data-new-experiment/);
  assert.match(app, /data-manage-plans/);
  assert.match(app, /route\('project', Number\(el\.dataset\.projectOpen\)\)/);
  assert.match(experiment, /project_id: projectId/);
  assert.match(experiment, /第 ' \+ nth \+ ' 次/);
});

test('legacy project migration is explicit and preserves existing assignments', () => {
  assert.match(app, /创建项目并迁移旧版本数据/);
  assert.match(app, /project-migrate-legacy/);
  assert.match(app, /旧版本没有项目字段/);
  assert.match(app, /p_migrate_unassigned: migrateUnassigned/);
  assert.match(migration, /project_id is null/);
  assert.match(migration, /on delete set null/);
});

test('plan import accepts text-based PDF files', () => {
  assert.match(experiment, /accept="\.docx,\.pdf"/);
  assert.match(experiment, /readPdf\(file\)/);
  assert.match(experiment, /pdf\.js/);
});
