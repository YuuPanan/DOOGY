const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

const pet = { id: 'pet-a', household_id: 'home-a', name: 'Mochi', species: 'dog', breed: 'Saved breed', birth_date: null, weight_kg: 8.5, effective_timezone: 'Asia/Shanghai' };
function fixture(options = {}) {
  const calls = [], navigation = [], selected = [], listeners = new Map(); let state, reads = 0;
  let guide = { pet_id: pet.id, collar_choice: null, next_step: 'connect_collar', version: 2, binding: null, device_report: { status: 'unbound' }, ...options.guide };
  const api = { baseUrl: 'http://127.0.0.1:3000/api/v1',
    get: async path => { calls.push(['get', path]); if (options.get) { const value = await options.get(path, calls.filter(row => row[0] === 'get' && row[1] === path).length); if (value !== undefined) return value; }
      if (path === '/auth/onboarding') return { ...guide };
      if (path.startsWith('/pets/') && path.endsWith('/overview')) return { device: null };
      if (path.startsWith('/pets/')) return { ...pet };
      if (path === '/health') return { status: 'ok', mode: 'offline', database: 'sqlite', demo: true, demo_accounts: { owner: { email: 'owner@example.invalid', password: 'synthetic-password' }, viewer: { email: 'viewer@example.invalid', password: 'synthetic-password' } } };
      throw new Error('Unexpected GET ' + path);
    },
    post: async (path, body) => { calls.push(['post', path, body]); if (options.post) return options.post(path, body); if (path === '/pets') return { ...pet, ...body, id: 'created-pet' }; if (path === '/devices/claim') { guide = { ...guide, binding: { device_id: body.device_id }, next_step: 'finish' }; return { claimed: true }; } return {}; },
    patch: async (path, body) => { calls.push(['patch', path, body]); if (options.patch) return options.patch(path, body); if (path === '/auth/onboarding') { guide = { ...guide, ...body, version: guide.version + 1, ...(body.completed ? { next_step: 'done' } : {}) }; return { ...guide }; } return { ...pet, ...body }; },
  };
  state = { api, user: { id: 'user-a', email: 'owner@example.invalid' }, authenticated: options.authenticated ?? true, region: 'cn', serverUrl: 'http://127.0.0.1:3000', configurable: true,
    household: { id: 'home-a', role: options.role ?? 'owner' }, households: [{ id: 'home-a', name: 'Our home', role: options.role ?? 'owner' }], pet: options.empty ? null : { ...pet }, pets: options.empty ? [] : [{ ...pet }], onboarding: { ...guide }, restoreError: null, canRetryRestore: false,
    configure: async (region, url) => { calls.push(['configure', region, url]); return options.configure ? options.configure(region, url) : api; },
    authenticate: async (...args) => { calls.push(['authenticate', ...args]); if (options.authenticate) await options.authenticate(...args); },
    retryRestore: async () => { calls.push(['retryRestore']); }, selectPet: id => selected.push(id),
    refreshIdentity: async () => { reads++; calls.push(['identity']); if (options.identity) await options.identity(reads); },
  };
  const { PawchOnboardingScreen } = screenModule('src/pawch/OnboardingFlow.tsx', () => state, { './assets': { Asset: props => React.createElement('PawchAsset', props) } });
  return { Screen: PawchOnboardingScreen, calls, selected, navigation, get state() { return state; }, set state(value) { state = value; }, get guide() { return guide; },
    focus: () => change(() => listeners.get('focus')?.()),
    props: id => ({ screenId: id, navigation: { push: (...args) => navigation.push(['push', ...args]), navigate: (...args) => navigation.push(['navigate', ...args]), reset: value => navigation.push(['reset', value]), canGoBack: () => true, goBack: () => navigation.push(['back']), addListener: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); } } }) };
}
const content = tree => JSON.stringify(tree.toJSON());
const button = (tree, label) => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label);
async function press(tree, label) { const value = button(tree, label); assert.ok(value, label); assert.ok(!value.props.disabled, label + ' is enabled'); await change(() => value.props.onPress()); }
const input = (tree, label) => tree.root.findByProps({ accessibilityLabel: label });
const edit = (tree, label, value) => change(() => input(tree, label).props.onChangeText(value));
const close = tree => change(() => tree.unmount());

