const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

const pet = { id: 'pet-a', household_id: 'home-a', name: '小豆', effective_timezone: 'UTC' };
const household = { id: 'home-a', role: 'owner' };
const content = { id: 'lesson-a', title: 'A real published lesson', kind: 'lesson', category: 'behavior', content_version: 3, current_version: 3,
  summary: 'Published summary', body: 'Read the actual content, not a prototype answer.', applicability: 'General education', sources: [{ title: 'Reviewed source', reference: 'Local reviewed package' }],
  review: { status: 'reviewed', reviewer: 'Synthetic reviewer', reviewed_at: '2026-11-28T00:00:00Z' },
  lesson: { steps: [{ id: 'notice', title: 'Notice the whole scene', body: 'A source-backed step.' }] }, progress: { version: 2, learned: false, completed_step_ids: [] } };
const nav = () => { const calls = [], listeners = new Map(); return { calls, listeners, push: (...args) => calls.push(args), navigate: (...args) => calls.push(args), addListener: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event); } }; };
function fixture(overrides = {}) {
  const calls = []; let current = structuredClone(content), goals = { pet_id: pet.id, local_date: '2026-11-28', timezone: 'UTC', effective_date_version: 4,
    goals: { version: 4, targets: { active_minutes: null, steps: 5000, intake_kcal: null }, plan: null } };
  const api = { baseUrl: 'http://test.invalid/api/v1', origin: 'http://test.invalid',
    async get(path) {
      calls.push(['get', path]); if (overrides.get) { const result = await overrides.get(path); if (result !== undefined) return result; }
      const url = new URL(path, api.origin);
      if (url.pathname.endsWith('/activity/weekly')) return { pet_id: pet.id, timezone: 'UTC', days: Array.from({ length: 7 }, (_, i) => ({ period_start: new Date(Date.UTC(2026, 10, 21 + i)).toISOString(), period_end: new Date(Date.UTC(2026, 10, 22 + i)).toISOString() })) };
      if (url.pathname.endsWith('/activity/daily')) return { pet_id: pet.id, local_date: '2026-11-28', timezone: 'UTC', active_minutes: null, sources: [], data_status: 'missing' };
      if (url.pathname.endsWith('/goals')) return structuredClone(goals);
      if (url.pathname === '/content/lesson-a') return structuredClone(current);
      if (url.pathname === '/content') return { items: url.searchParams.get('kind') === 'plan' ? [{ id: 'plan-a', title: 'Published movement plan', content_version: 2, exercise_plan: { walk_minutes: 20, play_minutes: 10, training_minutes: 5 } }] : [structuredClone(content)] };
      if (url.pathname === '/learning-progress') return { items: [], counts: { scope: 'all_current_published_lessons', learned_count: 0, available_count: 1 } };
      return { items: [] };
    },
    async put(path, body) {
      calls.push(['put', path, structuredClone(body)]); if (overrides.put) return overrides.put(path, body);
      if (path.endsWith('/goals')) { goals = { ...goals, effective_date_version: 5, goals: { ...body, version: 5 } }; return goals.goals; }
      current = { ...current, progress: { ...body, version: 3 } }; return current.progress;
    },
    async post(path, body) { calls.push(['post', path, structuredClone(body)]); return overrides.post ? overrides.post(path, body) : { id: 'saved-record', pet_id: pet.id }; },
  };
  const state = { api, user: { id: 'owner' }, authenticated: true, pet, pets: [pet], household: { ...household, role: overrides.role ?? 'owner' }, households: [{ ...household, role: overrides.role ?? 'owner' }] };
  const mocks = { './assets': { Asset: props => React.createElement('StaticAsset', props) }, '../ui/MediaCapture': { MediaCapture: props => React.createElement('MediaCapture', props) } };
  return { calls, api, state, load: file => screenModule(file, state, mocks), get current() { return current; } };
}
const buttons = (tree, title) => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === title);
async function press(tree, title) { const button = buttons(tree, title)[0]; assert.ok(button, title); assert.ok(!button.props.disabled, title); await change(() => button.props.onPress()); }
const field = (tree, label) => tree.root.findByProps({ accessibilityLabel: label });
const edit = (tree, label, value) => change(() => field(tree, label).props.onChangeText(value));
const text = tree => JSON.stringify(tree.toJSON());
const close = tree => change(() => tree.unmount());

