const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, act, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

const household = { id: 'family-a', name: 'Family A', timezone: 'UTC', role: 'owner' };
const secondHousehold = { id: 'family-b', name: 'Family B', timezone: 'UTC', role: 'owner' };
const pet = { id: 'pet-a', name: 'Pet A', species: 'dog', household_id: household.id };
function app(api, extra = {}) {
  return { api: { baseUrl: 'http://qa.invalid/api/v1', origin: 'http://qa.invalid', get: async () => ({ items: [] }), ...api }, user: { id: 'user-a' }, household,
    households: [household, secondHousehold], pet, pets: [pet], refreshIdentity: async () => {}, selectPet() {}, ...extra };
}
function button(tree, title) { return tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === title); }
async function press(tree, title) {
  const target = button(tree, title); assert.ok(target, `Missing button ${title}`); assert.ok(!target.props.disabled, `Disabled button ${title}`);
  await change(() => target.props.onPress());
}
async function field(tree, label, value) { await change(() => tree.root.findByProps({ accessibilityLabel: label }).props.onChangeText(value)); }
async function choose(tree, label) {
  const target = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'radio' && node.findAllByType('Text').some(text => text.props.children === label));
  assert.ok(target, `Missing choice ${label}`); await change(() => target.props.onPress());
}
const text = tree => JSON.stringify(tree.toJSON());
async function close(tree) { await change(() => tree.unmount()); }
function nativeAlert(alert) {
  return { ...Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'KeyboardAvoidingView', 'ActivityIndicator', 'RefreshControl', 'Switch', 'Image'].map(name => [name, name])),
    Platform: { OS: 'android' }, StyleSheet: { create: value => value, hairlineWidth: 1 }, Alert: { alert }, AppState: { addEventListener: () => ({ remove() {} }) }, Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} } };
}

test('trajectory keeps the first server range on later pages and refresh obtains a new default window', async () => {
  const calls = [], range = { from: '2026-11-23T12:00:00.000Z', to: '2026-11-24T12:00:00.000Z' };
  const state = app({ get: async path => {
    calls.push(path);
    if (path.includes('/locations?')) return { items: [], next_cursor: path.includes('cursor=') ? null : 'older', range };
    if (path.endsWith('/overview')) return { device: null };
    return { items: [] };
  } });
  const { DevicesScreen } = screenModule('src/screens/DeviceScreens.tsx', state);
  const tree = await render(DevicesScreen, { navigation: {}, route: { params: { section: 'locations' } } });
  try {
    await press(tree, '更早记录');
    const next = new URL(calls.filter(path => path.includes('/locations?')).at(-1), state.api.origin);
    assert.equal(next.searchParams.get('cursor'), 'older'); assert.equal(next.searchParams.get('from'), range.from); assert.equal(next.searchParams.get('to'), range.to);
    await press(tree, '刷新本范围的第一页');
    const fresh = new URL(calls.filter(path => path.includes('/locations?')).at(-1), state.api.origin);
    assert.equal(fresh.searchParams.has('cursor'), false); assert.equal(fresh.searchParams.has('from'), false); assert.equal(fresh.searchParams.has('to'), false);
    await field(tree, '开始时间 ISO（可留空，默认最近24小时）', range.from);
    await field(tree, '结束时间 ISO（单次最多31天）', range.to);
    await press(tree, '应用时间范围'); await press(tree, '更早记录');
    const explicit = new URL(calls.filter(path => path.includes('/locations?')).at(-1), state.api.origin);
    assert.equal(explicit.searchParams.get('from'), range.from); assert.equal(explicit.searchParams.get('to'), range.to);
  } finally { await close(tree); }
});

