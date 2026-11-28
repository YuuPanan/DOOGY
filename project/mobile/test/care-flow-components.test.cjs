const test = require('node:test');
const assert = require('node:assert/strict');
const { screenModule, render, change, deferred, act, React } = require('./helpers/render-screen.cjs');

const clone = value => structuredClone(value);
const pet = { id: 'pet-a', household_id: 'home', name: '伙伴', effective_timezone: 'UTC' };
const household = { id: 'home', role: 'owner' };
const field = (tree, label) => tree.root.findByProps({ accessibilityLabel: label, autoCapitalize: 'none' });
const button = (tree, title) => tree.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: title });
const edit = (tree, label, value) => change(() => field(tree, label).props.onChangeText(value));
const press = (tree, title) => change(() => button(tree, title).props.onPress());
const close = tree => change(() => tree.unmount());
function navigation() {
  const calls = [], listeners = {};
  return { calls, listeners, navigate: (...args) => calls.push(['navigate', ...args]), popTo: (...args) => calls.push(['popTo', ...args]),
    reset: (...args) => calls.push(['reset', ...args]), setParams() {}, addListener: (event, callback) => { listeners[event] = callback; return () => { delete listeners[event]; }; } };
}
function wellness() {
  let goal = { id: 'goal', effective_date: '2026-11-24', version: 1, targets: { active_minutes: 30, steps: 3000, intake_kcal: null }, plan: null };
  let body = { id: 'body', local_date: '2026-11-24', timezone: 'UTC', version: 1, values: { appetite: '原食欲', energy: null, movement: null, stool: null }, notes: '', observed_at: null, toileting_record_id: null };
  let fail = false, knownKcal = null;
  const calls = [];
  const api = { baseUrl: 'http://test/api/v1', async get(path) {
    calls.push(['get', path]); const url = new URL(path, 'http://test'), date = url.searchParams.get('date') ?? '2026-11-24';
    if (url.pathname.endsWith('/observations/current') || url.pathname.endsWith('/activity/intervals')) return {};
    if (fail) throw new Error('临时读取失败');
    if (url.pathname.endsWith('/activity/daily')) return { local_date: date, timezone: 'UTC', period_start: `${date}T00:00:00Z`, period_end: `${date}T23:59:59Z` };
    if (url.pathname.endsWith('/goals')) return clone({ local_date: date, timezone: 'UTC', effective_date_version: goal.version, goals: goal });
    if (url.pathname.endsWith('/body-check-ins')) return clone({ ...body, local_date: date });
    if (url.pathname.endsWith('/nutrition/daily')) return { known_kcal: knownKcal };
    if (url.pathname.endsWith('/care-records')) return { items: [] };
    return {};
  }, async put(path, payload) {
    calls.push(['put', path, clone(payload)]);
    if (path.endsWith('/goals')) {
      if (payload.expected_version !== goal.version) throw Object.assign(new Error('目标版本冲突'), { status: 409 });
      goal = { id: 'goal', ...payload, version: goal.version + 1 }; return clone(goal);
    }
    if (payload.expected_version !== body.version) throw Object.assign(new Error('身体观察版本冲突'), { status: 409 });
    body = { ...body, ...payload, version: body.version + 1 }; return clone(body);
  } };
  return { api, calls, state: { api, pet, household }, set fail(value) { fail = value; }, set knownKcal(value) { knownKcal = value; },
    changeGoal() { goal = { ...goal, version: goal.version + 1, targets: { ...goal.targets, active_minutes: 45 } }; },
    changeBody() { body = { ...body, version: body.version + 1, values: { ...body.values, appetite: '另一成员更新' } }; } };
}

