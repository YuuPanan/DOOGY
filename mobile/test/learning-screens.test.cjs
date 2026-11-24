const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');
const screens = state => screenModule('src/screens/LearningScreens.tsx', state, { '../ui/MediaCapture': { MediaCapture: () => React.createElement('MediaCapture') } });

const household = { id: 'family-a', role: 'owner', timezone: 'UTC' };
const pet = { id: 'pet-a', name: 'Pet A', household_id: household.id, effective_timezone: 'UTC' };
const day = { pet_id: pet.id, timezone: 'UTC', local_date: '2026-11-24', period_start: '2026-11-24T00:00:00.000Z', period_end: '2026-11-25T00:00:00.000Z' };
function app(api, extra = {}) {
  return { api: { baseUrl: 'http://qa.invalid/api/v1', origin: 'http://qa.invalid', get: async path => path.includes('/activity/daily?') ? day : { items: [] }, ...api }, user: { id: 'user-a' }, pet, pets: [pet], household, households: [household], ...extra };
}
function buttons(tree, title) { return tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === title); }
async function press(tree, title, index = 0) { const target = buttons(tree, title)[index]; assert.ok(target, `Missing button ${title}`); assert.ok(!target.props.disabled, `Disabled ${title}`); await change(() => target.props.onPress()); }
async function field(tree, label, value) { await change(() => tree.root.findByProps({ accessibilityLabel: label }).props.onChangeText(value)); }
const value = (tree, label) => tree.root.findByProps({ accessibilityLabel: label }).props.value;
async function choose(tree, label) { const target = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'radio' && node.findAllByType('Text').some(text => text.props.children === label)); assert.ok(target, `Missing ${label}`); await change(() => target.props.onPress()); }
async function close(tree) { await change(() => tree.unmount()); }
async function until(check) { for (let count = 0; count < 100; count++) { if (check()) return; await change(() => new Promise(done => setTimeout(done, 10))); } assert.ok(check(), 'Expected screen result did not arrive'); }
const lesson = id => ({ id, title: `Lesson ${id}`, kind: 'lesson', content_version: 1, current_version: 1, body: `Body ${id}`, lesson: { steps: [{ id: 'step', title: 'Observe', body: 'Synthetic lesson step' }] }, progress: { version: 0, completed_step_ids: [], learned: false } });

test('late lesson A save cannot overwrite lesson B steps', async () => {
  const pending = deferred(); let running;
  const state = app({ get: async path => path.startsWith('/lessons?') ? { items: [lesson('a'), lesson('b')] } : path.startsWith('/content/') ? lesson(path.split('/')[2].split('?')[0]) : { items: [] }, put: async () => pending.promise });
  const { LearningScreen } = screens(state), tree = await render(LearningScreen, { navigation: {}, route: {} });
  try {
    await press(tree, '阅读正文与来源', 0);
    await change(() => tree.root.findAllByType('Switch')[0].props.onValueChange(true));
    await change(() => { running = buttons(tree, '保存本人学习进度')[0].props.onPress(); });
    await press(tree, '阅读正文与来源', 1);
    await change(() => tree.root.findAllByType('Switch')[1].props.onValueChange(true));
    await change(async () => { pending.resolve({ version: 1 }); await running; });
    assert.equal(tree.root.findAllByType('Switch')[0].props.value, false);
    assert.equal(tree.root.findAllByType('Switch')[1].props.value, true);
    assert.ok(JSON.stringify(tree.toJSON()).includes('Body b'));
  } finally { await close(tree); }
});