test('Welcome uses its original static illustration and interactive registration/login routes', async () => {
  const f = fixture({ authenticated: false }), tree = await render(f.Screen, f.props('01'));
  try { assert.equal(tree.root.findAllByType('PawchAsset').filter(node => node.props.name === 'welcome-baku').length, 1);
    await press(tree, 'Meet your new everyday'); await press(tree, 'I already have an account');
    assert.deepEqual(f.navigation, [['push', 'Pawch', { screenId: '02' }], ['push', 'Pawch', { screenId: '06' }]]); assert.equal(f.calls.length, 0);
  } finally { await close(tree); }
});

test('Login submits the edited credentials only after explicit connection, and restore retries never register', async () => {
  const f = fixture({ authenticated: false }), tree = await render(f.Screen, f.props('06'));
  try {
    await edit(tree, 'EMAIL', ' person@example.invalid '); await edit(tree, 'PASSWORD', 'synthetic-password'); await press(tree, 'Log in');
    assert.deepEqual(f.calls.slice(0, 2), [['configure', 'cn', 'http://127.0.0.1:3000'], ['authenticate', 'login', { email: 'person@example.invalid', password: 'synthetic-password' }]]);
    f.state = { ...f.state, restoreError: 'Identity read failed after login', canRetryRestore: true };
    await change(() => tree.update(React.createElement(f.Screen, f.props('06')))); await press(tree, 'Retry saved session');
    assert.equal(f.calls.filter(row => row[0] === 'authenticate').length, 1); assert.equal(f.calls.filter(row => row[0] === 'retryRestore').length, 1);
    await press(tree, 'Connection & service region');
    assert.ok(content(tree).includes('Apple / Google sign-in is not configured'));
  } finally { await close(tree); }
});

test('Create account sends actual entered values without inventing consent or prototype accounts', async () => {
  const f = fixture({ authenticated: false }), tree = await render(f.Screen, f.props('02'));
  try {
    await edit(tree, 'YOUR NAME', ' New owner '); await edit(tree, 'EMAIL', ' new@example.invalid '); await edit(tree, 'PASSWORD', 'synthetic-password');
    await press(tree, 'Create account'); const auth = f.calls.find(row => row[0] === 'authenticate');
    assert.equal(auth[1], 'register'); assert.equal(auth[2].email, 'new@example.invalid'); assert.equal(auth[2].display_name, 'New owner'); assert.equal(auth[2].household_name, '我的家庭'); assert.equal(Object.hasOwn(auth[2], 'consent'), false);
    assert.ok(!content(tree).includes('No account is created or data sent'));
  } finally { await close(tree); }
});

test('leaving Login while its connection check is pending cannot submit authentication afterward', async () => {
  const pending = deferred(), f = fixture({ authenticated: false, configure: () => pending.promise }), tree = await render(f.Screen, f.props('06')); let running;
  await edit(tree, 'EMAIL', 'person@example.invalid'); await edit(tree, 'PASSWORD', 'synthetic-password');
  await change(() => { running = button(tree, 'Log in').props.onPress(); }); await close(tree);
  await change(async () => { pending.resolve(f.state.api); await running; });
  assert.equal(f.calls.filter(row => row[0] === 'authenticate').length, 0);
});

test('created pet survives a failed identity read and reading/continuing does not create it twice', async () => {
  const f = fixture({ empty: true, guide: { pet_id: null, version: 0, next_step: 'create_or_select_pet' }, identity: async count => { if (count === 1) throw new Error('Synthetic identity read unavailable'); } }), tree = await render(f.Screen, f.props('03'));
  try {
    await edit(tree, "DOG'S NAME", 'New friend'); await press(tree, 'Looks like my best friend');
    assert.ok(content(tree).includes('New friend')); assert.ok(button(tree, 'Reread the created profile')); assert.ok(!button(tree, 'Looks like my best friend'));
    await press(tree, 'Reread the created profile'); await press(tree, 'Continue with New friend');
    assert.equal(f.calls.filter(row => row[0] === 'post' && row[1] === '/pets').length, 1);
    assert.equal(f.calls.filter(row => row[0] === 'patch' && row[1] === '/auth/onboarding').length, 1);
    assert.deepEqual(f.selected, ['created-pet']); assert.ok(f.navigation.some(row => row[2]?.screenId === '04'));
  } finally { await close(tree); }
});