test('registration omits a blank optional display name', async () => {
  const calls = [], state = { region: 'cn', serverUrl: 'http://test', configurable: true,
    configure: async () => ({}), authenticate: async (...args) => calls.push(args) };
  const { AuthScreen } = screenModule('src/screens/AuthScreen.tsx', state), tree = await render(AuthScreen);
  await change(() => tree.root.findAllByProps({ accessibilityRole: 'radio' }).find(row => row.findByType('Text').props.children === '注册').props.onPress());
  await edit(tree, '邮箱', 'q@q.test'); await edit(tree, '密码（8 至 128 字符）', '12345678'); await edit(tree, '显示名（可选）', '   ');
  await press(tree, '创建账户并登录');
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'register'); assert.equal(Object.hasOwn(calls[0][1], 'display_name'), false);
  await close(tree);
});

test('saving either wellness section and ordinary refresh preserve the other section draft, including a failed read', async () => {
  const setup = wellness(), nav = navigation(), { WellnessScreen } = screenModule('src/screens/CareScreens.tsx', setup.state);
  const tree = await render(WellnessScreen, { navigation: nav, route: { params: {} } });
  await edit(tree, '食欲原文（可留空）', '我的食欲草稿'); await edit(tree, '活动分钟目标（可留空）', '35');
  await press(tree, '保存目标与计划');
  assert.equal(field(tree, '食欲原文（可留空）').props.value, '我的食欲草稿');
  await edit(tree, '步数目标（可留空）', '4321'); await press(tree, '保存身体观察');
  assert.equal(field(tree, '步数目标（可留空）').props.value, '4321');
  await press(tree, '读取所选日期'); assert.equal(field(tree, '步数目标（可留空）').props.value, '4321');
  setup.fail = true; await press(tree, '读取所选日期');
  setup.fail = false; await press(tree, '读取所选日期');
  assert.equal(field(tree, '步数目标（可留空）').props.value, '4321');
  await close(tree);
});

test('a changed goal version preserves dirty inputs until explicit discard and reread', async () => {
  const setup = wellness(), { WellnessScreen } = screenModule('src/screens/CareScreens.tsx', setup.state);
  const tree = await render(WellnessScreen, { navigation: navigation(), route: { params: {} } });
  await edit(tree, '活动分钟目标（可留空）', '55'); setup.changeGoal(); await press(tree, '读取所选日期');
  assert.equal(field(tree, '活动分钟目标（可留空）').props.value, '55');
  assert.equal(button(tree, '保存目标与计划').props.disabled, true);
  await press(tree, '重读目标（丢弃本分项草稿）');
  assert.equal(field(tree, '活动分钟目标（可留空）').props.value, '45');
  await press(tree, '保存目标与计划');
  assert.equal(setup.calls.filter(row => row[0] === 'put').at(-1)[2].expected_version, 2);
  await close(tree);
});

test('a body save conflict keeps its original draft version and offers explicit reread', async () => {
  const setup = wellness(), { WellnessScreen } = screenModule('src/screens/CareScreens.tsx', setup.state);
  const tree = await render(WellnessScreen, { navigation: navigation(), route: { params: { section: 'body' } } });
  await edit(tree, '食欲原文（可留空）', '我的冲突草稿'); setup.changeBody(); await press(tree, '保存身体观察');
  assert.equal(setup.calls.filter(row => row[0] === 'put').at(-1)[2].expected_version, 1);
  assert.equal(field(tree, '食欲原文（可留空）').props.value, '我的冲突草稿'); assert.equal(button(tree, '保存身体观察').props.disabled, true);
  await press(tree, '重读身体观察（丢弃本分项草稿）'); assert.equal(field(tree, '食欲原文（可留空）').props.value, '另一成员更新');
  await edit(tree, '食欲原文（可留空）', '重新核对后的记录'); await press(tree, '保存身体观察');
  assert.equal(setup.calls.filter(row => row[0] === 'put').at(-1)[2].expected_version, 2); await close(tree);
});

