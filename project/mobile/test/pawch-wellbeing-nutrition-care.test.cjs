const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

const pet = { id: 'pet-a', household_id: 'home-a', name: '小豆', effective_timezone: 'UTC', weight_kg: null };
const household = { id: 'home-a', role: 'owner' }, at = '2026-11-28T01:00:00Z';
const clone = value => structuredClone(value);
const navigation = () => { const calls = [], listeners = new Map(); return { calls, listeners, push: (...args) => calls.push(args), navigate: (...args) => calls.push(args), popTo: (...args) => calls.push(['popTo', ...args]), goBack: () => calls.push(['back']), addListener: (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); } }; };
function fixture(options = {}) {
  const calls = [], records = new Map(); let identityReads = 0, body = { id: 'body-a', pet_id: pet.id, local_date: '2026-11-28', timezone: 'UTC', version: 4,
    values: { appetite: null, energy: null, movement: null, stool: null }, notes: '', observed_at: null, toileting_record_id: null };
  let observation = { id: 'observation-a', pet_id: pet.id, local_date: '2026-11-27', timezone: 'UTC', read_at: null, generated_at: at, assessment: { observations: [], evidence: [] } };
  const api = { baseUrl: 'http://test.invalid/api/v1', origin: 'http://test.invalid',
    async get(path) {
      calls.push(['get', path]); if (options.get) { const found = await options.get(path); if (found !== undefined) return clone(found); }
      const url = new URL(path, api.origin), day = url.searchParams.get('date') ?? '2026-11-28';
      if (url.pathname.endsWith('/overview')) return { pet: clone(pet), device: null, care_records: [], activity: { local_date: day, timezone: 'UTC', steps: options.zero ? 0 : null, active_minutes: options.zero ? 0 : null, sleep_minutes: null, distance_m: null, data_status: 'missing', sources: [] } };
      if (url.pathname.endsWith('/goals')) return { pet_id: pet.id, local_date: day, timezone: 'UTC', effective_date_version: 0, goals: null };
      if (url.pathname.endsWith('/body-check-ins')) return clone(body);
      if (url.pathname.endsWith('/nutrition/daily')) { const items = [...records.values()].filter(row => row.type === 'feeding' && !row.withdrawn_at); return { pet_id: pet.id, local_date: day, timezone: 'UTC', known_kcal: null, target_kcal: null, unknown_energy_count: items.length, record_count: items.length, items }; }
      if (url.pathname.endsWith('/trends')) return { pet_id: pet.id, items: [], unit: 'minutes' };
      if (url.pathname.endsWith('/health-observations')) return { items: [{ id: observation.id, local_date: observation.local_date, finding_count: 0, timezone: 'UTC', read_at: observation.read_at }] };
      if (url.pathname === '/health-observations/observation-a') return clone(observation);
      if (url.pathname.startsWith('/care-records/')) { const row = records.get(url.pathname.split('/').at(-1)); if (!row) throw new Error('Record not found'); return clone(row); }
      if (url.pathname === '/content') return { items: [] };
      return { items: [] };
    },
    async post(path, input, key) {
      calls.push(['post', path, clone(input), key]); if (options.post) { const found = await options.post(path, input); if (found !== undefined) return clone(found); }
      if (path === '/care-records') { const row = { id: `record-${records.size + 1}`, ...clone(input), withdrawn_at: null, energy: { kcal: null } }; records.set(row.id, row); return clone(row); }
      if (path.endsWith('/withdraw')) { const id = path.split('/')[2], row = records.get(id); if (row) row.withdrawn_at = at; return { id, withdrawn_at: at }; }
      return {};
    },
    async put(path, input, key) {
      calls.push(['put', path, clone(input), key]); if (options.put) return options.put(path, input);
      assert.equal(input.expected_version, body.version); body = { ...body, ...clone(input), version: body.version + 1 }; return clone(body);
    },
    async patch(path, input, key) { calls.push(['patch', path, clone(input), key]); if (options.patch) return options.patch(path, input); if (path.endsWith('/read')) observation = { ...observation, read_at: at }; return clone(observation); },
  };
  const state = { api, authenticated: true, user: { id: 'user-a' }, pet: clone(pet), pets: [clone(pet)], household: { ...household, role: options.role ?? 'owner' }, households: [{ ...household, role: options.role ?? 'owner' }], selectPet() {}, refreshIdentity: async () => { identityReads++; } };
  const modules = {};
  const load = file => modules[file] ??= screenModule(file, state, { './assets': { Asset: props => React.createElement('StaticAsset', props) } });
  return { api, calls, state, records, load, get body() { return body; }, set body(value) { body = value; }, get identityReads() { return identityReads; } };
}
const buttons = (tree, title) => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === title);
async function press(tree, title) { const button = buttons(tree, title)[0]; assert.ok(button, title); assert.ok(!button.props.disabled, title); await change(() => button.props.onPress()); }
const field = (tree, label) => tree.root.findByProps({ accessibilityLabel: label });
const edit = (tree, label, value) => change(() => field(tree, label).props.onChangeText(value));
const text = tree => JSON.stringify(tree.toJSON());
const textNodes = tree => tree.root.findAllByType('Text').map(node => node.props.children).filter(value => typeof value === 'string');
const close = tree => change(() => tree.unmount());
const writes = f => f.calls.filter(([method]) => ['post', 'put', 'patch'].includes(method));
const props = (screenId, nav = navigation(), params = {}) => ({ screenId, navigation: nav, route: { params: { date: '2026-11-28', ...params } } });