test('historical lesson progress is read-only until the current published version is selected', async () => {
  const old = { ...lesson('a'), current_version: 2, progress: { version: 3, completed_step_ids: ['step'], learned: true } }, latest = { ...lesson('a'), content_version: 2, current_version: 2 };
  const state = app({ get: async path => path.startsWith('/learning-progress?') ? { items: [{ content_id: 'a', content_version: 1, title: 'Saved old lesson' }] } : path === '/content/a?version=1' ? old : path === '/content/a?' ? latest : { items: [] } });
  const { LearningScreen } = screens(state), tree = await render(LearningScreen, { navigation: {}, route: {} });
  try {
    await press(tree, '读取这条记录的内容版本');
    assert.ok(tree.root.findAllByType('Switch').every(node => node.props.disabled));
    assert.ok(buttons(tree, '保存本人学习进度')[0].props.disabled);
    assert.ok(JSON.stringify(tree.toJSON()).includes('正在查看历史版本'));
    await press(tree, '查看最新课程版本');
    assert.ok(tree.root.findAllByType('Switch').every(node => !node.props.disabled && !node.props.value));
    assert.ok(!buttons(tree, '保存本人学习进度')[0].props.disabled);
  } finally { await close(tree); }
});

test('Learning preserves search and returns a selected structured plan to an existing Wellness draft or navigates when absent', async () => {
  const calls = [], destinations = [], popped = [], plan = { id: 'plan-a', title: 'Synthetic plan', kind: 'plan', content_version: 2, current_version: 2, body: 'Explicit test plan', exercise_plan: { walk_minutes: 15, play_minutes: 5, training_minutes: 3 } };
  let current = app({ get: async path => { calls.push(path); return path.startsWith('/content/plan-a?') ? plan : path.startsWith('/content?') ? { items: [plan] } : { items: [] }; } });
  const { LearningScreen } = screens(() => current), props = { navigation: { navigate: (...args) => destinations.push(args) }, route: { params: { kind: 'tip', category: 'behavior' } } }, tree = await render(LearningScreen, props);
  try {
    assert.ok(calls.includes('/content?kind=tip&category=behavior&limit=15'));
    await field(tree, '标题搜索（可空）', 'unsaved search');
    current = { ...current, pet: { ...pet, id: 'pet-b' } };
    await change(() => tree.update(React.createElement(LearningScreen, props)));
    assert.equal(value(tree, '标题搜索（可空）'), 'unsaved search');
    const next = { ...props, route: { params: { kind: 'plan', category: 'exercise' } } };
    await change(() => tree.update(React.createElement(LearningScreen, next)));
    assert.ok(calls.includes('/content?kind=plan&category=exercise&limit=15'));
    assert.equal(value(tree, '标题搜索（可空）'), 'unsaved search');
    await press(tree, '阅读正文与来源'); await press(tree, '选用此运动计划');
    assert.deepEqual(destinations, [['Wellness', { section: 'goals', plan: { id: 'plan-a', title: plan.title, content_version: 2, ...plan.exercise_plan } }]]);
    await change(() => tree.update(React.createElement(LearningScreen, { ...next, navigation: { ...next.navigation, getState: () => ({ routes: [{ name: 'Main' }, { name: 'Wellness' }, { name: 'Learning' }] }), popTo: (...args) => popped.push(args) } })));
    await press(tree, '选用此运动计划');
    assert.deepEqual(popped, destinations); assert.equal(destinations.length, 1);
  } finally { await close(tree); }
});

test('late question response cannot select an old message or erase a new draft after conversation A to B to A', async () => {
  const pending = deferred(), posts = []; let running;
  const state = app({ get: async path => path.includes('/assistant-conversations?') ? { items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] } : { items: [] }, post: async (path, body) => { posts.push({ path, body }); return pending.promise; } });
  const { AssistantScreen } = screens(state), tree = await render(AssistantScreen, { navigation: {}, route: {} });
  try {
    await press(tree, '选择此会话', 0); await field(tree, '问题（1–4000字）', 'Original A question');
    await change(() => { running = buttons(tree, '创建问答任务')[0].props.onPress(); });
    await press(tree, '选择此会话', 1); await field(tree, '问题（1–4000字）', 'B draft');
    await press(tree, '选择此会话', 0); await field(tree, '问题（1–4000字）', 'New A draft');
    await change(async () => { pending.resolve({ id: 'old-message', pet_id: pet.id, conversation_id: 'a' }); await running; });
    assert.equal(value(tree, '问题（1–4000字）'), 'New A draft');
    assert.equal(value(tree, '重读本人已有任务ID（高级，当前会话）'), '');
    assert.equal(posts.length, 1); assert.equal(posts[0].path, '/assistant-conversations/a/messages');
  } finally { await close(tree); }
});

