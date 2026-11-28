const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

const firstPet = { id: 'pet-a', household_id: 'family', name: '豆豆', species: 'dog' };
const secondPet = { id: 'pet-b', household_id: 'family', name: '米粒', species: 'cat' };
const clone = value => structuredClone(value);
const text = tree => tree.root.findAllByType('Text').map(node => node.props.children).flat(Infinity).filter(value => typeof value === 'string' || typeof value === 'number').join(' ');
const button = (tree, title) => tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === title);
async function press(tree, title) {
  const target = button(tree, title); assert.ok(target, `Missing button ${title}`); assert.ok(!target.props.disabled, `Disabled button ${title}`);
  await change(() => target.props.onPress());
}
function fixture(extra = {}) {
  const calls = [], routes = [], listeners = new Set();
  const f = { calls, routes, records: [], failHealth: false, failOverview: false, failDaily: false, delayedFirst: null, reads: 0,
    activity: { local_date: '2026-11-28', timezone: 'Asia/Shanghai', steps: null, active_minutes: null, sleep_minutes: null, data_status: 'missing', coverage_seconds: 0, sources: [] } };
  const api = { baseUrl: 'https://qa.invalid/api/v1', async get(path) {
    calls.push(path);
    if (path === '/health') { if (f.failHealth) throw new Error('服务状态暂时不可读'); return { mode: 'offline' }; }
    const pet = path.includes('/pet-b/') ? secondPet : firstPet;
    if (path.endsWith('/overview')) {
      f.reads++;
      if (f.failOverview) throw new Error('无权读取或连接已中断');
      if (pet.id === firstPet.id && f.delayedFirst) return f.delayedFirst.promise;
      return clone({ pet, activity: f.activity, device: null, attention: { unacknowledged_open_event_count: 0, unread_notification_count: 0 }, care_records: f.records });
    }
    if (f.failDaily) throw new Error('今日输入暂时不可读');
    if (path.includes('/goals?')) return { goals: null };
    if (path.includes('/body-check-ins?')) return { version: 0, values: {} };
    if (path.includes('/nutrition/daily?')) return { record_count: 0, known_kcal: null, unknown_energy_count: 0 };
    throw new Error(`Unexpected GET ${path}`);
  } };
  f.state = { api, pet: firstPet, pets: [firstPet, secondPet], households: [{ id: 'family', role: 'owner' }], region: 'cn', onboarding: null,
    selectPet: id => { f.state = { ...f.state, pet: f.state.pets.find(pet => pet.id === id) }; }, refreshIdentity: async () => {}, ...extra };
  f.navigation = { navigate: (...args) => routes.push(args), addListener: (event, callback) => {
    assert.equal(event, 'focus'); listeners.add(callback); return () => listeners.delete(callback);
  } };
  f.focus = () => { for (const listener of listeners) listener(); };
  return f;
}
async function mount(t, f) {
  const { HomeScreen } = screenModule('src/screens/HomeScreen.tsx', () => f.state);
  const props = { navigation: f.navigation, route: { params: {} } }, tree = await render(HomeScreen, props);
  t.after(() => change(() => tree.unmount()));
  return { tree, update: () => change(() => tree.update(React.createElement(HomeScreen, props))) };
}

test('Today opens the current pet profile and existing feeding, weight and care pages', async t => {
  const f = fixture(), { tree } = await mount(t, f);
  assert.match(text(tree), /豆豆/); assert.doesNotMatch(text(tree), /Baku|80\s*\/\s*100/);
  await press(tree, '打开宠物档案'); assert.deepEqual(f.routes.at(-1), ['Pet', { from: 'today' }]);
  await press(tree, '记录今天的照护'); assert.deepEqual(f.routes.at(-1), ['Care', { from: 'today' }]);
  await press(tree, '记录一餐'); assert.deepEqual(f.routes.at(-1), ['Care', { createType: 'feeding', from: 'today' }]);
  await press(tree, '记录体重'); assert.deepEqual(f.routes.at(-1), ['Care', { createType: 'weight', from: 'today' }]);
  const care = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel?.startsWith('记录餐食或体重，'));
  await change(() => care.props.onPress()); assert.deepEqual(f.routes.at(-1), ['Care', { from: 'today' }]);
});

test('Today keeps missing readings unknown, preserves a real zero and offers care without a collar', async t => {
  const f = fixture(); Object.assign(f.activity, { active_minutes: 0, data_status: 'partial', coverage_seconds: 3600, sources: ['device'] });
  const { tree } = await mount(t, f);
  const content = text(tree);
  assert.match(content, /未知 上报步数 0 活动分钟 未知 睡眠分钟/);
  assert.match(content, /活动数据部分覆盖/); assert.match(content, /设备上报/); assert.match(content, /Asia\/Shanghai/); assert.match(content, /尚未绑定项圈/);
  assert.match(content, /不生成日常评分/); assert.ok(button(tree, '记录一餐'));
  assert.doesNotMatch(content, /今天很健康|当前很安全|Baku/);
});

