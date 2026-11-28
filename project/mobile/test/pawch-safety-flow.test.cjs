const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

const pet = { id: 'pet-a', household_id: 'home-a', name: '小路', species: 'dog', breed: '主人填写的特征', effective_timezone: 'Asia/Shanghai' };
function fixture(options = {}) {
  const writes = [], reads = [], jumps = [];
  let current, fences = options.emptyFence ? [] : [{ id: 'fence-a', name: '已确认的家', enabled: true, geometry: { type: 'circle', lat: 31.2, lon: 121.4, radius_m: 137 }, state: { effective_status: 'inside' } }];
  let prefs = { geofence: true, battery: false, offline: true, location: false };
  let reporting = { desired_version: 2, desired: { mode: 'home_active', interval_seconds: 180 }, applied_version: 1, status: 'pending', execution_source: null, lost_mode: { enabled: false } };
  let readingFails = false, postFails = options.postFails ?? false;
  const location = { id: 'location-a', pet_id: pet.id, lat: 31.2, lon: 121.4, accuracy_m: 18, device_ts: '2026-11-28T05:00:00Z', received_at: '2026-11-28T05:00:02Z', source: 'synthetic', freshness: 'fresh', usable_for_tracking: true };
  let device = { id: 'device-a', battery_pct: 64, low_battery: false, last_seen_at: '2026-11-28T05:00:02Z', connection_status: 'online' };
  const event = { id: 'event-a', pet_id: pet.id, type: 'geofence.exited', status: 'closed', occurred_at: '2026-11-28T03:00:00Z', location, details: { cause: 'confirmed_points' }, acknowledgement: null };
  const eventRows = { 'event-a': event, 'event-b': { ...event, id: 'event-b', acknowledgement: null } };
  const contacts = [{ id: 'contact-a', name: '真实接口联系人', version: 3, email: 'synthetic@example.invalid', consent: { status: 'reported_granted' } }];
  const api = { baseUrl: 'http://loopback.invalid/api/v1', get: async path => {
    reads.push(path);
    if (readingFails && path.includes('/geofences')) throw new Error('围栏读取暂时失败');
    if (path.endsWith('/overview')) { if (options.initialReadGate) await options.initialReadGate; return { pet, device: options.noDevice ? null : { ...device, reporting } }; }
    if (path.endsWith('/location/latest')) return options.noDevice ? {} : location;
    if (path.endsWith('/geofences')) { if (options.readGate && writes.some(row => row.path === '/geofences')) await options.readGate; return { items: fences }; }
    if (path === '/notification-preferences') return { ...prefs };
    if (path.startsWith('/safety-events/')) { const selected = eventRows[path.split('/').pop()] ?? event; return options.otherPetEvent ? { ...selected, pet_id: 'pet-b' } : { ...selected }; }
    if (path.includes('/safety-events?')) return { items: options.emptyEvent ? [] : [event], next_cursor: null };
    if (path.includes('/contacts?')) return { items: contacts };
    throw new Error('Unexpected GET ' + path);
  }, post: async (path, body) => {
    writes.push({ method: 'POST', path, body });
    if (postFails) throw new Error('断网，未确认保存');
    if (path === '/geofences') { const saved = { id: 'fence-new', ...body, state: { effective_status: 'unknown' } }; fences = [saved]; if (options.failSavedRead) readingFails = true; return saved; }
    if (path.endsWith('/lost-mode')) { reporting = { ...reporting, lost_mode: { enabled: body.enabled }, desired_version: 3 }; return reporting; }
    if (path.endsWith('/ack')) { eventRows[path.split('/').at(-2)].acknowledgement = { note: body.note }; return { event_status: 'closed' }; }
    throw new Error('Unexpected POST ' + path);
  }, patch: async (path, body) => {
    writes.push({ method: 'PATCH', path, body });
    if (path === '/notification-preferences') { prefs = { ...prefs, ...body }; return prefs; }
    if (path.startsWith('/geofences/')) { fences = fences.map(row => row.id === path.split('/').pop() ? { ...row, ...body } : row); return fences[0]; }
    throw new Error('Unexpected PATCH ' + path);
  }, put: async (path, body) => { writes.push({ method: 'PUT', path, body }); reporting = { ...reporting, desired: { mode: body.mode, interval_seconds: body.interval_seconds }, desired_version: 3 }; if (options.failPolicyRead) readingFails = true; return reporting; } };
  current = { api, user: { id: 'user-a' }, authenticated: true, pet, pets: [pet], household: { id: pet.household_id, role: options.role ?? 'owner' }, households: [{ id: pet.household_id, role: options.role ?? 'owner' }] };
  const { PawchSafetyScreen, SAFETY_SCREEN_IDS } = screenModule('src/pawch/SafetyFlow.tsx', () => current, { './assets': { Asset: props => React.createElement('Asset', props) } });
  const navigation = { navigate: (...args) => jumps.push(args), push: (...args) => jumps.push(args), addListener: () => () => {}, canGoBack: () => false };
  return { Screen: PawchSafetyScreen, ids: SAFETY_SCREEN_IDS, writes, reads, jumps, navigation, get state() { return current; }, set state(next) { current = next; }, set readingFails(value) { readingFails = value; }, set postFails(value) { postFails = value; },
    replaceDevice(id) { device = { ...device, id }; reporting = { desired_version: 1, desired: { mode: 'home_idle', interval_seconds: 900 }, applied_version: null, status: 'unconfigured', lost_mode: { enabled: false } }; } };
}
const text = tree => JSON.stringify(tree.toJSON());
const buttons = (tree, label) => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === label);
async function press(tree, label) { const node = buttons(tree, label)[0]; assert.ok(node, label); assert.ok(!node.props.disabled, label); await change(() => node.props.onPress()); }
const field = (tree, label) => tree.root.findByProps({ accessibilityLabel: label });
const edit = (tree, label, value) => change(() => field(tree, label).props.onChangeText(value));
const close = tree => change(() => tree.unmount());

