const test = require('node:test');
const assert = require('node:assert/strict');
const { screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

async function setup({ failWrite = false, failRead = false, pendingWrite = null, from = 'pet', role = 'owner' } = {}) {
  const writes = [], reads = [], navigationCalls = [], records = [];
  const api = { baseUrl: 'http://local/api/v1', get: async path => {
    reads.push(path);
    if (path.endsWith('/history')) return {};
    if (path.startsWith('/care-records/')) { if (failRead) throw Error('合成详情读取失败'); return records.find(row => path === `/care-records/${row.id}`); }
    return { items: structuredClone(records) };
  }, post: async (path, body, key) => {
    writes.push({ path, body, key });
    if (failWrite) throw Error('合成断网，未确认保存');
    if (pendingWrite) await pendingWrite.promise;
    const record = { ...body, id: 'saved-care', created_by: 'owner', attachments: [], updated_at: 'v1' }; records.push(record); return record;
  } };
  const state = { api, user: { id: 'owner' }, pet: { id: 'pet-a', household_id: 'home', name: '合成伙伴' }, household: { id: 'home', role } };
  const navigation = { navigate() {}, setParams() {}, popTo: (...args) => navigationCalls.push(args) };
  const { CareScreen } = screenModule('src/screens/CareScreens.tsx', state);
  const tree = await render(CareScreen, { navigation, route: { params: { from } } });
  const button = title => tree.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: title });
  const press = title => change(() => button(title).props.onPress());
  const input = label => tree.root.findByProps({ accessibilityLabel: label, autoCapitalize: 'none' });
  const text = () => tree.root.findAllByType('Text').map(n => n.props.children).filter(v => typeof v === 'string').join(' ');
  return { tree, writes, reads, navigationCalls, button, press, input, text,
    set failWrite(value) { failWrite = value; }, set failRead(value) { failRead = value; },
    async compose() { await press('新增记录'); await change(() => input('原始记录').props.onChangeText('合成闭环原文')); },
    close: () => change(() => tree.unmount()) };
}

test('care save rereads the record before returning to the existing pet profile', async () => {
  const f = await setup();
  try {
    await f.compose(); await f.press('保存记录');
    assert.equal(f.writes.length, 1); assert.ok(f.reads.includes('/care-records/saved-care'));
    assert.match(f.text(), /已保存并重新读取/); assert.match(f.text(), /合成闭环原文/);
    await f.press('返回宠物档案'); assert.deepEqual(f.navigationCalls.at(-1), ['Pet']);
  } finally { await f.close(); }
});

test('accepted care write with failed reread offers read-only retry without a second write', async () => {
  const f = await setup({ failRead: true });
  try {
    await f.compose(); await f.press('保存记录');
    assert.match(f.text(), /已保存，详情暂时无法读取/);
    assert.equal(f.tree.root.findAllByProps({ accessibilityRole: 'button', accessibilityLabel: '保存记录' }).length, 0);
    f.failRead = false; await f.press('重新读取当前记录');
    assert.equal(f.writes.length, 1); assert.match(f.text(), /已保存并重新读取/);
  } finally { await f.close(); }
});

test('disconnected care save keeps the draft and retry key, then returns to Today after recovery', async () => {
  const f = await setup({ failWrite: true, from: 'today' });
  try {
    await f.compose(); await f.press('保存记录');
    assert.equal(f.input('原始记录').props.value, '合成闭环原文'); assert.match(f.text(), /未确认保存/);
    assert.doesNotMatch(f.text(), /已保存并重新读取/);
    f.failWrite = false; await f.press('保存记录');
    assert.equal(f.writes[0].key, f.writes[1].key);
    await f.press('返回今天查看汇总'); assert.deepEqual(f.navigationCalls.at(-1), ['Main', { screen: 'HomeTab' }]);
  } finally { await f.close(); }
});

test('care commit freezes the form and cancel until the result is known', async () => {
  const waiting = deferred(), f = await setup({ pendingWrite: waiting });
  try {
    await f.compose(); let saving;
    await change(() => { saving = f.button('保存记录').props.onPress(); });
    assert.equal(f.input('原始记录').props.editable, false); assert.equal(f.button('取消编辑').props.disabled, true);
    await change(async () => { waiting.resolve(); await saving; });
    assert.equal(f.writes.length, 1);
  } finally { waiting.resolve(); await f.close(); }
});