test('a selected structured plan becomes an editable draft once, preserving target and requiring save', async () => {
  const setup = wellness(), route = { params: { section: 'goals', plan: { id: 'plan-a', title: '慢慢运动', content_version: 4, walk_minutes: 10, play_minutes: 5, training_minutes: 2 } } };
  const { WellnessScreen } = screenModule('src/screens/CareScreens.tsx', setup.state), tree = await render(WellnessScreen, { navigation: navigation(), route });
  assert.equal(field(tree, '计划名称').props.value, '慢慢运动'); assert.equal(field(tree, '活动分钟目标（可留空）').props.value, '30');
  assert.equal(setup.calls.some(row => row[0] === 'put'), false);
  await edit(tree, '散步分钟', '12'); await press(tree, '读取所选日期');
  assert.equal(field(tree, '散步分钟').props.value, '12'); await press(tree, '保存目标与计划');
  const saved = setup.calls.find(row => row[0] === 'put')[2];
  assert.equal(saved.source, 'user_provided'); assert.equal(saved.targets.active_minutes, 30); assert.equal(saved.plan.walk_minutes, 12); assert.equal(saved.plan.content_version, 'plan-a@4');
  await close(tree);
});

test('returning from care uses the existing Main route and legacy feeding edits preserve its original amount and unit', async () => {
  let record = { id: 'care-a', type: 'feeding', recorded_at: '2026-11-23T12:00:00Z', updated_at: 'a', created_by: 'u', value: { food: '旧记录', amount: 1, unit: 'kg', extra: '保留' }, attachments: [] };
  const calls = [], api = { get: async path => path.includes('/history') ? {} : path.startsWith('/care-records/') ? clone(record) : { items: [clone(record)] },
    patch: async (path, payload) => { calls.push(payload); record = { ...record, ...payload, updated_at: 'b' }; return clone(record); } };
  const nav = navigation(), { CareScreen } = screenModule('src/screens/CareScreens.tsx', { api, pet, household, user: { id: 'u' } });
  const tree = await render(CareScreen, { navigation: nav, route: { params: {} } });
  await press(tree, '详情与修订'); await press(tree, '返回今天查看汇总');
  assert.deepEqual(nav.calls.at(-1), ['popTo', 'Main', { screen: 'HomeTab' }]);
  await press(tree, '编辑这条记录'); await edit(tree, '喂食量（kg）', '2'); await press(tree, '保存记录');
  assert.deepEqual(calls[0].value, { food: '旧记录', amount: 2, unit: 'kg', extra: '保留' });
  await close(tree);
});

test('successful onboarding completion enters Main, while opening a completed guide remains deliberate', async () => {
  let guide = { version: 1, pet_id: pet.id, collar_choice: null, next_step: 'collar', binding: null };
  const nav = navigation(), state = { api: { baseUrl: 'test', get: async () => clone(guide), patch: async (_, body) => { guide = { ...guide, ...body, version: 2, next_step: 'done' }; } },
    user: { id: 'u' }, household, households: [household], pet, pets: [pet], refreshIdentity: async () => {}, selectPet() {} };
  const { OnboardingScreen } = screenModule('src/screens/OnboardingScreen.tsx', state), tree = await render(OnboardingScreen, { navigation: nav });
  await press(tree, '跳过项圈并完成引导'); assert.deepEqual(nav.calls.at(-1), ['reset', { index: 0, routes: [{ name: 'Main' }] }]);
  await close(tree); nav.calls.length = 0;
  const reopened = await render(OnboardingScreen, { navigation: nav }); assert.equal(nav.calls.length, 0); await close(reopened);
});

test('wellness focus rereads nutrition after returning from care without replacing a dirty goal', async () => {
  const setup = wellness(), nav = navigation(), { WellnessScreen } = screenModule('src/screens/CareScreens.tsx', setup.state);
  const tree = await render(WellnessScreen, { navigation: nav, route: { params: { section: 'nutrition' } } });
  await edit(tree, '步数目标（可留空）', '5555');
  await press(tree, '记录一餐'); assert.deepEqual(nav.calls.at(-1), ['navigate', 'Care', { createType: 'feeding' }]);
  setup.knownKcal = 123; await change(() => nav.listeners.focus());
  assert.equal(field(tree, '步数目标（可留空）').props.value, '5555');
  assert.ok(tree.root.findAllByType('Text').some(node => node.props.children === '123'));
  await press(tree, '查看喂养指导'); assert.deepEqual(nav.calls.at(-1), ['navigate', 'Learning', { kind: 'guidance', category: 'nutrition' }]);
  await press(tree, '浏览运动计划'); assert.deepEqual(nav.calls.at(-1), ['navigate', 'Learning', { kind: 'plan', category: 'exercise' }]);
  await close(tree);
});