test('late creation after switching the active pet does not select or navigate the new scope', async () => {
  const pending = deferred(), f = fixture({ empty: true, post: () => pending.promise }), tree = await render(f.Screen, f.props('03')); let running;
  try {
    await edit(tree, "DOG'S NAME", 'Created in prior scope'); await change(() => { running = button(tree, 'Looks like my best friend').props.onPress(); });
    f.state = { ...f.state, pet: { ...pet, id: 'other-pet' }, pets: [{ ...pet, id: 'other-pet' }] };
    await change(() => tree.update(React.createElement(f.Screen, f.props('03'))));
    await change(async () => { pending.resolve({ ...pet, id: 'created-late', name: 'Created in prior scope' }); await running; });
    assert.deepEqual(f.selected, []); assert.deepEqual(f.navigation, []); assert.equal(f.calls.filter(row => row[0] === 'identity').length, 0);
  } finally { await close(tree); }
});

for (const selectedPet of ['created-pet', 'another-pet']) test(`creation continuation tolerates only its own delayed selected-pet commit: ${selectedPet}`, async () => {
  const pending = deferred(), created = { ...pet, id: 'created-pet', name: 'First friend' };
  const f = fixture({ empty: true, guide: { pet_id: null, version: 0, next_step: 'create_or_select_pet' }, get: async (path, count) => path === '/auth/onboarding' && count === 2 ? pending.promise : undefined });
  const tree = await render(f.Screen, f.props('03')); let running;
  try {
    await edit(tree, "DOG'S NAME", 'First friend'); await change(() => { running = button(tree, 'Looks like my best friend').props.onPress(); });
    assert.equal(f.calls.filter(row => row[0] === 'get' && row[1] === '/auth/onboarding').length, 2);
    f.state = { ...f.state, pet: { ...created, id: selectedPet }, pets: [created, { ...pet, id: 'another-pet' }] };
    await change(() => tree.update(React.createElement(f.Screen, f.props('03'))));
    await change(async () => { pending.resolve({ pet_id: null, version: 0, next_step: 'create_or_select_pet' }); await running; });
    const writes = f.calls.filter(row => row[0] === 'patch' && row[1] === '/auth/onboarding');
    assert.equal(writes.length, selectedPet === 'created-pet' ? 1 : 0);
    if (selectedPet === 'created-pet') { assert.deepEqual(f.selected, ['created-pet']); assert.ok(f.navigation.some(row => row[2]?.screenId === '04')); }
    else { assert.deepEqual(f.selected, []); assert.deepEqual(f.navigation, []); }
  } finally { await close(tree); }
});

test('collar claim requires explicit credentials and accepted claim retries only its read', async () => {
  const f = fixture({ get: async (path, count) => { if (path === '/auth/onboarding' && count === 2) throw new Error('Synthetic binding read failure'); } }), tree = await render(f.Screen, f.props('04'));
  try {
    assert.ok(button(tree, 'Bind this collar').props.disabled); assert.ok(content(tree).includes('Not configured · no scan is performed'));
    await edit(tree, 'Device ID', 'device-a'); await edit(tree, 'Short-lived claim code', 'synthetic-claim'); await press(tree, 'Bind this collar');
    assert.ok(button(tree, 'Reread saved binding')); assert.ok(!button(tree, 'Bind this collar'));
    await press(tree, 'Reread saved binding');
    assert.equal(f.calls.filter(row => row[0] === 'post' && row[1] === '/devices/claim').length, 1);
    assert.ok(f.navigation.some(row => row[2]?.screenId === '05'));
  } finally { await close(tree); }
});

test('viewer cannot claim a collar but may explicitly skip it without claiming Bluetooth success', async () => {
  const f = fixture({ role: 'viewer' }), tree = await render(f.Screen, f.props('04'));
  try {
    assert.ok(button(tree, 'Bind this collar').props.disabled); assert.equal(input(tree, 'Device ID').props.editable, false);
    await press(tree, 'Skip collar for now');
    assert.equal(f.calls.filter(row => row[0] === 'post').length, 0);
    assert.deepEqual(f.calls.find(row => row[0] === 'patch')[2], { pet_id: pet.id, collar_choice: 'skipped', expected_version: 2 });
    assert.ok(f.navigation.some(row => row[2]?.screenId === '05'));
  } finally { await close(tree); }
});