test('returning from saved handwritten care rereads Today and shows note, custom and toileting original text', async t => {
  const f = fixture(), { tree } = await mount(t, f), before = f.reads;
  await press(tree, '记录今天的照护');
  for (const type of ['note', 'custom', 'toileting']) {
    const original = `服务端保存的${type}原文`;
    f.records = [{ id: `care-${type}`, type, recorded_at: '2026-11-28T01:00:00.000Z', source: 'owner', notes: '',
      value: { text: original, ...(type === 'toileting' ? { kind: 'defecation' } : {}) }, ...(type === 'custom' ? { custom_type: '散步手记' } : {}) }];
    await change(f.focus);
    assert.ok(f.reads > before); assert.ok(text(tree).includes(original));
  }
  await press(tree, '查看记录与修订历史'); assert.deepEqual(f.routes.at(-1), ['Care', { from: 'today' }]);
});

test('a late pet A overview cannot replace pet B after the pet selector changes', async t => {
  const f = fixture(); f.delayedFirst = deferred(); const { tree, update } = await mount(t, f);
  const choice = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'radio' && node.findAllByType('Text').some(text => text.props.children === secondPet.name));
  await change(() => choice.props.onPress()); await update();
  await change(() => f.delayedFirst.resolve({ pet: firstPet, activity: { steps: 98765 }, care_records: [{ id: 'old', notes: 'A的旧记录' }] }));
  assert.match(text(tree), /米粒，今天怎么样/); assert.doesNotMatch(text(tree), /98765|98,765|A的旧记录/);
  assert.ok(f.calls.includes('/pets/pet-b/overview'));
});

test('read-only Today preserves review routes and hides direct feeding and weight entry', async t => {
  const f = fixture({ households: [{ id: 'family', role: 'viewer' }] }), { tree } = await mount(t, f);
  assert.match(text(tree), /只读身份/); assert.equal(button(tree, '记录一餐'), undefined); assert.equal(button(tree, '记录体重'), undefined);
  assert.equal(button(tree, '记录今天的照护'), undefined); await press(tree, '查看今天的照护'); assert.deepEqual(f.routes.at(-1), ['Care', { from: 'today' }]);
  const care = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel?.startsWith('查看餐食与体重记录，'));
  await change(() => care.props.onPress()); assert.deepEqual(f.routes.at(-1), ['Care', { from: 'today' }]);
});

test('Today retries a failed overview without replacing unread safety counts with zero', async t => {
  const f = fixture(); f.failOverview = true; const { tree } = await mount(t, f);
  assert.match(text(tree), /无权读取或连接已中断/); assert.match(text(tree), /安全计数尚未读取，不按0处理/);
  f.failOverview = false; await press(tree, '刷新今日摘要');
  assert.doesNotMatch(text(tree), /无权读取或连接已中断/); assert.match(text(tree), /尚无活动上报/);
});

test('service status has an explicit retry after a failed read', async t => {
  const f = fixture(); f.failHealth = true; const { tree } = await mount(t, f);
  assert.match(text(tree), /服务状态暂时不可读/);
  f.failHealth = false; await press(tree, '重试读取服务状态');
  assert.doesNotMatch(text(tree), /服务状态暂时不可读/); assert.match(text(tree), /App仍需连接服务器/);
});

test('a failed daily care read retries without writing or inventing nutrition data', async t => {
  const f = fixture(); f.failDaily = true; const { tree } = await mount(t, f);
  assert.match(text(tree), /今日输入暂时不可读/); assert.doesNotMatch(text(tree), /今天尚未记录餐食/);
  f.failDaily = false; await press(tree, '重试读取今日照护');
  assert.doesNotMatch(text(tree), /今日输入暂时不可读/); assert.match(text(tree), /今天尚未记录餐食/);
});

test('Today without pets offers the existing pet, onboarding and family routes', async t => {
  const f = fixture({ pet: null, pets: [] }), { tree } = await mount(t, f);
  assert.equal(f.calls.some(path => path.includes('/overview')), false);
  await press(tree, '添加第一位伙伴'); assert.deepEqual(f.routes.at(-1), ['Pet', { from: 'today' }]);
  await press(tree, '按步骤完成设置'); assert.deepEqual(f.routes.at(-1), ['Onboarding']);
  const family = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel?.startsWith('接受家人的邀请，'));
  await change(() => family.props.onPress()); assert.deepEqual(f.routes.at(-1), ['Household']);
});