test('health generation resets the fixed history window to include the returned snapshot and feedback stays bound during its request', async () => {
  const posting = deferred(), generated = new Date(Date.now() + 5000).toISOString();
  const observation = { id: 'obs-a', pet_id: pet.id, generated_at: generated, local_date: '2026-11-23', timezone: 'UTC',
    observations: [{ metric: 'steps', text: '测试用变化记录', evidence_ids: ['evidence-a'] }], evidence: [{ id: 'evidence-a', metric: 'steps' }] };
  let created = false; const posts = [], lists = [];
  const api = { async get(path) {
    const url = new URL(path, 'http://test');
    if (url.pathname.endsWith('/observations')) { created = true; return observation; }
    if (url.pathname.endsWith('/health-observations')) {
      lists.push(url); const visible = created && Date.parse(url.searchParams.get('from')) <= Date.parse(generated) && Date.parse(generated) < Date.parse(url.searchParams.get('to'));
      return { items: visible ? [{ ...observation, finding_count: 1 }] : [] };
    }
    return { id: observation.id, assessment: observation };
  }, post(path, body) { posts.push({ path, body }); return posting.promise; } };
  const { HealthScreen } = screenModule('src/screens/CareScreens.tsx', { api, pet, household }), nav = navigation();
  const tree = await render(HealthScreen, { navigation: nav });
  await press(tree, '查看照护说明'); assert.deepEqual(nav.calls.at(-1), ['navigate', 'Learning', { kind: 'guidance', category: 'health' }]);
  await press(tree, '读取/生成该日实际评估');
  assert.equal(button(tree, '查看原评估与证据').props.disabled, undefined);
  assert.ok(Date.parse(lists.at(-1).searchParams.get('to')) > Date.parse(generated));
  const evidenceChoice = tree.root.findAllByProps({ accessibilityRole: 'radio' }).find(row => row.findByType('Text').props.children === '步数');
  await change(() => evidenceChoice.props.onPress()); await edit(tree, '反馈说明（1–4000字）', '针对这一版的说明');
  let pending;
  await act(async () => { pending = button(tree, '保存关联反馈').props.onPress(); });
  assert.equal(field(tree, '反馈说明（1–4000字）').props.editable, false);
  await edit(tree, '反馈说明（1–4000字）', '不能覆盖正在提交的说明');
  assert.equal(field(tree, '反馈说明（1–4000字）').props.value, '针对这一版的说明');
  assert.equal(evidenceChoice.props.disabled, true);
  posting.resolve({ id: 'feedback-a', comment: posts[0].body.comment }); await change(() => pending);
  assert.deepEqual(posts[0], { path: `/pets/${pet.id}/feedback`, body: { feature_date: observation.local_date, assessment: 'helpful', comment: '针对这一版的说明', observation: { id: 'obs-a', evidence_id: 'evidence-a' } } });
  await edit(tree, '反馈说明（1–4000字）', '另一条反馈');
  assert.equal(tree.root.findAllByType('Text').some(node => node.props.children === '已保存这份反馈。编辑说明或选择其他证据后可以提交新的反馈。'), false);
  await close(tree);
});

test('onboarding rejects an unsuccessful completion without navigating away', async () => {
  const guide = { version: 1, pet_id: pet.id, collar_choice: null, next_step: 'collar', binding: null }, nav = navigation();
  const { OnboardingScreen } = screenModule('src/screens/OnboardingScreen.tsx', { api: { baseUrl: 'test', get: async () => guide, patch: async () => { throw new Error('版本冲突，请重读'); } },
    user: { id: 'u' }, household, households: [household], pet, pets: [pet], refreshIdentity: async () => {}, selectPet() {} });
  const tree = await render(OnboardingScreen, { navigation: nav }); await press(tree, '跳过项圈并完成引导');
  assert.equal(nav.calls.length, 0); assert.ok(tree.root.findAllByType('Text').some(node => node.props.children === '版本冲突，请重读')); await close(tree);
});