const groups = [
  ['src/pawch/WellbeingFlow.tsx', 'PawchWellbeingScreen', ['09', '10', '11', '12', '13', '14', '15', '15a', '15b', '15c', '16', '17']],
  ['src/pawch/NutritionFlow.tsx', 'PawchNutritionScreen', ['18', '19', '20', '20a', '20b', '20c', '21', '22', '23']],
  ['src/pawch/CareFlow.tsx', 'PawchCareScreen', ['24', '25', '26', '27']],
];
test('body fields stay locked until the persisted draft base has finished loading', async () => {
  const pending = deferred(), f = fixture({ get: path => path.includes('/body-check-ins') ? pending.promise : undefined }), Screen = f.load('src/pawch/WellbeingFlow.tsx').PawchWellbeingScreen, tree = await render(Screen, props('15a'));
  try { assert.equal(field(tree, 'Energy').props.editable, false); assert.equal(buttons(tree, 'Save observations')[0].props.disabled, true); await change(() => pending.resolve(clone(f.body))); assert.equal(field(tree, 'Energy').props.editable, true); await edit(tree, 'Energy', 'My first supplied observation'); assert.equal(field(tree, 'Energy').props.value, 'My first supplied observation'); assert.equal(writes(f).length, 0); }
  finally { pending.resolve(clone(f.body)); await close(tree); }
});
test('a warning pairs the selected finding with its own evidence rather than the first unrelated metric', async () => {
  const f = fixture({ get: path => path === '/health-observations/observation-a' ? { id: 'observation-a', pet_id: pet.id, local_date: '2026-11-27', timezone: 'UTC', assessment: { observations: [{ metric: 'steps', text: 'Steps changed', evidence_ids: ['steps-evidence'] }], evidence: [{ id: 'unchanged-active', metric: 'active_minutes', observed: 10, baseline_median: 10 }, { id: 'steps-evidence', metric: 'steps', observed: 100, baseline_median: 70 }] } } : undefined }), Screen = f.load('src/pawch/CareFlow.tsx').PawchCareScreen, tree = await render(Screen, props('25'));
  try { assert.ok(textNodes(tree).includes('100')); assert.ok(!textNodes(tree).includes('10')); assert.ok(text(tree).includes('Steps changed')); assert.equal(writes(f).length, 0); }
  finally { await close(tree); }
});
for (const [file, component, ids] of groups) for (const id of ids) test(`Pawch ${id} renders a distinct native route without performing writes`, async () => {
  const f = fixture(), Screen = f.load(file)[component], tree = await render(Screen, props(id));
  try { assert.ok(tree.root.findByProps({ testID: `pawch-screen-${id}` })); assert.equal(writes(f).length, 0); }
  finally { await close(tree); }
});