test('late family invitation cannot put its token or draft into another household', async () => {
  const pending = deferred(); let running;
  const state = app({ get: async () => ({ items: [] }), post: async () => pending.promise });
  const { HouseholdScreen } = screenModule('src/screens/AccountScreens.tsx', state);
  const tree = await render(HouseholdScreen, { navigation: {} });
  try {
    await field(tree, '被邀请人的邮箱', 'synthetic@example.invalid');
    await change(() => { running = button(tree, '生成七天有效邀请').props.onPress(); });
    await choose(tree, 'Family B · owner');
    await change(async () => { pending.resolve({ token: 'PRIVATE-INVITATION-FROM-A', email: 'synthetic@example.invalid', role: 'viewer' }); await running; });
    assert.ok(!text(tree).includes('PRIVATE-INVITATION-FROM-A'));
    assert.equal(tree.root.findByProps({ accessibilityLabel: '被邀请人的邮箱' }).props.value, '');
    assert.equal(tree.root.findByProps({ accessibilityLabel: '家庭名称' }).props.value, 'Family B');
  } finally { await close(tree); }
});

test('a saved pet retries identity reading after failure without creating a second pet', async () => {
  let posts = 0, reads = 0; const selected = [];
  const state = app({ post: async () => { posts++; return { id: 'new-pet', name: 'New Pet' }; } }, { pet: null, pets: [],
    selectPet: id => selected.push(id), refreshIdentity: async () => { if (++reads === 1) throw new Error('Synthetic identity read unavailable'); } });
  const { PetScreen } = screenModule('src/screens/AccountScreens.tsx', state), tree = await render(PetScreen);
  try {
    await field(tree, '名称', 'New Pet'); await press(tree, '建立宠物档案');
    assert.equal(posts, 1); assert.ok(text(tree).includes('Synthetic identity read unavailable'));
    assert.ok(!button(tree, '建立宠物档案')); assert.ok(button(tree, '新建宠物').props.disabled);
    await press(tree, '重新读取已保存宠物');
    assert.equal(posts, 1); assert.equal(reads, 2); assert.deepEqual(selected, ['new-pet']);
  } finally { await close(tree); }
});

test('late pet save cannot reselect the previous pet after the current pet changes', async () => {
  const pending = deferred(), selected = []; let current = app({ patch: async () => pending.promise }, { selectPet: id => selected.push(id) }), running;
  const { PetScreen } = screenModule('src/screens/AccountScreens.tsx', () => current), tree = await render(PetScreen);
  try {
    await change(() => { running = button(tree, '保存档案').props.onPress(); });
    current = { ...current, pet: { ...pet, id: 'pet-b', name: 'Pet B' } };
    await change(() => tree.update(React.createElement(PetScreen)));
    await change(async () => { pending.resolve({ id: pet.id, name: pet.name }); await running; });
    assert.deepEqual(selected, []); assert.equal(tree.root.findByProps({ accessibilityLabel: '名称' }).props.value, 'Pet B');
  } finally { await close(tree); }
});

test('policy and lost-mode submission automatically read their returned command without an ID field', async () => {
  const calls = [], device = { id: 'device-a', serial_no: 'Synthetic collar', reporting: {} };
  const state = app({
    get: async path => { calls.push(path); return path.endsWith('/overview') ? { device } : path.includes('/commands/') ? { id: path.split('/').at(-1), status: 'pending' } : { items: [] }; },
    put: async () => ({ command_id: 'policy-command' }), post: async () => ({ command_id: 'lost-command' }),
  });
  const { DevicesScreen } = screenModule('src/screens/DeviceScreens.tsx', state), tree = await render(DevicesScreen, { navigation: {}, route: {} });
  try {
    await press(tree, '请求更新策略'); assert.ok(calls.includes('/devices/device-a/commands/policy-command'));
    assert.equal(tree.root.findAllByProps({ accessibilityLabel: '命令 ID' }).length, 0);
    await press(tree, '请求开启走失模式'); assert.ok(calls.includes('/devices/device-a/commands/lost-command'));
    assert.ok(button(tree, '刷新当前命令回执'));
  } finally { await close(tree); }
});

test('no-pet device empty state offers pet creation, help, and a return path', async () => {
  const destinations = [], state = app({}, { pet: null, pets: [] });
  const { DevicesScreen } = screenModule('src/screens/DeviceScreens.tsx', state), tree = await render(DevicesScreen, { navigation: { navigate: (...args) => destinations.push(args) }, route: {} });
  try {
    await press(tree, '宠物档案'); await press(tree, '绑定帮助与工单'); await press(tree, '返回安全页');
    assert.deepEqual(destinations, [['Pet'], ['Support'], ['Main', { screen: 'SafetyTab' }]]);
  } finally { await close(tree); }
});

