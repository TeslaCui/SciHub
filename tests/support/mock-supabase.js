/* Local preview only. Fictional data; never contacts Supabase. */
(function () {
  const parallelFixture = typeof document !== 'undefined' && /parallel=1/.test(document.currentScript && document.currentScript.src || '');
  const guideFixture = typeof document !== 'undefined' && /guide=1/.test(document.currentScript && document.currentScript.src || '');
  const progressFixture = typeof document !== 'undefined' && /progress=1/.test(document.currentScript && document.currentScript.src || '');
  const key = progressFixture ? 'scihub-progress-fixtures-v1' : guideFixture ? 'scihub-guide-fixtures-v1' : parallelFixture ? 'scihub-parallel-fixtures-v1' : 'scihub-audit-fixtures-v1';
  const userId = '00000000-0000-0000-0000-000000000001';
  const stamp = () => new Date().toISOString();
  const load = () => JSON.parse(localStorage.getItem(key) || 'null');
  const saved = load();
  const store = saved || { session: null, tables: {
    research_profiles: [], research_records: [], research_todos: [],
    experiment_plans: [{ id: 1, user_id: userId, title: '回归测试方案', source: 'fixture.docx', parse_version: 4, version_log: [], created_at: stamp(), updated_at: stamp() }],
    plan_steps: [0, 1].map((position) => ({ id: position + 1, user_id: userId, plan_id: 1, position, title: position ? '干燥' : '称量', instruction: position ? '80 ℃ 干燥 12 h' : '记录实际质量', fields: [{ label: position ? '结束时间' : '质量', unit: position ? '' : 'g', type: position ? 'datetime' : 'number' }], duration_hint: position ? '12 h' : '', notice: '', pyro_seq: '', checklist: [] })),
    experiment_runs: [], run_steps: [],
  } };
  store.tables.experiment_merge_groups ||= [];
  if (guideFixture && !saved) {
    store.session = { user: { id: userId, email: 'guide@example.test' } };
    store.tables.research_profiles = [{ user_id: userId, username: '示例用户', email: 'guide@example.test' }];
    store.tables.experiment_plans[0].title = '[示例]材料干燥方案';
    store.tables.experiment_plans[0].source = '材料干燥方案.docx';
    store.tables.experiment_runs = [{ id: 1, user_id: userId, plan_id: 1, title: '[示例]材料干燥实验', status: 'running', current_step: 0, started_at: stamp(), created_at: stamp(), updated_at: stamp() }];
    store.tables.run_steps = store.tables.plan_steps.map(step => ({ ...step, run_id: 1, status: 'pending', values: {}, images: [], note: '', updated_at: stamp() }));
    store.tables.research_records = [{ id: 1, user_id: userId, title: '[示例]溶液配制记录', category: '实验日志', occurred_on: '2026-10-08', content: '目标：配制 100 mL、0.1 mol/L 硝酸。\n使用前核对瓶签上的原液浓度和密度。', created_at: stamp(), updated_at: stamp() }];
  }
  store.tables.experiment_merge_members ||= [];
  store.tables.experiment_plan_update_audits ||= [];
  for (const group of store.tables.experiment_merge_groups) {
    const member = store.tables.experiment_merge_members.find((row) => row.group_id === group.id);
    group.schema_snapshot ||= store.tables.run_steps.filter((step) => member && step.run_id === member.parent_run_id);
  }
  if (parallelFixture && !saved) {
    store.session = { user: { id: userId, email: 'parallel@example.test' } };
    store.tables.research_profiles = [{ user_id: userId, username: '平行实验测试', email: 'parallel@example.test' }];
    store.tables.experiment_plans[0].title = '六步平行实验方案';
    store.tables.plan_steps = Array.from({ length: 6 }, (_, position) => ({ id: position + 1, user_id: userId, plan_id: 1, position,
      title: ['称量','溶解','反应','混合后洗涤','干燥','表征'][position], instruction: position === 4 ? '80 ℃ 干燥 12 h' : '记录实际操作',
      fields: [{ label: '质量', unit: 'g', type: 'number' }], duration_hint: '', notice: '', pyro_seq: '', checklist: [] }));
    store.tables.experiment_runs = ['平行实验 A','平行实验 B'].map((title,index) => ({ id: 100+index, title, user_id: userId, plan_id: 1,
      status: 'running', current_step: 2, started_at: stamp(), created_at: stamp(), updated_at: stamp() }));
    store.tables.run_steps = store.tables.experiment_runs.flatMap((run,index) => store.tables.plan_steps.map((step) => ({ ...step,
      id: 1000+index*10+step.position, run_id: run.id, status: step.position<3 ? 'done' : 'pending',
      values: step.position<3 ? { 质量: index ? '5' : '3' } : {}, images: [], note: '', updated_at: stamp() })));
  }
  if (progressFixture && !saved) {
    store.session = { user: { id: userId, email: 'progress@example.test' } };
    store.tables.research_profiles = [{ user_id: userId, username: 'Progress example', email: 'progress@example.test' }];
    store.tables.experiment_plans[0].title = '[TEST] Nine-step protocol';
    store.tables.plan_steps = Array.from({length:9}, (_,position) => ({id:position+1,user_id:userId,plan_id:1,position,
      title:'Operation '+(position+1),instruction:'Record actual operation',fields:[{label:'Mass',unit:'g',type:'number'}],
      duration_hint:'',notice:'',pyro_seq:'',checklist:[]}));
    store.tables.experiment_runs = ['[TEST] v5','[TEST] v5.1'].map((title,index) => ({id:100+index,title,user_id:userId,plan_id:1,
      status:'running',current_step:7+index,started_at:stamp(),created_at:stamp(),updated_at:stamp()}));
    store.tables.run_steps = store.tables.experiment_runs.flatMap((run,index) => store.tables.plan_steps.map(step => ({...step,
      id:1000+index*10+step.position,run_id:run.id,status:step.position<7?'done':'pending',
      values:step.position<7?{Mass:step.position===6?0:2+index}:{Mass:'',Time:null},
      checks:{check:false},started_at:stamp(),images:[],note:'',updated_at:stamp()})));
  }
  const persist = () => localStorage.setItem(key, JSON.stringify(store));
  const newId = (table) => Math.max(0, ...store.tables[table].map((row) => Number(row.id) || 0)) + 1;
  let revision = Date.now();
  const timestamp = () => new Date(++revision).toISOString();
  const compare = (left, right) => String(left) === String(right);
  let authCallback = () => {};

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.action = 'select'; this.sort = []; this.maximum = Infinity; }
    select(columns, options = {}) { this.options = options; return this; }
    insert(rows) { this.action = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    update(payload) { this.action = 'update'; this.payload = payload; return this; }
    delete() { this.action = 'delete'; return this; }
    eq(key, value) { this.filters.push((row) => compare(row[key], value)); return this; }
    neq(key, value) { this.filters.push((row) => !compare(row[key], value)); return this; }
    lt(key, value) { this.filters.push((row) => row[key] < value); return this; }
    gte(key, value) { this.filters.push((row) => row[key] >= value); return this; }
    lte(key, value) { this.filters.push((row) => row[key] <= value); return this; }
    in(key, values) { this.filters.push((row) => values.some((value) => compare(row[key], value))); return this; }
    not(key, op, value) { this.filters.push((row) => row[key] != value); return this; }
    order(key, options = {}) { this.sort.push([key, options.ascending !== false]); return this; }
    limit(value) { this.maximum = value; return this; }
    or() { return this; }
    range(from, to) { this.slice = [from, to + 1]; return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.execute()).then(resolve, reject); }
    execute() {
      let rows = store.tables[this.table] || [];
      const matches = (row) => this.filters.every((filter) => filter(row));
      let selected = rows.filter(matches);
      if (this.action === 'insert') {
        selected = this.payload.map((item) => {
          const row = { id: newId(this.table), created_at: timestamp(), updated_at: timestamp(), ...item };
          if (this.table === 'experiment_runs') row.started_at ||= timestamp();
          if (this.table === 'run_steps') { row.updated_at ||= timestamp(); row.note ||= ''; row.status ||= 'pending'; }
          rows.push(row); return row;
        });
      } else if (this.action === 'update') selected.forEach((row) => Object.assign(row, this.payload, { updated_at: timestamp() }));
      else if (this.action === 'delete') {
        if (this.table === 'experiment_plans' && selected.some((plan) => store.tables.experiment_runs.some((run) =>
          run.plan_id === plan.id && store.tables.experiment_merge_members.some((member) => member.parent_run_id === run.id)))) {
          return { data: null, error: { message: '已合并的平行支路不可修改或删除' } };
        }
        store.tables[this.table] = rows.filter((row) => !matches(row));
        // Match existing production foreign keys for plan deletion previews.
        if (this.table === 'experiment_plans') {
          const planIds = new Set(selected.map((row) => row.id));
          store.tables.plan_steps = store.tables.plan_steps.filter((row) => !planIds.has(row.plan_id));
          store.tables.experiment_runs.forEach((row) => { if (planIds.has(row.plan_id)) row.plan_id = null; });
        }
      }
      for (const [column, ascending] of this.sort.slice().reverse()) selected.sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
      selected = selected.slice(0, this.maximum);
      if (this.slice) selected = selected.slice(...this.slice);
      persist();
      return { data: this.options?.head ? null : this.singleRow ? structuredClone(selected[0] || null) : structuredClone(selected), error: null, count: selected.length };
    }
  }
  const result = (data = null, error = null) => Promise.resolve({ data, error });
  const client = {
    from: (table) => new Query(table),
    auth: {
      getSession: () => result({ session: store.session }),
      onAuthStateChange(callback) { authCallback = callback; },
      signInWithPassword: ({ email }) => {
        store.session = { user: { id: userId, email } }; persist(); authCallback('SIGNED_IN', store.session); return result({ session: store.session });
      },
      signUp: ({ email }) => {
        const user = { id: userId, email }; store.session = { user }; persist(); authCallback('SIGNED_IN', store.session); return result({ user, session: store.session });
      },
      signOut: () => { store.session = null; persist(); authCallback('SIGNED_OUT', null); return result(); },
      updateUser: () => result(),
    },
    async rpc(name, args) {
      if (name === 'research_review_plan_update') {
        const plan = store.tables.experiment_plans.find(row => row.id === args.p_id);
        if (!plan) return { error: { message: '方案不存在' } };
        const runs = store.tables.experiment_runs.filter(row => row.plan_id === args.p_id && row.status === 'running'
          && (!args.p_run_id || row.id === args.p_run_id) && !store.tables.experiment_merge_members.some(member => member.parent_run_id === row.id));
        if (args.p_run_id && !runs.length) return { error: { message: '实验不存在或已合并' } };
        const map = Object.fromEntries(runs.map(row => [row.id, store.tables.run_steps.filter(step => step.run_id === row.id)]));
        const reviewed = window.SciHubSafety.reviewPlanUpdate(args.p_steps, runs, map);
        return { data: { ...reviewed, plan_id: plan.id, plan_updated_at: plan.updated_at, run_id: args.p_run_id || null,
          candidate: args.p_steps.map(window.SciHubSafety.updateStepSchema),
          before_steps: args.p_run_id ? map[args.p_run_id] : store.tables.plan_steps.filter(step => step.plan_id === plan.id).sort((a,b)=>a.position-b.position) }, error: null };
      }
      if (name === 'research_commit_plan_update') {
        const checked = await client.rpc('research_review_plan_update', { ...args, p_run_id: null });
        if (checked.error) return checked;
        if (JSON.stringify(checked.data) !== JSON.stringify(args.p_expected_review)) return { error: { message: '审核后方案或实验已变化，请重新审核' } };
        return client.rpc('research_save_plan', args);
      }
      if (name === 'research_start_run') {
        const plan = store.tables.experiment_plans.find(row => row.id === args.p_plan_id);
        if (!plan || plan.updated_at !== args.p_expected_updated_at) return { error: { message: '方案已变化，请刷新' } };
        const made = (await new Query('experiment_runs').insert({ user_id: userId, plan_id: plan.id, title: plan.title, status: 'running', current_step: 0 }).single()).data;
        const rows = store.tables.plan_steps.filter(step => step.plan_id === plan.id);
        for (const step of rows) {
          const { checklist = [], plan_id, ...definition } = step;
          await new Query('run_steps').insert({ ...definition, id: newId('run_steps'), run_id: made.id, values: {}, images: [], note: '', status: 'pending', checks: Object.fromEntries(checklist.map(item => [item,false])) });
        }
        return { data: made.id, error: null };
      }
      if (name === 'research_adopt_plan_update') {
        const run = store.tables.experiment_runs.find(row => row.id === args.p_run_id);
        const candidates = store.tables.plan_steps.filter(step => step.plan_id === run?.plan_id).sort((a,b)=>a.position-b.position);
        const checked = await client.rpc('research_review_plan_update', { p_id: run?.plan_id, p_steps: candidates, p_run_id: args.p_run_id });
        if (checked.error) return checked;
        if (JSON.stringify(checked.data) !== JSON.stringify(args.p_expected_review)) return { error: { message: '审核后方案或实验已变化，请重新审核' } };
        if (!checked.data.allowed) return { error: { message: '采用审核不通过' } };
        const locked = checked.data.runs[0].locked_through;
        const before = {run:structuredClone(run),steps:structuredClone(store.tables.run_steps.filter(step=>step.run_id===run.id))};
        const removed = store.tables.run_steps.filter(step => step.run_id === run.id && step.position >= candidates.length);
        if (removed.length && !args.p_confirm_remove) return { error: { message: '未批准移除尾步' } };
        for (const step of candidates.filter(step=>step.position>locked)) {
          const old = store.tables.run_steps.find(row=>row.run_id===run.id && row.position===step.position);
          const { checklist, ...schema } = window.SciHubSafety.updateStepSchema(step);
          const checks = Object.fromEntries(checklist.map(item => [item,false]));
          if (old) Object.assign(old,schema,{checks,updated_at:timestamp()});
          else await new Query('run_steps').insert({ ...schema, user_id:userId, run_id:run.id, position:step.position, values:{}, images:[], checks });
        }
        store.tables.run_steps = store.tables.run_steps.filter(step=>!removed.includes(step));
        run.updated_at=timestamp();
        store.tables.experiment_plan_update_audits.push({id:newId('experiment_plan_update_audits'),user_id:userId,plan_id:run.plan_id,run_id:run.id,action:'adopt_tail',created_at:timestamp(),
          before_snapshot:before,after_snapshot:{run:structuredClone(run),steps:structuredClone(store.tables.run_steps.filter(step=>step.run_id===run.id))},review_snapshot:checked.data});
        persist(); return {data:run.id,error:null};
      }
      if (name === 'research_review_merge') {
        const runs = store.tables.experiment_runs.filter((row) => args.p_run_ids.includes(row.id));
        const steps = Object.fromEntries(runs.map((row) => [row.id, store.tables.run_steps.filter((step) => step.run_id === row.id)]));
        try {
          window.Merges.reviewLocal(window.Merges.decorate(runs), steps, args.p_after_position);
          return { data: { allowed: true, after_position: args.p_after_position, run_ids: args.p_run_ids,
            versions: Object.fromEntries(runs.map((run) => [run.id, { updated_at: run.updated_at, steps: steps[run.id].map((step) => ({ id: step.id, updated_at: step.updated_at })) }])) }, error: null };
        } catch (error) { return { error: { message: error.message } }; }
      }
      if (name === 'research_merge_runs') {
        const checked = await client.rpc('research_review_merge', args);
        if (checked.error) return checked;
        if (JSON.stringify(checked.data.versions) !== JSON.stringify(args.p_expected_versions)) return { error: { message: '审核后数据已变化' } };
        const first = store.tables.experiment_runs.find((row) => row.id === args.p_run_ids[0]);
        const shared = { id: newId('experiment_runs'), user_id: userId, title: first.title + ' · 共同阶段', plan_id: null,
          status: 'running', current_step: 0, started_at: timestamp(), updated_at: timestamp() };
        store.tables.experiment_runs.push(shared);
        const copies = store.tables.run_steps.filter((step) => step.run_id === first.id && step.position > args.p_after_position);
        for (const step of copies) store.tables.run_steps.push({ ...step, id: newId('run_steps'), run_id: shared.id,
          position: step.position-args.p_after_position-1, values: {}, status: 'pending', images: [], note: '', updated_at: timestamp() });
        const group = { id: newId('experiment_merge_groups'), user_id: userId, result_run_id: shared.id, after_position: args.p_after_position,
          schema_snapshot: store.tables.run_steps.filter((step) => step.run_id === first.id), note: args.p_note, created_at: timestamp() };
        store.tables.experiment_merge_groups.push(group);
        for (const id of args.p_run_ids) store.tables.experiment_merge_members.push({ user_id: userId, group_id: group.id, parent_run_id: id });
        persist(); return { data: shared.id, error: null };
      }
      if (name === 'research_check_signup') return { data: '', error: null };
      if (name === 'research_lookup_login_email') return { data: 'audit@example.test', error: null };
      if (name === 'research_save_plan') {
        let plan = store.tables.experiment_plans.find((row) => row.id === args.p_id);
        const before = {plan:plan?structuredClone(plan):null,steps:structuredClone(store.tables.plan_steps.filter(step=>step.plan_id===args.p_id))};
        let reviewed={runs:[]};
        if (args.p_id && (!plan || plan.updated_at !== args.p_expected_updated_at)) return { error: { message: '方案已在其他设备修改' } };
        if (args.p_id) {
          const checked = await client.rpc('research_review_plan_update', {...args,p_run_id:null});
          if (checked.error) return checked;
          if (!checked.data.allowed) return {error:{message:'更新审核不通过：已执行步骤不匹配'}};
          reviewed=checked.data;
        }
        if (!plan) { plan = { id: newId('experiment_plans'), user_id: userId, created_at: timestamp() }; store.tables.experiment_plans.push(plan); }
        Object.assign(plan, { title: args.p_title, source: args.p_source, parse_version: args.p_parse_version, version_log: args.p_version_log, updated_at: timestamp() });
        const oldSteps = store.tables.plan_steps.filter(row => row.plan_id === plan.id);
        store.tables.plan_steps = store.tables.plan_steps.filter((row) => row.plan_id !== plan.id);
        for (const [position, item] of args.p_steps.entries()) store.tables.plan_steps.push({ ...item, id: oldSteps.find(row=>row.position===position)?.id || newId('plan_steps'), plan_id: plan.id, user_id: userId, position });
        store.tables.experiment_plan_update_audits.push({id:newId('experiment_plan_update_audits'),user_id:userId,plan_id:plan.id,action:'save_plan',created_at:timestamp(),
          before_snapshot:before,after_snapshot:{plan:structuredClone(plan),steps:structuredClone(store.tables.plan_steps.filter(step=>step.plan_id===plan.id))},review_snapshot:reviewed});
        persist(); return { data: plan.id, error: null };
      }
      if (name === 'research_finish_run') {
        const run = store.tables.experiment_runs.find((row) => row.id === args.p_id);
        if (run.status !== 'done') {
          Object.assign(run, { status: 'done', finished_at: timestamp() });
          await new Query('research_records').insert({ user_id: userId, title: run.title + ' · 实验日志', category: '实验日志', tags: ['实验日志', 'experiment:' + run.id], occurred_on: args.p_date, content: args.p_content });
        }
        persist(); return { data: 1, error: null };
      }
      return { data: null, error: { message: 'Unknown mock RPC' } };
    },
    functions: { invoke: () => result(null, { message: 'Local AI intentionally disabled' }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    storage: { from: () => ({ createSignedUrls: () => result([]), createSignedUrl: () => result({}), upload: () => result(), remove: () => result() }) },
  };
  window.supabase = { createClient: () => client };
})();