test('daily wellbeing distinguishes reported zero from unknown and never renders the prototype score', async () => {
  for (const zero of [false, true]) {
    const f = fixture({ zero }), Screen = f.load('src/pawch/WellbeingFlow.tsx').PawchWellbeingScreen, tree = await render(Screen, props('09'));
    try { assert.ok(text(tree).includes(zero ? '0 min' : 'Unknown')); assert.ok(!text(tree).includes('80/100')); assert.ok(text(tree).includes('No bound collar')); }
    finally { await close(tree); }
  }
});

test('body check-in saves nullable raw text with the captured expected version then rereads before navigating', async () => {
  const f = fixture(), nav = navigation(), Screen = f.load('src/pawch/WellbeingFlow.tsx').PawchWellbeingScreen, tree = await render(Screen, props('15a', nav));
  try {
    await edit(tree, 'Energy', 'Quiet after the walk'); await press(tree, 'Save observations');
    const write = writes(f)[0]; assert.equal(write[0], 'put'); assert.equal(write[2].expected_version, 4); assert.equal(write[2].values.energy, 'Quiet after the walk'); assert.equal(write[2].values.appetite, null);
    assert.ok(f.calls.slice(f.calls.indexOf(write) + 1).some(([m, path]) => m === 'get' && path.includes('/body-check-ins'))); assert.equal(nav.calls.at(-1)[1].screenId, '15b'); assert.equal(nav.calls.at(-1)[1].savedVersion, 5);
  } finally { await close(tree); }
});

test('body version conflict preserves its draft and requires an explicit reread', async () => {
  const f = fixture({ put: async () => { throw Object.assign(new Error('Version conflict'), { status: 409 }); } }), Screen = f.load('src/pawch/WellbeingFlow.tsx').PawchWellbeingScreen, tree = await render(Screen, props('15a'));
  try {
    await edit(tree, 'Energy', 'My unsaved conflict draft'); await press(tree, 'Save observations');
    assert.equal(field(tree, 'Energy').props.value, 'My unsaved conflict draft'); assert.equal(buttons(tree, 'Save observations')[0].props.disabled, true); assert.ok(text(tree).includes('草稿保留'));
    await press(tree, 'Reread observations · discard draft'); assert.equal(field(tree, 'Energy').props.value, ''); assert.equal(writes(f).length, 1);
  } finally { await close(tree); }
});

test('acknowledged body save with failed read permits only reading, without a duplicate PUT', async () => {
  let wrote = false, failRead = true;
  const f = fixture({ put: async (_path, input) => { wrote = true; return { ...input, version: 5 }; }, get: path => { if (wrote && failRead && path.includes('/body-check-ins')) throw new Error('Body read unavailable'); } });
  const nav = navigation(), Screen = f.load('src/pawch/WellbeingFlow.tsx').PawchWellbeingScreen, tree = await render(Screen, props('15a', nav));
  try {
    await edit(tree, 'Energy', 'Keep my saved observation'); await press(tree, 'Save observations'); assert.equal(nav.calls.length, 0); assert.ok(text(tree).includes('只重试读取')); assert.equal(buttons(tree, 'Save observations').length, 0);
    failRead = false; await press(tree, 'Reread saved observations'); assert.equal(writes(f).length, 1); assert.equal(nav.calls.at(-1)[1].screenId, '15b');
  } finally { await close(tree); }
});

test('weight validates positive kg and rejects withdrawn or wrong-type rereads without resubmitting', async () => {
  for (const invalid of ['withdrawn', 'wrong-type', 'network']) {
    let mode = invalid;
    const f = fixture({ get: path => { if (!path.startsWith('/care-records/')) return; if (mode === 'network') throw new Error('Weight read offline'); const original = [...f.records.values()][0]; return { ...original, ...(mode === 'withdrawn' ? { withdrawn_at: at } : mode === 'wrong-type' ? { type: 'note' } : {}) }; } });
    const nav = navigation(), Screen = f.load('src/pawch/WellbeingFlow.tsx').PawchWellbeingScreen, tree = await render(Screen, props('17', nav));
    try {
      await edit(tree, 'Weight in kg', '0'); await press(tree, 'Save weight'); assert.equal(writes(f).length, 0);
      await edit(tree, 'Weight in kg', '8.4'); await press(tree, 'Save weight'); assert.equal(writes(f).length, 1); assert.equal(writes(f)[0][2].value.weight, 8.4); assert.equal(nav.calls.length, 0); assert.ok(text(tree).includes('不要再次提交'));
      mode = 'valid'; await press(tree, 'Reread saved weight'); assert.equal(writes(f).length, 1); assert.equal(nav.calls.at(-1)[1].screenId, '16'); assert.equal(f.identityReads, 1);
    } finally { await close(tree); }
  }
});