test('owned unbound devices can be selected, renewed into the claim form, and released without entering a UUID', async () => {
  let items = [{ id: 'owned-a', serial_no: 'Synthetic owned collar', binding_status: 'unbound' }]; const posts = [];
  const state = app({ get: async path => path.startsWith('/devices?') ? { items } : { device: null }, post: async path => {
    posts.push(path); if (path.endsWith('/release')) { items = []; return { released: true }; }
    return { device_id: 'owned-a', claim_code: 'short-one-time-code', claim_expires_at: '2026-11-24T14:00:00.000Z' };
  } });
  const { DevicesScreen } = screenModule('src/screens/DeviceScreens.tsx', state, { 'react-native': nativeAlert((title, message, buttons) => buttons.find(button => button.text === '确认').onPress()) });
  const tree = await render(DevicesScreen, { navigation: {}, route: {} });
  try {
    await choose(tree, 'Synthetic owned collar · 已解绑'); await press(tree, '重新签发短期绑定码');
    assert.equal(tree.root.findByProps({ accessibilityLabel: '设备 ID' }).props.value, 'owned-a');
    assert.equal(tree.root.findByProps({ accessibilityLabel: '短期绑定码' }).props.value, 'short-one-time-code');
    assert.ok(button(tree, '复制绑定码')); assert.equal(posts.filter(path => path === '/devices/claim').length, 0);
    await press(tree, '释放所有权供他人认领');
    assert.ok(posts.includes('/devices/owned-a/release')); assert.ok(!text(tree).includes('short-one-time-code'));
    assert.ok(text(tree).includes('当前没有本人持有的设备'));
  } finally { await close(tree); }
});

test('late device renewal cannot fill the claim form for a different selected device', async () => {
  const pending = deferred(); let running;
  const items = ['a', 'b'].map(id => ({ id, serial_no: `Collar ${id}`, binding_status: 'unbound' }));
  const state = app({ get: async path => path.startsWith('/devices?') ? { items } : { device: null }, post: async () => pending.promise });
  const { DevicesScreen } = screenModule('src/screens/DeviceScreens.tsx', state), tree = await render(DevicesScreen, { navigation: {}, route: {} });
  try {
    await choose(tree, 'Collar a · 已解绑');
    await change(() => { running = button(tree, '重新签发短期绑定码').props.onPress(); });
    await choose(tree, 'Collar b · 已解绑');
    await change(async () => { pending.resolve({ device_id: 'a', claim_code: 'A-CODE-MUST-NOT-FILL-B' }); await running; });
    assert.equal(tree.root.findByProps({ accessibilityLabel: '设备 ID' }).props.value, '');
    assert.equal(tree.root.findByProps({ accessibilityLabel: '短期绑定码' }).props.value, '');
    assert.ok(!text(tree).includes('A-CODE-MUST-NOT-FILL-B'));
  } finally { await close(tree); }
});

test('member and contact confirmation dialogs cannot submit after switching the managed household', async () => {
  for (const area of ['member', 'contact']) {
    let confirm, running, deletes = 0;
    const contact = { id: 'contact-a', name: 'Synthetic contact', email: 'contact@example.invalid', version: 1, consent: { status: 'unknown' } };
    const member = { user_id: 'member-a', email: 'member@example.invalid', role: 'viewer' };
    const state = app({ get: async path => ({ items: path.startsWith(`/households/${household.id}/`) ? [area === 'member' ? member : contact] : [] }), delete: async () => { deletes++; } });
    const module = screenModule('src/screens/AccountScreens.tsx', state, { 'react-native': nativeAlert((title, message, buttons) => { confirm = () => buttons.find(button => button.text === '确认删除').onPress(); }) });
    const tree = await render(area === 'member' ? module.HouseholdScreen : module.ContactsScreen, { navigation: {} });
    try {
      await change(() => { running = button(tree, area === 'member' ? '移除这位成员' : '删除联系人').props.onPress(); });
      await choose(tree, area === 'member' ? 'Family B · owner' : 'Family B · 所有者');
      await change(async () => { confirm(); await running; }); assert.equal(deletes, 0, area);
    } finally { await close(tree); }
  }
});