test('an existing binding is reread and continued without asking for or claiming a second device', async () => {
  const f = fixture({ guide: { binding: { device_id: 'saved-device' }, next_step: 'finish' } }), tree = await render(f.Screen, f.props('04'));
  try {
    assert.ok(!button(tree, 'Bind this collar')); assert.ok(!button(tree, 'Skip collar for now')); assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Short-lived claim code' }).length, 0);
    await press(tree, 'Continue with saved binding'); assert.equal(f.calls.filter(row => row[0] === 'post' || row[0] === 'patch').length, 0); assert.ok(f.navigation.some(row => row[2]?.screenId === '05'));
  } finally { await close(tree); }
});

test('completed setup with failed reread retries only identity, not its completion write', async () => {
  const f = fixture({ guide: { collar_choice: 'skipped', next_step: 'finish' }, identity: async count => { if (count === 1) throw new Error('Synthetic completion identity failure'); } }), tree = await render(f.Screen, f.props('05'));
  try {
    assert.ok(content(tree).includes('Start without a collar')); assert.ok(!content(tree).includes('Collar connected'));
    await press(tree, "Explore Mochi's Today"); assert.ok(button(tree, 'Reread completed setup'));
    await press(tree, 'Reread completed setup');
    assert.equal(f.calls.filter(row => row[0] === 'patch').length, 1); assert.ok(f.navigation.some(row => row[0] === 'reset'));
  } finally { await close(tree); }
});

test('acknowledged completion reread cannot silently finish a setup that was changed elsewhere', async () => {
  const f = fixture({ guide: { collar_choice: 'skipped', next_step: 'finish' }, identity: async () => { throw new Error('Synthetic identity read failure'); } }), tree = await render(f.Screen, f.props('05'));
  try {
    await press(tree, "Explore Mochi's Today"); f.guide.next_step = 'finish';
    await press(tree, 'Reread completed setup');
    assert.equal(f.calls.filter(row => row[0] === 'patch').length, 1); assert.ok(content(tree).includes('no longer current'));
  } finally { await close(tree); }
});

test('profile saves/rereads once and does not duplicate an unchanged weight as a weigh-in', async () => {
  const f = fixture(), tree = await render(f.Screen, f.props('07'));
  try {
    await edit(tree, 'NAME', 'Mochi edited'); await press(tree, 'Save profile');
    const write = f.calls.find(row => row[0] === 'patch'); assert.equal(write[1], '/pets/pet-a'); assert.equal(write[2].name, 'Mochi edited'); assert.equal(Object.hasOwn(write[2], 'weight_kg'), false);
    assert.ok(f.calls.some(row => row[0] === 'get' && row[1] === '/pets/pet-a')); assert.deepEqual(f.navigation, [['back']]);
  } finally { await close(tree); }
});

test('profile has an interactive route to the new Pawch care journal with its return source', async () => {
  const f = fixture(), tree = await render(f.Screen, f.props('07'));
  try { await press(tree, 'More profile options'); await press(tree, 'Care journal'); assert.deepEqual(f.navigation, [['push', 'Pawch', { returnTo: '07', screenId: '26' }]]); }
  finally { await close(tree); }
});

test('profile acknowledged save with failed read keeps a receipt and rereads without another weight write', async () => {
  const f = fixture({ get: async (path, count) => { if (path === '/pets/pet-a' && count === 1) throw new Error('Synthetic saved profile read failure'); } }), tree = await render(f.Screen, f.props('07'));
  try {
    await edit(tree, 'WEIGHT kg', '9.2'); await press(tree, 'Save profile');
    assert.ok(button(tree, 'Reread saved profile')); assert.ok(!button(tree, 'Save profile'));
    await press(tree, 'Reread saved profile'); assert.equal(f.calls.filter(row => row[0] === 'patch').length, 1); assert.equal(f.calls.find(row => row[0] === 'patch')[2].weight_kg, 9.2);
  } finally { await close(tree); }
});