test('all 15 safety artboards render their own screen identity without whole-screen image assets', async () => {
  const f = fixture(); assert.equal(f.ids.length, 15);
  for (const screenId of f.ids) {
    const tree = await render(f.Screen, { screenId, navigation: f.navigation });
    try { assert.ok(text(tree).includes('pawch-screen-' + screenId)); assert.equal(tree.root.findAllByType('Asset').some(node => /screens\//.test(node.props.name)), false); }
    finally { await close(tree); }
  }
  assert.equal(f.writes.length, 0);
});
test('location uses actual metrics, marks map illustration, and absent collar values remain unknown', async () => {
  for (const noDevice of [false, true]) {
    const f = fixture({ noDevice }), tree = await render(f.Screen, { screenId: '28', navigation: f.navigation });
    try { assert.ok(text(tree).includes('不代表当前宠物的位置')); assert.ok(!text(tree).includes('75%')); assert.ok(text(tree).includes(noDevice ? 'Battery Unknown' : 'Battery 64%')); await press(tree, 'View live status'); assert.equal(f.jumps.at(-1)[1].screenId, '29'); }
    finally { await close(tree); }
  }
});
test('missing location and missing session state do not borrow reassuring prototype titles', async () => {
  const f = fixture({ noDevice: true });
  for (const screenId of ['29', '37']) {
    const tree = await render(f.Screen, { screenId, navigation: f.navigation });
    try {
      if (screenId === '29') { assert.ok(text(tree).includes('Waiting for location.')); assert.ok(!text(tree).includes('小路, right here.')); }
      else { assert.ok(text(tree).includes('SESSION STATUS UNKNOWN')); assert.ok(!text(tree).includes('NO ACTIVE SESSION')); }
    } finally { await close(tree); }
  }
});
test('viewer cannot write the shared boundary but can save the geofence preference belonging to that account', async () => {
  const f = fixture({ role: 'viewer' }), boundary = await render(f.Screen, { screenId: '31', navigation: f.navigation });
  try { assert.equal(buttons(boundary, 'Save home boundary').length, 0); await press(boundary, 'Review boundary details'); assert.equal(field(boundary, 'Radius (m)').props.editable, false); } finally { await close(boundary); }
  const prefs = await render(f.Screen, { screenId: '32', navigation: f.navigation });
  try { await change(() => prefs.root.findAllByType('Switch')[0].props.onValueChange(false)); await press(prefs, 'Save notification settings'); assert.deepEqual(f.writes, [{ method: 'PATCH', path: '/notification-preferences', body: { geofence: false } }]); assert.ok(text(prefs).includes('本人偏好已保存并重新读取')); }
  finally { await close(prefs); }
});
test('new boundary saves real entered geometry and read failure can retry only reading', async () => {
  const f = fixture({ emptyFence: true, failSavedRead: true }), tree = await render(f.Screen, { screenId: '31', navigation: f.navigation });
  try {
    await edit(tree, '围栏名称', '真实输入'); await edit(tree, 'Radius (m)', '173'); await edit(tree, '纬度', '31.21'); await edit(tree, '经度', '121.41');
    await press(tree, 'Save home boundary'); assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].body.geometry, { type: 'circle', lat: 31.21, lon: 121.41, radius_m: 173 });
    assert.ok(text(tree).includes('围栏保存已确认')); assert.ok(buttons(tree, 'Save home boundary')[0].props.disabled);
    f.readingFails = false; await press(tree, '重新读取围栏'); assert.equal(f.writes.length, 1); assert.ok(text(tree).includes('围栏已保存并重新读取'));
  } finally { await close(tree); }
});
test('failed boundary write retains the draft and a later explicit retry saves once', async () => {
  const f = fixture({ emptyFence: true, postFails: true }), tree = await render(f.Screen, { screenId: '31', navigation: f.navigation });
  try {
    await edit(tree, '围栏名称', '网络故障的草稿'); await edit(tree, 'Radius (m)', '99'); await edit(tree, '纬度', '31'); await edit(tree, '经度', '121'); await press(tree, 'Save home boundary');
    assert.ok(text(tree).includes('断网，未确认保存')); assert.equal(field(tree, '围栏名称').props.value, '网络故障的草稿'); assert.ok(!text(tree).includes('围栏已保存并重新读取'));
    f.postFails = false; await press(tree, 'Save home boundary'); assert.equal(f.writes.length, 2); assert.ok(text(tree).includes('围栏已保存并重新读取'));
  } finally { await close(tree); }
});
test('boundary fields stay locked during commit and no reread-success is shown before the HTTP read completes', async () => {
  const pendingRead = deferred(), f = fixture({ emptyFence: true, readGate: pendingRead.promise }), tree = await render(f.Screen, { screenId: '31', navigation: f.navigation }); let running;
  try {
    await edit(tree, '围栏名称', '等待读取的边界'); await edit(tree, 'Radius (m)', '110'); await edit(tree, '纬度', '31'); await edit(tree, '经度', '121');
    await change(() => { running = buttons(tree, 'Save home boundary')[0].props.onPress(); });
    assert.equal(field(tree, '围栏名称').props.editable, false); assert.equal(field(tree, 'Radius (m)').props.editable, false);
    assert.ok(text(tree).includes('围栏保存已确认，正在重新读取')); assert.ok(!text(tree).includes('围栏已保存并重新读取'));
    await change(async () => { pendingRead.resolve(); await running; });
    assert.ok(text(tree).includes('围栏已保存并重新读取')); assert.equal(f.writes.length, 1);
  } finally { pendingRead.resolve(); await close(tree); }
});
test('power strategy preserves actual interval and only requests a policy, never claims hardware execution', async () => {
  const f = fixture(), tree = await render(f.Screen, { screenId: '34', navigation: f.navigation });
  try { await press(tree, 'Advanced power settings'); assert.equal(field(tree, 'Update interval (seconds)').props.value, '180'); await press(tree, '○  Battery saver'); await press(tree, 'Save power settings'); assert.deepEqual(f.writes[0], { method: 'PUT', path: '/devices/device-a/reporting-policy', body: { mode: 'low_power', interval_seconds: 180, expires_in_seconds: 300 } }); assert.ok(text(tree).includes('是否执行以设备回执为准')); assert.ok(!text(tree).includes('3 days')); }
  finally { await close(tree); }
});
test('event details reject a record belonging to another pet and cannot acknowledge it', async () => {
  const f = fixture({ otherPetEvent: true }), tree = await render(f.Screen, { screenId: '36', route: { params: { eventId: 'event-a' } }, navigation: f.navigation });
  try { assert.ok(text(tree).includes('此事件不属于当前宠物')); assert.equal(buttons(tree, '确认已知晓').length, 0); assert.equal(f.writes.length, 0); }
  finally { await close(tree); }
});
test('tracking requires write permission and a bound collar, then uses the existing lost-mode contract', async () => {
  for (const options of [{ role: 'viewer' }, { noDevice: true }, {}]) {
    const f = fixture(options), tree = await render(f.Screen, { screenId: '37', navigation: f.navigation });
    try { await press(tree, 'Manage finding session'); if (options.role || options.noDevice) { assert.ok(buttons(tree, 'Start finding session')[0].props.disabled); assert.equal(f.writes.length, 0); } else { await press(tree, 'Start finding session'); assert.deepEqual(f.writes[0].body, { enabled: true, expires_in_seconds: 3600 }); assert.ok(text(tree).includes('不是设备实际定位成功')); } }
    finally { await close(tree); }
  }
});
test('a successful rebind clears the old device power draft and tracking receipt', async () => {
  for (const screenId of ['34', '37']) {
    const f = fixture(), tree = await render(f.Screen, { screenId, navigation: f.navigation });
    try {
      await press(tree, screenId === '34' ? 'Advanced power settings' : 'Manage finding session');
      if (screenId === '34') await edit(tree, 'Update interval (seconds)', '777');
      else { await edit(tree, '寻找会话有效秒数', '120'); await press(tree, 'Start finding session'); }
      f.replaceDevice('device-b'); await press(tree, screenId === '34' ? '重新读取策略与回执' : '重新读取寻找会话');
      await press(tree, screenId === '34' ? 'Advanced power settings' : 'Manage finding session');
      if (screenId === '34') { assert.equal(field(tree, 'Update interval (seconds)').props.value, '900'); await press(tree, 'Save power settings'); assert.equal(f.writes.at(-1).path, '/devices/device-b/reporting-policy'); assert.equal(f.writes.at(-1).body.interval_seconds, 900); }
      else { assert.equal(field(tree, '寻找会话有效秒数').props.value, '3600'); assert.ok(!text(tree).includes('会话请求已受理')); assert.ok(text(tree).includes('NO ACTIVE SESSION')); }
    } finally { await close(tree); }
  }
});
test('a policy write receipt survives a failed reread of the same device and only reading is retried', async () => {
  const f = fixture({ failPolicyRead: true }), tree = await render(f.Screen, { screenId: '34', navigation: f.navigation });
  try { await press(tree, 'Save power settings'); assert.ok(text(tree).includes('请求已受理，当前状态未能重读')); assert.equal(f.writes.length, 1); f.readingFails = false; await press(tree, '重新读取策略与回执'); assert.equal(f.writes.length, 1); }
  finally { await close(tree); }
});
test('changing the selected event clears acknowledgement and notes belonging to the old event', async () => {
  const f = fixture(), tree = await render(f.Screen, { screenId: '36', navigation: f.navigation, route: { params: { eventId: 'event-a' } } });
  try {
    await press(tree, 'Review event evidence & acknowledgement'); await edit(tree, '确认备注（可空）', '只属于A的确认'); await press(tree, '确认已知晓'); assert.ok(text(tree).includes('已确认知晓'));
    await change(() => tree.update(React.createElement(f.Screen, { screenId: '36', navigation: f.navigation, route: { params: { eventId: 'event-b' } } })));
    await press(tree, 'Review event evidence & acknowledgement');
    assert.equal(buttons(tree, '确认已知晓').length, 1); assert.equal(field(tree, '确认备注（可空）').props.value, ''); assert.ok(!text(tree).includes('已确认知晓。'));
  } finally { await close(tree); }
});
test('missing-pet review is local only and old pet/account drafts cannot be confirmed', async () => {
  const f = fixture(), initial = await render(f.Screen, { screenId: '38a', navigation: f.navigation });
  try { await press(initial, 'Edit local report details'); await edit(initial, '宠物特征（只用于本次本地预览）', '本地描述'); await press(initial, 'Review alert'); } finally { await close(initial); }
  const params = f.jumps.at(-1)[1], review = await render(f.Screen, { screenId: '38b', navigation: f.navigation, route: { params } });
  try { await press(review, 'Confirm demo alert'); assert.equal(f.writes.length, 0); assert.equal(f.jumps.at(-1)[1].screenId, '38c'); } finally { await close(review); }
  f.state = { ...f.state, pet: { ...pet, id: 'pet-b' } };
  const stale = await render(f.Screen, { screenId: '38b', navigation: f.navigation, route: { params } });
  try { assert.ok(buttons(stale, 'Confirm demo alert')[0].props.disabled); assert.ok(text(stale).includes('所属宠物/账号已变更')); assert.equal(f.writes.length, 0); } finally { await close(stale); }
});
test('contact selection, review and confirmation never create notifications or a location share', async () => {
  const f = fixture(), tree = await render(f.Screen, { screenId: '39', navigation: f.navigation });
  try { await press(tree, '真实接口联系人'); await edit(tree, '本地预览文字', '仅作本地演示'); await press(tree, 'Preview for 1 contacts'); await press(tree, 'Confirm simulation to 1 contacts'); assert.ok(text(tree).includes('没有发送通知')); assert.equal(f.writes.length, 0); await press(tree, 'More contact options'); await press(tree, '联系人管理与文字通知业务'); assert.equal(f.jumps.at(-1)[0], 'Contacts'); }
  finally { await close(tree); }
});
test('demo maps reuse exported layers at the measured Figma slots without projecting API coordinates', async () => {
  for (const [screenId, name, height] of [['28', 'location-map', 216], ['29', 'live-status-map', 264], ['30', 'gps-accuracy-map', 212], ['31', 'home-boundary-map', 228], ['36', 'outside-zone-map', 208], ['37', 'track-baku-map', 280]]) {
    const f = fixture(), tree = await render(f.Screen, { screenId, navigation: f.navigation });
    try {
      const outside = ['36', '37'].includes(screenId), layer = asset => tree.root.findByProps({ testID: `demo-${name}-${asset}` });
      assert.ok(text(tree).includes('DEMO · 非实时地图')); assert.ok(text(tree).includes('不代表当前宠物的位置'));
      const marker = layer(outside ? 'map-pin-alert' : 'map-pin-safe'); assert.equal(marker.props.style.left, outside ? 236 : 143); assert.equal(marker.props.style.top, outside ? 34 : 91);
      assert.equal(layer('map-pin-home').props.style.top, outside ? height - 35 : 18);
      if (screenId === '30') assert.equal(tree.root.findAllByProps({ testID: `demo-${name}-map-boundary` }).length, 0);
      else { const boundary = layer('map-boundary'), asset = boundary.findByType('Asset'); assert.equal(boundary.props.style.width, outside ? 122 : 158); assert.equal(asset.props.style.width, undefined); assert.equal(asset.props.style.height, undefined); assert.equal(asset.props.style.transform[0].scale, outside ? 122 / 158 : 1); }
    } finally { await close(tree); }
  }
});
test('an existing boundary starts with a compact actual summary and one fixed save action while real fields remain editable', async () => {
  const f = fixture(), tree = await render(f.Screen, { screenId: '31', navigation: f.navigation });
  try {
    assert.ok(text(tree).includes('137 m')); assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Radius (m)' }).length, 0);
    assert.equal(tree.root.findByProps({ testID: 'pawch-footer-31' }).findAllByType('Pressable').some(node => node.props.accessibilityLabel === 'Save home boundary'), true);
    await press(tree, 'Edit boundary details'); assert.equal(field(tree, 'Radius (m)').props.value, '137'); await edit(tree, 'Radius (m)', '199'); await press(tree, 'Save home boundary'); assert.equal(f.writes[0].body.geometry.radius_m, 199); assert.ok(text(tree).includes('围栏已保存并重新读取'));
  } finally { await close(tree); }
});
test('initial safety loading locks shared editors until actual boundary and device data have arrived', async () => {
  for (const screenId of ['31', '34']) {
    const pending = deferred(), f = fixture({ initialReadGate: pending.promise }), tree = await render(f.Screen, { screenId, navigation: f.navigation });
    try {
      if (screenId === '31') assert.ok(buttons(tree, 'Edit boundary details')[0].props.disabled);
      else { await press(tree, 'Advanced power settings'); assert.ok(buttons(tree, '○  Battery saver')[0].props.disabled); assert.equal(field(tree, 'Update interval (seconds)').props.editable, false); }
      await change(() => pending.resolve());
      if (screenId === '31') { await press(tree, 'Edit boundary details'); assert.equal(field(tree, 'Radius (m)').props.value, '137'); }
      else { await press(tree, 'Advanced power settings'); assert.equal(field(tree, 'Update interval (seconds)').props.value, '180'); assert.equal(field(tree, 'Update interval (seconds)').props.editable, true); }
      assert.equal(f.writes.length, 0);
    } finally { pending.resolve(); await close(tree); }
  }
});