test('Pawch behavior overview routes to its distinct native pages without fabricated records', async () => {
  const f = fixture(), navigation = nav(), { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx');
  const tree = await render(PawchBehaviorScreen, { screenId: '42', navigation });
  try {
    const title = tree.root.findAllByType('Text').find(node => node.props.children === 'Understand their world.');
    const titleStyle = Object.assign({}, ...title.props.style.flat(Infinity).filter(Boolean)); assert.equal(titleStyle.fontSize, 26); assert.equal(titleStyle.lineHeight, 32);
    for (const name of ['Today’s behavior', 'Record or import a moment', 'Behavior history', 'Helpful tips', 'Daily movement']) await press(tree, name);
    assert.deepEqual(navigation.calls.map(call => call[1].screenId), ['43', '44', '46', '47', '40']);
    assert.ok(text(tree).includes('A bark is only one clue.')); assert.equal(f.calls.filter(([method]) => method !== 'get').length, 0);
  } finally { await close(tree); }
});

test('Pawch movement keeps unknown activity distinct from zero and selecting a plan only fills a draft', async () => {
  const f = fixture(), navigation = nav(), { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx');
  const tree = await render(PawchBehaviorScreen, { screenId: '40', navigation });
  try { assert.ok(text(tree).includes('Unknown of unknown active minutes')); assert.ok(!text(tree).includes('0 of 0')); }
  finally { await close(tree); }
  const editor = await render(PawchBehaviorScreen, { screenId: '41', navigation });
  try {
    assert.equal(editor.root.findAllByProps({ accessibilityLabel: 'Sniff walk · minutes' }).length, 0);
    await press(editor, 'Published movement plan'); assert.ok(text(editor).includes('20 min · planned'));
    assert.equal(f.calls.filter(([method]) => method === 'put').length, 0);
    await press(editor, 'Customize plan'); assert.equal(field(editor, 'Sniff walk · minutes').props.value, '20');
    await press(editor, 'Save today’s plan'); const writes = f.calls.filter(([method]) => method === 'put');
    assert.equal(writes.length, 1); assert.equal(writes[0][2].expected_version, 4); assert.equal(writes[0][2].plan.content_version, 'plan-a@2');
    assert.equal(writes[0][2].targets.active_minutes, null); assert.equal(writes[0][2].plan.walk_minutes, 20);
    assert.ok(f.calls.slice(f.calls.indexOf(writes[0]) + 1).some(([method, path]) => method === 'get' && path.includes('/goals')));
  } finally { await close(editor); }
});

test('Pawch goal acknowledgement retries only a failed read, and viewer cannot save a plan', async () => {
  let written = false, failRead = true;
  const f = fixture({ get: path => { if (written && failRead && path.includes('/goals')) throw new Error('Saved plan read unavailable'); }, put: async () => { written = true; return { version: 5 }; } });
  const { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, { screenId: '41', navigation: nav() });
  try {
    await press(tree, 'Save today’s plan'); assert.ok(text(tree).includes('计划已保存')); assert.ok(text(tree).includes('Saved plan read unavailable'));
    failRead = false; await press(tree, 'Read saved plan again'); assert.equal(f.calls.filter(([method]) => method === 'put').length, 1);
  } finally { await close(tree); }
  const viewer = fixture({ role: 'viewer' }), module = viewer.load('src/pawch/BehaviorFlow.tsx'), readOnly = await render(module.PawchBehaviorScreen, { screenId: '41', navigation: nav() });
  try { assert.equal(buttons(readOnly, 'Save today’s plan')[0].props.disabled, true); assert.equal(buttons(readOnly, 'Customize plan')[0].props.disabled, true); assert.equal(readOnly.root.findAllByProps({ accessibilityLabel: 'Active minutes goal (optional)' }).length, 0); }
  finally { await close(readOnly); }
});

test('returning from a saved plan rereads the movement summary on focus', async () => {
  const f = fixture(), navigation = nav(), { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, { screenId: '40', navigation });
  try {
    assert.ok(text(tree).includes('Unknown of unknown active minutes'));
    await f.api.put('/pets/pet-a/goals', { targets: { active_minutes: 45, steps: 5000, intake_kcal: null }, plan: null });
    await change(() => navigation.listeners.get('focus')?.());
    assert.ok(text(tree).includes('Unknown of 45 active minutes'));
  } finally { await close(tree); }
});

test('plan customization cancels back to the selected draft, then explicitly saves edited values and rereads its summary', async () => {
  const f = fixture(), { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, { screenId: '41', navigation: nav() });
  try {
    await press(tree, 'Published movement plan'); await press(tree, 'Customize plan');
    await edit(tree, 'Active minutes goal (optional)', '30'); await edit(tree, 'Sniff walk · minutes', '99'); await press(tree, 'No plan');
    await press(tree, 'Cancel plan edits');
    assert.ok(text(tree).includes('Published movement plan')); assert.ok(text(tree).includes('20 min · planned')); assert.ok(text(tree).includes('Draft · save to confirm'));
    assert.equal(f.calls.filter(([m]) => m === 'put').length, 0); assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Active minutes goal (optional)' }).length, 0);
    await press(tree, 'Customize plan'); assert.equal(field(tree, 'Active minutes goal (optional)').props.value, ''); assert.equal(field(tree, 'Sniff walk · minutes').props.value, '20');
    await edit(tree, 'Active minutes goal (optional)', '45'); await edit(tree, 'Sniff walk · minutes', '25'); await press(tree, 'Save today’s plan');
    const writes = f.calls.filter(([m]) => m === 'put'); assert.equal(writes.length, 1); assert.equal(writes[0][2].expected_version, 4); assert.equal(writes[0][2].targets.active_minutes, 45); assert.equal(writes[0][2].plan.walk_minutes, 25);
    assert.ok(text(tree).includes('25 min · planned')); assert.ok(text(tree).includes('Saved plan')); assert.equal(tree.root.findAllByProps({ accessibilityLabel: 'Active minutes goal (optional)' }).length, 0);
  } finally { await close(tree); }
});

test('cancelling an untouched custom editor cannot restore stale values over a newer goal version read on focus', async () => {
  let revision = 4;
  const f = fixture({ get: path => path.includes('/goals') ? { pet_id: pet.id, local_date: '2026-11-28', timezone: 'UTC', effective_date_version: revision, goals: { targets: { active_minutes: revision === 4 ? 30 : 60, steps: null, intake_kcal: null }, plan: null } } : undefined });
  const navigation = nav(), { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, { screenId: '41', navigation });
  try {
    await press(tree, 'Customize plan'); assert.equal(field(tree, 'Active minutes goal (optional)').props.value, '30');
    revision = 5; await change(() => navigation.listeners.get('focus')?.()); assert.equal(field(tree, 'Active minutes goal (optional)').props.value, '60');
    await press(tree, 'Cancel plan edits'); await press(tree, 'Customize plan'); assert.equal(field(tree, 'Active minutes goal (optional)').props.value, '60');
    await press(tree, 'Save today’s plan'); const write = f.calls.find(([m]) => m === 'put'); assert.equal(write[2].expected_version, 5); assert.equal(write[2].targets.active_minutes, 60);
  } finally { await close(tree); }
});

test('all four video states are explicit local demos and perform no API recording or inference', async () => {
  const f = fixture(), { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx');
  for (const [screenId, action, next] of [['44b', 'Start video demo', '44c'], ['44c', 'Stop video demo', '44d'], ['44d', 'Read illustrative interpretation', '44e'], ['44e', 'Record another', '44']]) {
    const navigation = nav(), tree = await render(PawchBehaviorScreen, { screenId, navigation });
    try { assert.ok(text(tree).includes('仅本地原型演示')); await press(tree, action); assert.equal(navigation.calls[0][1].screenId, next); }
    finally { await close(tree); }
  }
  assert.deepEqual(f.calls, []);
});

test('the sample audio route uses exported illustration and no recording, upload or model API', async () => {
  const f = fixture(), { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx');
  for (const screenId of ['44a', '45']) {
    const navigation = nav(), tree = await render(PawchBehaviorScreen, { screenId, navigation, route: { params: { demo: true } } });
    try {
      assert.ok(text(tree).includes('仅本地原型演示'));
      await press(tree, screenId === '44a' ? 'Stop and explore the sample' : 'What could help?');
      assert.equal(navigation.calls[0][1].screenId, screenId === '44a' ? '45' : '47');
    } finally { await close(tree); }
  }
  assert.deepEqual(f.calls, []);
});

test('record selection reuses the original static waveform hero without starting a recorder or claiming a real clip', async () => {
  const f = fixture(), navigation = nav(), { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, { screenId: '44', navigation });
  try {
    assert.equal(tree.root.findAllByType('StaticAsset').filter(node => node.props.name === 'record-bark-waveform').length, 1);
    assert.ok(text(tree).includes('STATIC SAMPLE · Not your recording')); assert.equal(tree.root.findAllByType('MediaCapture').length, 0);
    await press(tree, 'Record audio or import a clip'); assert.equal(navigation.calls.at(-1)[1].screenId, '44a'); assert.deepEqual(f.calls, []);
  } finally { await close(tree); }
});

test('observation failure keeps its text and success navigates to the saved record for rereading', async () => {
  let offline = true;
  const f = fixture({ post: async () => { if (offline) throw new Error('Offline; observation not confirmed'); return { id: 'saved-record', pet_id: pet.id }; } }), navigation = nav();
  const { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, { screenId: '43', navigation });
  try {
    await press(tree, 'Write an observation'); await edit(tree, 'Context and observations', 'A real owner note');
    await press(tree, 'Save observation'); assert.equal(field(tree, 'Context and observations').props.value, 'A real owner note'); assert.ok(text(tree).includes('Offline; observation not confirmed')); assert.equal(navigation.calls.length, 0);
    offline = false; await press(tree, 'Save observation'); assert.equal(navigation.calls[0][1].recordId, 'saved-record'); assert.equal(navigation.calls[0][1].screenId, '43');
  } finally { await close(tree); }
});

test('learn features actual published content and reading passes the exact source version to Ask AI', async () => {
  const f = fixture(), navigation = nav(), { PawchLearnScreen } = f.load('src/pawch/LearnFlow.tsx');
  const tree = await render(PawchLearnScreen, { screenId: '48', navigation });
  try { assert.ok(text(tree).includes(content.title)); await press(tree, 'Start today’s lesson'); assert.deepEqual(navigation.calls[0][1], { screenId: '49', contentId: content.id, contentVersion: 3 }); }
  finally { await close(tree); }
  const reading = await render(PawchLearnScreen, { screenId: '49', navigation, route: { params: { contentId: content.id, contentVersion: 3 } } });
  try {
    assert.ok(text(reading).includes(content.body)); await press(reading, 'Ask Pawch AI about this');
    assert.deepEqual(navigation.calls.at(-1)[1], { screenId: '51', kind: 'lesson', lessonId: content.id, lessonVersion: 3, lessonTitle: content.title });
  } finally { await close(reading); }
});

test('featured learning limits recommendations, folds real count history, and keeps library search and filters operable', async () => {
  const rows = [structuredClone(content), { ...structuredClone(content), id: 'lesson-b', title: 'Second published lesson' }, { ...structuredClone(content), id: 'lesson-c', title: 'Third published lesson' }];
  const f = fixture({ get: path => {
    const url = new URL(path, 'http://test.invalid');
    if (url.pathname === '/content') return { items: url.searchParams.get('q') ? [{ ...rows[0], id: 'plan-match', kind: 'plan', title: 'Matched reviewed plan' }] : rows, next_cursor: 'next-page' };
    if (url.pathname === '/learning-progress') return { items: [{ learned: false }], counts: { scope: 'all_current_published_lessons', learned_count: 7, available_count: 12 } };
  } }), navigation = nav(), { PawchLearnScreen } = f.load('src/pawch/LearnFlow.tsx');
  const featured = await render(PawchLearnScreen, { screenId: '48', navigation });
  try {
    assert.ok(text(featured).includes(content.title)); assert.ok(text(featured).includes('Second published lesson')); assert.ok(!text(featured).includes('Third published lesson')); assert.equal(buttons(featured, 'More from the library').length, 0);
    assert.equal(buttons(featured, 'Your learning journal').length, 0); await press(featured, 'Learning history & options');
    assert.ok(text(featured).includes('Current published lessons learned · 7 of 12')); await press(featured, 'Your learning journal'); assert.equal(navigation.calls.at(-1)[0], 'Learning');
    await press(featured, 'Browse the library'); assert.equal(navigation.calls.at(-1)[1].screenId, '50');
  } finally { await close(featured); }
  const library = await render(PawchLearnScreen, { screenId: '50', navigation });
  try {
    assert.ok(text(library).includes('Third published lesson')); assert.equal(library.root.findAllByProps({ accessibilityLabel: 'Search the library' }).length, 0);
    await press(library, 'Search & filters'); await edit(library, 'Search the library', 'nutrition'); await press(library, 'Plans'); await press(library, 'Search published content');
    const searchRequest = f.calls.findLast(([m, path]) => m === 'get' && path.startsWith('/content?')); const url = new URL(searchRequest[1], 'http://test.invalid');
    assert.equal(url.searchParams.get('kind'), 'plan'); assert.equal(url.searchParams.get('q'), 'nutrition'); assert.ok(text(library).includes('Matched reviewed plan'));
    await press(library, 'Search & filters'); assert.equal(library.root.findAllByProps({ accessibilityLabel: 'Search the library' }).length, 0); assert.ok(text(library).includes('Matched reviewed plan'));
  } finally { await close(library); }
});

test('a saved learning record with failed reread remains acknowledged and retries GET without another PUT', async () => {
  let saved = false, failRead = true;
  const f = fixture({ get: path => { if (saved && failRead && path.startsWith('/content/')) throw new Error('Progress read unavailable'); }, put: async (_path, body) => { assert.equal(body.expected_version, 2); saved = true; return { version: 3 }; } });
  const { PawchLearnScreen } = f.load('src/pawch/LearnFlow.tsx'), tree = await render(PawchLearnScreen, { screenId: '49', navigation: nav(), route: { params: { contentId: content.id } } });
  try {
    await change(() => tree.root.findByProps({ accessibilityLabel: 'I have learned this version' }).props.onValueChange(true));
    await press(tree, 'Save my learning progress'); assert.ok(text(tree).includes('学习记录已保存，但读取暂时失败')); assert.equal(f.calls.filter(([m]) => m === 'put').length, 1);
    failRead = false; await press(tree, 'Try again'); assert.equal(f.calls.filter(([m]) => m === 'put').length, 1);
  } finally { await close(tree); }
});

test('Ask creates a real conversation and sends the selected lesson version without inventing an answer', async () => {
  const f = fixture({ post: async (path, body) => path.endsWith('/assistant-conversations') ? { id: 'conversation-a', pet_id: pet.id } : { id: 'message-a', pet_id: pet.id, conversation_id: 'conversation-a', question: body.question, status: 'pending', attempt: 1 } });
  const { PawchLearnScreen } = f.load('src/pawch/LearnFlow.tsx'), tree = await render(PawchLearnScreen, { screenId: '51', navigation: nav(), route: { params: { kind: 'lesson', lessonId: content.id, lessonVersion: 3, lessonTitle: content.title } } });
  try {
    await edit(tree, 'Your question', 'How do I read this source?'); await press(tree, 'Send message');
    const posts = f.calls.filter(([m]) => m === 'post'); assert.equal(posts.length, 2); assert.equal(posts[1][2].context.lesson_id, content.id); assert.equal(posts[1][2].context.lesson_version, 3); assert.equal(posts[1][2].context.kind, 'lesson');
    assert.ok(text(tree).includes('真实模型未配置')); assert.ok(!text(tree).includes('It’s possible, but a yawn alone'));
  } finally { await close(tree); }
});

test('late answer creation cannot select or clear a newly chosen conversation', async () => {
  const pending = deferred();
  const f = fixture({ get: path => {
    if (path.startsWith('/pets/pet-a/assistant-conversations')) return { items: [{ id: 'conversation-a', title: 'First thread' }, { id: 'conversation-b', title: 'Second thread' }] };
    if (path.startsWith('/assistant-messages/')) return { id: 'message-old', pet_id: pet.id, conversation_id: 'conversation-a', status: 'pending' };
  }, post: () => pending.promise });
  const { PawchLearnScreen } = f.load('src/pawch/LearnFlow.tsx'), tree = await render(PawchLearnScreen, { screenId: '51', navigation: nav() }); let running;
  try {
    await press(tree, 'Context & conversations'); await press(tree, 'Choose a conversation'); await press(tree, 'First thread'); await press(tree, 'Choose a conversation');
    await edit(tree, 'Your question', 'Keep this draft if I change thread');
    await change(() => { running = buttons(tree, 'Send message')[0].props.onPress(); });
    await press(tree, 'Second thread');
    await change(async () => { pending.resolve({ id: 'message-old', pet_id: pet.id, conversation_id: 'conversation-a' }); await running; });
    assert.equal(field(tree, 'Your question').props.value, 'Keep this draft if I change thread'); assert.ok(!f.calls.some(([m, path]) => m === 'get' && path === '/assistant-messages/message-old'));
  } finally { await close(tree); }
});

test('a foreign pet observation is rejected before its content is rendered', async () => {
  const f = fixture({ get: path => path.startsWith('/behavior-records/') ? { id: 'foreign', pet_id: 'other-pet', labels: ['MUST NOT DISPLAY'], notes: 'PRIVATE FOREIGN NOTE' } : undefined });
  const { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, { screenId: '43', navigation: nav(), route: { params: { recordId: 'foreign' } } });
  try { assert.ok(text(tree).includes('来源不属于当前宠物')); assert.ok(!text(tree).includes('PRIVATE FOREIGN NOTE')); }
  finally { await close(tree); }
});

test('a role downgrade remounts the observation draft and removes writable controls', async () => {
  const f = fixture(), props = { screenId: '43', navigation: nav() }, { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, props);
  try {
    await press(tree, 'Write an observation'); await edit(tree, 'Context and observations', 'A private unsaved writable draft');
    f.state.households = [{ ...household, role: 'viewer' }];
    await change(() => tree.update(React.createElement(PawchBehaviorScreen, props)));
    assert.ok(!text(tree).includes('A private unsaved writable draft')); assert.equal(buttons(tree, 'Save observation').length, 0);
    assert.equal(buttons(tree, 'Write an observation')[0].props.disabled, true); assert.equal(f.calls.filter(([m]) => m === 'post').length, 0);
  } finally { await close(tree); }
});

test('historical lessons remain read-only and invalid lesson context is rejected before creating a conversation', async () => {
  const f = fixture({ get: path => path.startsWith('/content/') ? { ...structuredClone(content), current_version: 4 } : undefined }), { PawchLearnScreen } = f.load('src/pawch/LearnFlow.tsx');
  const reading = await render(PawchLearnScreen, { screenId: '49', navigation: nav(), route: { params: { contentId: content.id, contentVersion: 3 } } });
  try { assert.equal(buttons(reading, 'Save my learning progress')[0].props.disabled, true); assert.equal(reading.root.findByProps({ accessibilityLabel: 'I have learned this version' }).props.disabled, true); assert.ok(text(reading).includes('历史版本')); }
  finally { await close(reading); }
  const chat = await render(PawchLearnScreen, { screenId: '51', navigation: nav(), route: { params: { kind: 'lesson', lessonId: content.id, lessonVersion: 'not-a-version' } } });
  try { await edit(chat, 'Your question', 'This should require a valid source.'); await press(chat, 'Send message'); assert.ok(text(chat).includes('请先选择真实课程及版本')); assert.equal(f.calls.filter(([m]) => m === 'post').length, 0); }
  finally { await close(chat); }
});

test('late interpretation feedback cannot clear the draft for a newly selected task', async () => {
  const pending = deferred(), task = (id, attempt) => ({ id, attempt, pet_id: pet.id, status: 'succeeded', media_id: 'media-a', result: { text: `Result for ${id}` }, created_at: '2026-11-28T01:00:00Z' });
  const f = fixture({ get: path => {
    if (path.startsWith('/pets/pet-a/interpretations?')) return { items: [task('task-a', 1), task('task-b', 2)] };
    if (path === '/interpretations/task-a') return task('task-a', 1);
    if (path === '/interpretations/task-b') return task('task-b', 2);
  }, post: () => pending.promise });
  const { PawchBehaviorScreen } = f.load('src/pawch/BehaviorFlow.tsx'), tree = await render(PawchBehaviorScreen, { screenId: '45', navigation: nav(), route: { params: { taskId: 'task-a' } } }); let running;
  try {
    await edit(tree, 'Your feedback on this attempt', 'First task feedback');
    await change(() => { running = buttons(tree, 'Save feedback')[0].props.onPress(); });
    await press(tree, 'Complete · attempt 2'); await edit(tree, 'Your feedback on this attempt', 'Second task unsaved feedback');
    await change(async () => { pending.resolve({ id: 'saved-feedback' }); await running; });
    assert.equal(field(tree, 'Your feedback on this attempt').props.value, 'Second task unsaved feedback');
    const post = f.calls.find(([m]) => m === 'post'); assert.equal(post[1], '/interpretations/task-a/feedback'); assert.equal(post[2].expected_attempt, 1);
  } finally { await close(tree); }
});