test('same-pet identity updates preserve the profile draft, but role downgrade clears and locks it', async () => {
  const f = fixture(), tree = await render(f.Screen, f.props('07'));
  try {
    await edit(tree, 'NAME', 'Local draft'); f.state = { ...f.state, pet: { ...pet, name: 'Remote update', updated_at: 'later' } };
    await change(() => tree.update(React.createElement(f.Screen, f.props('07')))); assert.equal(input(tree, 'NAME').props.value, 'Local draft');
    f.state = { ...f.state, households: [{ ...f.state.households[0], role: 'viewer' }] };
    await change(() => tree.update(React.createElement(f.Screen, f.props('07')))); assert.equal(input(tree, 'NAME').props.value, 'Remote update'); assert.equal(input(tree, 'NAME').props.editable, false); assert.ok(button(tree, 'Save profile').props.disabled);
    assert.equal(f.calls.filter(row => row[0] === 'patch').length, 0);
    f.state = { ...f.state, pet: null, pets: [], households: [], household: null };
    await change(() => tree.update(React.createElement(f.Screen, f.props('07')))); assert.ok(!content(tree).includes('Local draft')); assert.ok(!button(tree, 'Save profile'));
  } finally { await close(tree); }
});

test('returning to an untouched profile rereads the persisted weight without creating a weigh-in', async () => {
  const f = fixture({ identity: async () => { f.state = { ...f.state, pet: { ...pet, weight_kg: 9.1, name: 'Updated companion' } }; } }), tree = await render(f.Screen, f.props('07'));
  try {
    assert.equal(input(tree, 'WEIGHT kg').props.value, '8.5'); await f.focus();
    await change(() => tree.update(React.createElement(f.Screen, f.props('07'))));
    assert.equal(input(tree, 'WEIGHT kg').props.value, '9.1'); assert.equal(input(tree, 'NAME').props.value, 'Updated companion');
    assert.equal(f.calls.filter(row => row[0] === 'identity').length, 1); assert.equal(f.calls.filter(row => row[0] === 'patch').length, 0);
  } finally { await close(tree); }
});

test('profile focus read failure is visible and retrying it only rereads persisted data', async () => {
  const f = fixture({ identity: async count => { if (count === 1) throw new Error('Synthetic focused profile unavailable'); f.state = { ...f.state, pet: { ...pet, weight_kg: 9.4 } }; } }), tree = await render(f.Screen, f.props('07'));
  try {
    await f.focus(); assert.ok(content(tree).includes('Synthetic focused profile unavailable'));
    await press(tree, 'Retry profile read'); await change(() => tree.update(React.createElement(f.Screen, f.props('07'))));
    assert.equal(input(tree, 'WEIGHT kg').props.value, '9.4'); assert.equal(f.calls.filter(row => row[0] === 'identity').length, 2); assert.equal(f.calls.filter(row => row[0] === 'patch').length, 0);
  } finally { await close(tree); }
});

test('unread collar status stays unknown and cannot be treated as an unbound/75% device', async () => {
  const f = fixture({ get: async path => { if (path.endsWith('/overview')) throw new Error('Synthetic overview unavailable'); } }), tree = await render(f.Screen, f.props('08'));
  try {
    assert.ok(content(tree).includes('COLLAR STATUS UNKNOWN')); assert.ok(content(tree).includes('Battery unknown')); assert.ok(!content(tree).includes('75%'));
    assert.ok(!button(tree, 'Bind a pre-provisioned collar')); await press(tree, 'Battery & charging'); await press(tree, 'Location & GPS'); await press(tree, 'Power settings'); await press(tree, 'Home boundary');
    assert.deepEqual(f.navigation.map(row => row[2].screenId), ['33', '30', '34', '31']);
  } finally { await close(tree); }
});

test('collar settings preserves an actual zero battery reading without estimating remaining days', async () => {
  const f = fixture({ get: async path => path.endsWith('/overview') ? { device: { id: 'device-a', battery_pct: 0, serial_no: 'Synthetic collar', connection_status: 'offline' } } : undefined }), tree = await render(f.Screen, f.props('08'));
  try { assert.ok(content(tree).includes('0% battery')); assert.ok(!content(tree).includes('3 days')); assert.ok(!button(tree, 'Bind a pre-provisioned collar')); }
  finally { await close(tree); }
});
