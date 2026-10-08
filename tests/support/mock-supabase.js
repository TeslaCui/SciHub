/* Local preview only. Fictional data; never contacts Supabase. */
(function () {
  const key = 'scihub-audit-fixtures-v1';
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
      else if (this.action === 'delete') store.tables[this.table] = rows.filter((row) => !matches(row));
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
      if (name === 'research_check_signup') return { data: '', error: null };
      if (name === 'research_lookup_login_email') return { data: 'audit@example.test', error: null };
      if (name === 'research_save_plan') {
        let plan = store.tables.experiment_plans.find((row) => row.id === args.p_id);
        if (args.p_id && (!plan || plan.updated_at !== args.p_expected_updated_at)) return { error: { message: '方案已在其他设备修改' } };
        if (!plan) { plan = { id: newId('experiment_plans'), user_id: userId, created_at: timestamp() }; store.tables.experiment_plans.push(plan); }
        Object.assign(plan, { title: args.p_title, source: args.p_source, parse_version: args.p_parse_version, version_log: args.p_version_log, updated_at: timestamp() });
        store.tables.plan_steps = store.tables.plan_steps.filter((row) => row.plan_id !== plan.id);
        for (const [position, item] of args.p_steps.entries()) store.tables.plan_steps.push({ ...item, id: newId('plan_steps'), plan_id: plan.id, user_id: userId, position, checklist: [] });
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