test('meals require actual label sources and preserve unknown energy rather than zero', async () => {
  const f = fixture(), nav = navigation(), Screen = f.load('src/pawch/NutritionFlow.tsx').PawchNutritionScreen, tree = await render(Screen, props('21', nav));
  try {
    await edit(tree, 'Food', 'Owner-entered food'); await edit(tree, 'Food category', 'test-only'); await edit(tree, 'Portion amount', '12'); await edit(tree, 'Label kcal · optional', '40'); await edit(tree, 'Per amount (g) · optional', '10');
    await press(tree, 'Save meal'); assert.equal(writes(f).length, 0); assert.ok(text(tree).includes('实际食品标签来源'));
    await edit(tree, 'Label kcal · optional', ''); await edit(tree, 'Per amount (g) · optional', ''); await press(tree, 'Save meal');
    const write = writes(f)[0]; assert.equal(write[2].value.label_energy, null); assert.equal(write[2].value.food_name, 'Owner-entered food'); assert.equal(write[2].type, 'feeding'); assert.equal(nav.calls.at(-1)[1].screenId, '20c');
  } finally { await close(tree); }
});

test('a meal acknowledged before a read failure exposes only GET retry and retains its input', async () => {
  let failRead = true;
  const f = fixture({ get: path => { if (path.startsWith('/care-records/') && failRead) throw new Error('Meal read failed'); } }), nav = navigation();
  const Screen = f.load('src/pawch/NutritionFlow.tsx').PawchNutritionScreen, tree = await render(Screen, props('21', nav));
  try {
    await edit(tree, 'Food', 'Saved unknown energy meal'); await edit(tree, 'Food category', 'owner-provided'); await edit(tree, 'Portion amount', '12'); await press(tree, 'Save meal'); assert.equal(nav.calls.length, 0); assert.equal(field(tree, 'Food').props.value, 'Saved unknown energy meal'); assert.equal(field(tree, 'Food').props.editable, false);
    failRead = false; await press(tree, 'Reread saved meal'); assert.equal(writes(f).length, 1); assert.equal(nav.calls.at(-1)[1].screenId, '20c');
  } finally { await close(tree); }
});

test('90-day trends use contiguous server requests no longer than 31 days and preserve null values', async () => {
  const f = fixture(), { readTrendRange } = f.load('src/pawch/NutritionFlow.tsx'), calls = [];
  const result = await readTrendRange({ get: async path => { const url = new URL(path, 'http://test.invalid'); const from = url.searchParams.get('from'), to = url.searchParams.get('to'); calls.push({ from, to, limit: url.searchParams.get('limit') }); const items = []; for (let day = Date.parse(from + 'T00:00:00Z'); day < Date.parse(to + 'T00:00:00Z'); day += 86400000) items.push({ local_date: new Date(day).toISOString().slice(0, 10), value: null }); return { items, unit: 'minutes' }; } }, pet.id, '2026-11-28', 'UTC', 'sleep_minutes', 90);
  assert.equal(calls.length, 3); assert.equal(result.items.length, 90); assert.ok(result.items.every(row => row.value === null));
  calls.forEach((range, i) => { assert.ok((Date.parse(range.to) - Date.parse(range.from)) / 86400000 <= 31); assert.equal(range.limit, '31'); if (i) assert.equal(range.from, calls[i - 1].to); });
});