test('a viewer can read wellness but cannot import or save a plan draft', async () => {
  const setup = wellness(), { WellnessScreen } = screenModule('src/screens/CareScreens.tsx', { ...setup.state, household: { ...household, role: 'viewer' } });
  const tree = await render(WellnessScreen, { navigation: navigation(), route: { params: { section: 'goals', plan: { id: 'plan', title: '仅可读', content_version: 1, walk_minutes: 10, play_minutes: 0, training_minutes: 0 } } } });
  assert.equal(tree.root.findAllByProps({ accessibilityLabel: '保存目标与计划' }).length, 0);
  assert.equal(tree.root.findAllByProps({ accessibilityLabel: '计划名称' }).length, 0); assert.equal(setup.calls.some(row => row[0] === 'put'), false); await close(tree);
});

async function keyboardPage() {
  const renderer = require('react-test-renderer'), calls = [], listeners = {}, removals = [], pending = [];
  const measurements = { viewport: { y: 72, height: 700 }, first: { y: 650, height: 48 }, second: { y: 700, height: 48 } };
  let delayed = false;
  const native = Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'KeyboardAvoidingView', 'ActivityIndicator', 'RefreshControl'].map(name => [name, name]));
  Object.assign(native, { Platform: { OS: 'android' }, StyleSheet: { create: value => value, hairlineWidth: 1 }, Keyboard: {
    addListener(event, listener) { listeners[event] = listener; return { remove: () => { removals.push(event); delete listeners[event]; } }; },
  } });
  const { Page, Field } = screenModule('src/ui/index.tsx', {}, { 'react-native': native });
  const measure = name => callback => { const value = { ...measurements[name] }, finish = () => callback(0, value.y, 400, value.height); if (delayed) pending.push(finish); else finish(); };
  const createNodeMock = element => {
    if (element.type === 'ScrollView') return { measureInWindow: measure('viewport'), scrollTo: value => calls.push(value), scrollResponderScrollNativeHandleToKeyboard() {} };
    if (element.type === 'View') return { measureInWindow: callback => callback(0, 72, 400, 700) };
    if (element.type === 'TextInput') return { measureInWindow: measure(element.props.accessibilityLabel) };
    return {};
  };
  let tree; await act(async () => { tree = renderer.create(React.createElement(Page, null, ...['first', 'second'].map(label => React.createElement(Field, { key: label, label, value: '', onChangeText() {} }))), { createNodeMock }); });
  const flush = () => change(() => new Promise(resolve => setTimeout(resolve, 85)));
  return { tree, calls, listeners, removals, pending, measurements, flush, set delayed(value) { delayed = value; },
    focus: name => change(() => field(tree, name).props.onFocus({})), blur: name => change(() => field(tree, name).props.onBlur({})),
    scroll: y => change(() => tree.root.findByType('ScrollView').props.onScroll?.({ nativeEvent: { contentOffset: { y } } })),
    layout: () => change(() => tree.root.findByType('ScrollView').props.onLayout()),
    show: y => change(() => listeners.keyboardDidShow({ endCoordinates: { screenY: y, height: 300 } })) };
}

test('Android Page computes actual overlap in window coordinates, including header and existing scroll offset', async () => {
  const f = await keyboardPage();
  assert.equal(f.tree.root.findByType('KeyboardAvoidingView').props.behavior, 'height');
  await change(() => f.tree.root.findAllByType('View').find(node => node.props.onLayout).props.onLayout());
  assert.equal(f.tree.root.findByType('KeyboardAvoidingView').props.keyboardVerticalOffset, 72);
  await f.scroll(200); await f.focus('first'); await f.show(500); await f.flush();
  assert.deepEqual(f.calls, [{ y: 422, animated: true }]); // 200 + (650 + 48 - (500 - 24))
  await close(f.tree);
});