test('actual behavior list supplies a text-only question source, and changed context preserves the question draft', async () => {
  const pending = deferred(), posts = []; let running;
  const record = { id: 'record-a', pet_id: pet.id, labels: ['pacing'], media_id: null, start_at: day.period_start, end_at: day.period_start };
  const state = app({ get: async path => path.includes('/activity/weekly?') ? { pet_id: pet.id, timezone: 'UTC', days: Array(7).fill(day) } : path.includes('/assistant-conversations?') ? { items: [{ id: 'a', title: 'A' }] } : path.includes('/behavior-records?') ? { items: [record] } : { items: [] }, post: async (path, body) => { posts.push({ path, body }); return pending.promise; } });
  const { AssistantScreen } = screens(state), tree = await render(AssistantScreen, { navigation: {}, route: {} });
  try {
    await press(tree, '选择此会话'); await choose(tree, '行为'); await press(tree, '选择这条行为来源');
    assert.equal(tree.root.findAllByProps({ accessibilityLabel: '所选来源ID（本宠物；人工原文可无媒体）' }).length, 0);
    await field(tree, '问题（1–4000字）', 'Explain only my original observation');
    await change(() => { running = buttons(tree, '创建问答任务')[0].props.onPress(); });
    await field(tree, '补充背景（最多2000字）', 'New unsent background');
    await change(async () => { pending.resolve({ id: 'saved', pet_id: pet.id, conversation_id: 'a' }); await running; });
    assert.equal(posts[0].body.context.behavior_record_id, record.id);
    assert.equal(posts[0].body.context.kind, 'behavior'); assert.equal(posts[0].body.context.notes, '');
    assert.equal(value(tree, '问题（1–4000字）'), 'Explain only my original observation');
    assert.equal(value(tree, '补充背景（最多2000字）'), 'New unsent background');
  } finally { await close(tree); }
});

test('late task A feedback cannot clear B draft, and saved B feedback is reread from its task', async () => {
  const pending = deferred(), stored = { a: [], b: [] }; let running;
  const task = id => ({ id, pet_id: pet.id, media_id: 'media-a', status: 'succeeded', attempt: 1 });
  const state = app({ get: async path => path.includes('/activity/daily?') ? day : path.includes('/interpretations?') ? { items: [task('a'), task('b')] } : path.includes('/feedback?') ? { items: stored[path.split('/')[2]] } : path.startsWith('/interpretations/') ? task(path.split('/')[2]) : { items: [] }, post: async (path, body) => { const id = path.split('/')[2]; if (id === 'a') return pending.promise; const saved = { id: 'feedback-b', ...body, created_at: day.period_start }; stored.b.push(saved); return saved; } });
  const destinations = [], { BehaviorScreen } = screens(state), tree = await render(BehaviorScreen, { navigation: { navigate: (...args) => destinations.push(args) }, route: {} });
  try {
    await choose(tree, '解释任务'); await press(tree, '读取任务正文与证据', 0);
    await field(tree, '对本次解释的反馈（必填）', 'A pending feedback');
    await change(() => { running = buttons(tree, '提交当前尝试的解释反馈')[0].props.onPress(); });
    await press(tree, '读取任务正文与证据', 1); await field(tree, '对本次解释的反馈（必填）', 'B retained draft');
    await change(async () => { pending.resolve({ id: 'feedback-a', comment: 'A private late text' }); await running; });
    assert.equal(value(tree, '对本次解释的反馈（必填）'), 'B retained draft');
    assert.ok(!JSON.stringify(tree.toJSON()).includes('A private late text'));
    await press(tree, '提交当前尝试的解释反馈');
    await press(tree, '读取任务正文与证据', 0); await press(tree, '读取任务正文与证据', 1);
    assert.ok(JSON.stringify(tree.toJSON()).includes('B retained draft'));
    assert.equal(value(tree, '对本次解释的反馈（必填）'), '');
    assert.equal(stored.b.length, 1);
    await press(tree, '查看相关提示'); assert.deepEqual(destinations, [['Learning', { kind: 'tip', category: 'behavior' }]]);
  } finally { await close(tree); }
});