test('care note reread failure or withdrawal clears the old successful detail without another POST', async () => {
  for (const mode of ['network', 'withdrawn']) {
    let readMode = 'valid';
    const f = fixture({ get: path => { if (!path.startsWith('/care-records/')) return; if (readMode === 'network') throw new Error('Note read failed'); const row = [...f.records.values()][0]; return { ...row, ...(readMode === 'withdrawn' ? { withdrawn_at: at } : {}) }; } }), Screen = f.load('src/pawch/CareFlow.tsx').PawchCareScreen, tree = await render(Screen, props('26'));
    try {
      await press(tree, 'Log a care note'); await edit(tree, 'Care note', 'A unique saved care detail'); await press(tree, 'Save care note'); assert.ok(textNodes(tree).includes('A unique saved care detail')); assert.ok(text(tree).includes('Saved and reread from the server.'));
      readMode = mode; await press(tree, 'Reread saved care note'); assert.ok(!textNodes(tree).includes('A unique saved care detail')); assert.ok(!text(tree).includes('Saved and reread from the server.')); assert.ok(text(tree).includes('读取尚未成功')); assert.equal(writes(f).length, 1);
    } finally { await close(tree); }
  }
});

test('intake withdrawal locks selection, reason and cancel while the original request is pending', async () => {
  const pending = deferred(), f = fixture({ post: path => path.endsWith('/withdraw') ? pending.promise : undefined });
  for (const id of ['meal-a', 'meal-b']) f.records.set(id, { id, pet_id: pet.id, type: 'feeding', recorded_at: at, value: { schema_version: 'feeding-v1', food_name: id, amount: 10, unit: 'g' }, energy: { kcal: null }, withdrawn_at: null });
  const Screen = f.load('src/pawch/NutritionFlow.tsx').PawchNutritionScreen, tree = await render(Screen, props('22')); let running;
  try {
    await press(tree, 'meal-a · Unknown'); await press(tree, 'Review withdrawal'); await edit(tree, 'Withdrawal reason', 'First meal reason');
    await change(() => { running = buttons(tree, 'Confirm withdrawal')[0].props.onPress(); });
    assert.equal(buttons(tree, 'meal-b · Unknown')[0].props.disabled, true); assert.equal(field(tree, 'Withdrawal reason').props.editable, false); assert.equal(buttons(tree, 'Cancel withdrawal')[0].props.disabled, true); assert.equal(buttons(tree, 'Log another meal')[0].props.disabled, true);
    await change(() => buttons(tree, 'meal-b · Unknown')[0].props.onPress()); assert.equal(field(tree, 'Withdrawal reason').props.value, 'First meal reason');
    await change(async () => { pending.resolve({ id: 'meal-a', withdrawn_at: at }); await running; }); assert.equal(writes(f)[0][1], '/care-records/meal-a/withdraw');
    await press(tree, 'meal-b · Unknown'); await press(tree, 'Review withdrawal'); await edit(tree, 'Withdrawal reason', 'Second meal draft'); assert.equal(field(tree, 'Withdrawal reason').props.value, 'Second meal draft');
  } finally { await close(tree); }
});

test('viewer cannot write shared care, weight, meals or body records but can mark a saved assessment read by self', async () => {
  for (const [file, name, id, action] of [
    ['src/pawch/WellbeingFlow.tsx', 'PawchWellbeingScreen', '15a', 'Save observations'], ['src/pawch/WellbeingFlow.tsx', 'PawchWellbeingScreen', '17', 'Save weight'],
    ['src/pawch/NutritionFlow.tsx', 'PawchNutritionScreen', '21', 'Save meal'],
  ]) { const f = fixture({ role: 'viewer' }), tree = await render(f.load(file)[name], props(id)); try { assert.equal(buttons(tree, action)[0].props.disabled, true); assert.equal(writes(f).length, 0); } finally { await close(tree); } }
  const f = fixture({ role: 'viewer' }), Screen = f.load('src/pawch/CareFlow.tsx').PawchCareScreen, tree = await render(Screen, props('25', navigation(), { observationId: 'observation-a' }));
  try { await press(tree, 'Mark as read by me'); assert.equal(writes(f)[0][0], 'patch'); assert.equal(writes(f)[0][1], '/health-observations/observation-a/read'); assert.ok(text(tree).includes('Reread acknowledgement')); }
  finally { await close(tree); }
  const care = await render(Screen, props('26'));
  try { await press(care, 'View care journal'); await edit(care, 'Care note', 'No shared write'); assert.equal(buttons(care, 'Save care note')[0].props.disabled, true); assert.equal(writes(f).filter(([method]) => method === 'post').length, 0); }
  finally { await close(care); }
});