test('Page remeasures a shrinking viewport and uses the latest keyboard top without pulling visible inputs backwards', async () => {
  const f = await keyboardPage(); f.measurements.first.y = 400;
  await f.scroll(100); await f.focus('first'); await f.show(600); await f.flush(); assert.deepEqual(f.calls, []);
  f.measurements.viewport.height = 340; await f.layout(); await f.flush(); assert.deepEqual(f.calls.at(-1), { y: 160, animated: true });
  f.calls.length = 0; f.measurements.viewport.height = 700; await f.show(420); await f.flush(); assert.deepEqual(f.calls.at(-1), { y: 152, animated: true });
  f.calls.length = 0; f.measurements.first.y = 250; await f.layout(); await f.flush(); assert.deepEqual(f.calls, []);
  await close(f.tree);
});

test('native scrolling during the keyboard resize does not cancel the scheduled measurement and uses the new offset', async () => {
  const f = await keyboardPage(); await f.focus('first'); await f.show(500); await f.scroll(120); await f.flush();
  assert.deepEqual(f.calls, [{ y: 342, animated: true }]); await close(f.tree);
});

test('Page leaves manual browsing alone when the keyboard is closed, including layout and content changes', async () => {
  const f = await keyboardPage(); f.measurements.first.y = 900;
  try {
    await f.focus('first'); await f.layout(); await f.flush(); assert.deepEqual(f.calls, []);
    await f.show(500); await f.flush(); assert.ok(f.calls.length > 0); f.calls.length = 0;
    await change(() => f.listeners.keyboardDidHide());
    f.measurements.viewport.height = 400; await f.scroll(180); await f.layout(); await f.flush();
    assert.deepEqual(f.calls, []);
    await change(() => f.tree.root.findByType('ScrollView').props.onContentSizeChange(400, 1800)); await f.flush();
    assert.deepEqual(f.calls, []);
  } finally { await close(f.tree); }
});

test('Page discards an input measurement crossing keyboard hide and does not restart it on later content changes', async () => {
  const f = await keyboardPage(); f.delayed = true;
  try {
    await f.focus('first'); await f.show(500); await f.flush();
    await change(() => f.pending.shift()()); assert.equal(f.pending.length, 1);
    await change(() => f.listeners.keyboardDidHide()); await change(() => f.pending.shift()());
    assert.deepEqual(f.calls, []);
    await change(() => f.tree.root.findByType('ScrollView').props.onContentSizeChange(400, 2000)); await f.flush();
    assert.equal(f.pending.length, 0);
  } finally { await close(f.tree); }
});

test('Page discards late measurements after focus changes, blur, scrolling and unmount', async () => {
  const f = await keyboardPage(); f.delayed = true;
  await f.focus('first'); await f.show(500); await f.flush(); assert.equal(f.pending.length, 1);
  await change(() => f.pending.shift()()); assert.equal(f.pending.length, 1); // input measurement now pending
  await f.focus('second'); await change(() => f.pending.shift()()); assert.deepEqual(f.calls, []);
  await f.flush(); await change(() => f.pending.shift()()); await f.scroll(50); await change(() => f.pending.shift()()); assert.deepEqual(f.calls, []);
  await f.layout(); await f.flush(); await f.blur('second'); await change(() => f.pending.shift()()); assert.deepEqual(f.calls, []);
  await f.focus('first'); await f.flush(); await change(() => f.listeners.keyboardDidHide()); await change(() => f.pending.shift()()); assert.deepEqual(f.calls, []);
  await f.focus('first'); await f.show(500); await f.flush(); await close(f.tree); await change(() => { while (f.pending.length) f.pending.shift()(); });
  assert.deepEqual(f.calls, []); assert.ok(f.removals.includes('keyboardDidShow')); assert.ok(f.removals.includes('keyboardDidHide'));
});

test('a stale blur from the previous Field does not clear the newly focused Field', async () => {
  const f = await keyboardPage(); await f.focus('first'); await f.focus('second'); await f.blur('first'); await f.show(500); await f.flush();
  assert.deepEqual(f.calls, [{ y: 272, animated: true }]); await close(f.tree);
});