test('Behavior uses real server local-day bounds so a newly created interpretation remains discoverable after the screen opened', { timeout: 30000 }, async () => {
  const backend = process.env.DOOGY_TEST_BACKEND_DIR || resolve(__dirname, '../../dist');
  const { Db } = require(resolve(backend, 'src/db.js')), { createApp } = require(resolve(backend, 'src/app.js'));
  const { ApiClient } = require('../.test-dist/client.js');
  process.chdir(resolve(__dirname, '../..')); process.env.DATA_MODE = 'offline'; process.env.DB_DRIVER = 'sqlite'; process.env.MANAGED_BACKUP_ENABLED = 'false';
  let clock = Date.now(), server, tree, calls = [], external = 0; const db = new Db(':memory:', () => new Date(clock)), originalFetch = globalThis.fetch;
  try {
    server = await createApp({ db, quiet: true }); await server.listen(0, '127.0.0.1'); const origin = await server.getUrl();
    globalThis.fetch = async (input, init) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url); if (url.origin !== origin) { external++; throw new Error('External calls forbidden'); } calls.push(url); return originalFetch(input, init); };
    let tokens = null; const api = new ApiClient(origin, { read: async () => tokens, write: async value => { tokens = value; } });
    const registered = await api.post('/auth/register', { email: 'learning-component@example.invalid', password: 'Synthetic-learning-2026', timezone: 'UTC' }); await api.setSession(registered);
    const livePet = await api.post('/pets', { household_id: registered.household.id, name: 'Synthetic renderer pet' });
    const bytes = Buffer.from('test metadata only; no codec or hardware assertion'), mediaId = db.id();
    await db.run('INSERT INTO pet_media(id,pet_id,filename,content_type,size_bytes,sha256,content_base64,duration_seconds,captured_at,source,created_by,created_at,validation_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', mediaId, livePet.id, 'fixture.wav', 'audio/wav', bytes.length, createHash('sha256').update(bytes).digest('hex'), bytes.toString('base64'), 1, new Date(clock - 60000).toISOString(), 'synthetic', registered.user.id, db.now(), '{}');
    const state = app(api, { api, user: registered.user, pet: { ...livePet, effective_timezone: 'UTC' }, household: registered.household, households: [{ ...registered.household, role: 'owner' }] });
    const { BehaviorScreen } = screens(state);
    tree = await render(BehaviorScreen, { navigation: {}, route: {} });
    await until(() => calls.some(url => url.pathname.endsWith('/interpretations')));
    await choose(tree, '解释任务'); clock += 60000;
    await field(tree, '本宠物已有媒体ID', mediaId); await press(tree, '创建解释任务');
    await until(() => buttons(tree, '读取任务正文与证据').length === 1);
    const history = calls.filter(url => url.pathname.endsWith('/interpretations') && url.searchParams.has('from')).at(-1);
    const page = await api.get(`/pets/${livePet.id}/interpretations?from=${encodeURIComponent(new Date(clock - 120000).toISOString())}&to=${encodeURIComponent(new Date(clock + 120000).toISOString())}`);
    assert.equal(page.items.length, 1); assert.ok(Date.parse(page.items[0].created_at) > Date.now());
    assert.ok(Date.parse(history.searchParams.get('to')) > clock); assert.equal(external, 0);
  } finally { if (tree) await close(tree); globalThis.fetch = originalFetch; if (server) await server.close(); await db.close(); }
});
