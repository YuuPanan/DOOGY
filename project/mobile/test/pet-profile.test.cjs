const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

const household = { id: 'home-a', name: '共同照护的家', role: 'owner', timezone: 'Asia/Shanghai' };
const pet = { id: 'pet-a', household_id: household.id, name: '豆豆', species: 'dog', breed: null, birth_date: null, weight_kg: null, effective_timezone: 'Asia/Shanghai', updated_at: 'first' };
const props = { navigation: { navigate() {}, popTo() {} }, route: { params: { from: 'today' } } };
function fixture(options = {}) {
  const writes = [], selected = [], navigation = [], listeners = new Map(); let reads = 0, saved = { ...pet }, current;
  current = { user: { id: 'user-a' }, pet: options.empty ? null : { ...pet }, pets: options.empty ? [] : [{ ...pet }],
    household: { ...household, role: options.role ?? 'owner' }, households: [{ ...household, role: options.role ?? 'owner' }],
    api: { baseUrl: 'http://local.invalid/api/v1', patch: async (path, body) => { writes.push({ path, body }); if (options.patch) return options.patch(path, body); saved = { ...saved, ...body, updated_at: 'saved' }; return saved; },
      upload: async (...args) => { writes.push({ upload: args }); return options.upload ? options.upload(...args) : {}; } },
    selectPet: id => selected.push(id), refreshIdentity: async () => { reads++; if (options.read) await options.read(reads); current = { ...current, pet: saved ? { ...saved } : null, pets: saved ? [{ ...saved }] : [] }; } };
  const { PetScreen } = screenModule('src/screens/AccountScreens.tsx', () => current, {
    'expo-image-picker': { launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: 'file:///owned-avatar.png', fileName: 'avatar.png', mimeType: 'image/png', fileSize: 100 }] }) },
  });
  return { PetScreen, writes, selected, navigation, get reads() { return reads; }, get state() { return current; }, set state(value) { current = value; },
    set persistedPet(value) { saved = value; }, focus: () => change(() => listeners.get('focus')?.()),
    props: { ...props, navigation: { navigate: (...args) => navigation.push(['navigate', ...args]), popTo: (...args) => navigation.push(['popTo', ...args]),
      addListener: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); } } } };
}
const buttons = (tree, title) => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === title);
async function press(tree, title) { const node = buttons(tree, title)[0]; assert.ok(node, title); assert.ok(!node.props.disabled, title); await change(() => node.props.onPress()); }
const field = (tree, label) => tree.root.findByProps({ accessibilityLabel: label });
const edit = (tree, label, value) => change(() => field(tree, label).props.onChangeText(value));
const content = tree => JSON.stringify(tree.toJSON());
const close = tree => change(() => tree.unmount());

test('pet opens a real profile card with unknown weight, then links to care and back to Today', async () => {
  const f = fixture(), tree = await render(f.PetScreen, f.props);
  try {
    assert.ok(content(tree).includes('豆豆')); assert.ok(content(tree).includes('尚未记录')); assert.ok(content(tree).includes('主人'));
    assert.equal(tree.root.findAllByProps({ accessibilityLabel: '名称' }).length, 0);
    await press(tree, '进入照护记录'); await press(tree, '返回今天');
    assert.deepEqual(f.navigation, [['navigate', 'Care', { from: 'pet' }], ['popTo', 'Main', { screen: 'HomeTab' }]]);
    assert.equal(f.writes.length, 0);
  } finally { await close(tree); }
});

test('explicit pet editing can cancel without writing and reopening restores saved values', async () => {
  const f = fixture(), tree = await render(f.PetScreen, f.props);
  try {
    await press(tree, '编辑档案'); await edit(tree, '名称', '未保存草稿'); await edit(tree, '本次称重 kg（留空不新增称重）', '8.2');
    await press(tree, '取消编辑'); assert.equal(f.writes.length, 0); assert.equal(tree.root.findAllByProps({ accessibilityLabel: '名称' }).length, 0);
    await press(tree, '编辑档案'); assert.equal(field(tree, '名称').props.value, '豆豆'); assert.equal(field(tree, '本次称重 kg（留空不新增称重）').props.value, '');
  } finally { await close(tree); }
});

test('saving a pet returns to its profile card and rereads the persisted result', async () => {
  const f = fixture(), tree = await render(f.PetScreen, f.props);
  try {
    await press(tree, '编辑档案'); await edit(tree, '名称', ' 豆豆的新名字 '); await edit(tree, '品种（可空）', '主人填写的品种');
    await press(tree, '保存档案');
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].path, '/pets/pet-a'); assert.equal(f.writes[0].body.name, '豆豆的新名字');
    assert.equal(Object.hasOwn(f.writes[0].body, 'weight_kg'), false); assert.equal(f.reads, 1);
    assert.equal(tree.root.findAllByProps({ accessibilityLabel: '名称' }).length, 0); assert.ok(content(tree).includes('豆豆的新名字'));
    await press(tree, '刷新宠物档案'); assert.equal(f.reads, 2); assert.equal(f.writes.length, 1);
  } finally { await close(tree); }
});

test('a failed pet save retains the draft, and a saved result with a failed read retries only reading', async () => {
  for (const failure of ['write', 'read']) {
    const f = fixture({ patch: failure === 'write' ? async () => { throw new Error('临时断网，未确认保存'); } : undefined,
      read: failure === 'read' ? async count => { if (count === 1) throw new Error('档案暂时无法读取'); } : undefined });
    const tree = await render(f.PetScreen, f.props);
    try {
      await press(tree, '编辑档案'); await edit(tree, '名称', '保留的名字'); await press(tree, '保存档案');
      if (failure === 'write') { assert.equal(field(tree, '名称').props.value, '保留的名字'); assert.ok(content(tree).includes('临时断网')); }
      else { assert.equal(buttons(tree, '保存档案').length, 0); await press(tree, '重新读取已保存宠物'); assert.equal(f.reads, 2); }
      assert.equal(f.writes.length, 1);
    } finally { await close(tree); }
  }
});

test('a delayed pet save keeps its draft and shows a retryable error after the request fails', async () => {
  const pending = deferred(), f = fixture({ patch: () => pending.promise }), tree = await render(f.PetScreen, f.props); let running;
  try {
    await press(tree, '编辑档案'); await edit(tree, '名称', '离线时保留的名字');
    await change(() => { running = buttons(tree, '保存档案')[0].props.onPress(); });
    assert.equal(field(tree, '名称').props.editable, false);
    await change(async () => { pending.reject(new Error('网络中断，请重试保存')); await running; });
    assert.equal(field(tree, '名称').props.value, '离线时保留的名字'); assert.equal(field(tree, '名称').props.editable, true);
    assert.ok(content(tree).includes('网络中断，请重试保存')); assert.ok(!buttons(tree, '保存档案')[0].props.disabled); assert.equal(f.writes.length, 1);
  } finally { await close(tree); }
});

test('viewer sees a readable profile and care entry without editable profile or avatar controls', async () => {
  const f = fixture({ role: 'viewer' }), tree = await render(f.PetScreen, f.props);
  try {
    assert.ok(content(tree).includes('只读成员')); assert.equal(buttons(tree, '编辑档案').length, 0);
    assert.equal(buttons(tree, '从相册选择头像').length, 0); assert.equal(tree.root.findAllByType('TextInput').length, 0);
    await press(tree, '进入照护记录'); assert.equal(f.writes.length, 0);
  } finally { await close(tree); }
});

test('late avatar upload after changing the pet cannot refresh or clear the new pet scope', async () => {
  const pending = deferred(), f = fixture({ upload: () => pending.promise }), tree = await render(f.PetScreen, f.props); let running;
  try {
    await press(tree, '编辑档案'); await press(tree, '从相册选择头像');
    await change(() => { running = buttons(tree, '确认替换头像')[0].props.onPress(); });
    f.state = { ...f.state, pet: { ...pet, id: 'pet-b', name: '另一位伙伴' } };
    await change(() => tree.update(React.createElement(f.PetScreen, f.props)));
    await change(async () => { pending.resolve({ id: 'old-avatar' }); await running; });
    assert.equal(f.reads, 0); assert.ok(content(tree).includes('另一位伙伴')); assert.equal(buttons(tree, '确认替换头像').length, 0);
  } finally { await close(tree); }
});

test('returning from care rereads the persisted current weight on navigation focus, not ordinary renders', async () => {
  const f = fixture(), tree = await render(f.PetScreen, f.props);
  try {
    f.persistedPet = { ...pet, weight_kg: 8.4, updated_at: 'care-weight-saved' };
    await change(() => tree.update(React.createElement(f.PetScreen, f.props)));
    assert.equal(f.reads, 0); assert.ok(content(tree).includes('尚未记录'));
    await f.focus(); await change(() => tree.update(React.createElement(f.PetScreen, f.props)));
    assert.equal(f.reads, 1); assert.ok(content(tree).includes('8.4 kg'));
    await change(() => tree.update(React.createElement(f.PetScreen, f.props)));
    assert.equal(f.reads, 1); assert.equal(f.writes.length, 0);
  } finally { await close(tree); }
});

test('failed focus reading stays visible and the profile refresh retries reading without any write', async () => {
  const f = fixture({ read: async count => { if (count === 1) throw new Error('照护已保存，档案暂时无法读取'); } }), tree = await render(f.PetScreen, f.props);
  try {
    f.persistedPet = { ...pet, weight_kg: 8.7, updated_at: 'care-weight-saved' };
    await f.focus(); assert.equal(f.reads, 1); assert.ok(content(tree).includes('照护已保存，档案暂时无法读取'));
    await press(tree, '刷新宠物档案'); await change(() => tree.update(React.createElement(f.PetScreen, f.props)));
    assert.equal(f.reads, 2); assert.ok(content(tree).includes('8.7 kg')); assert.ok(!content(tree).includes('档案暂时无法读取')); assert.equal(f.writes.length, 0);
  } finally { await close(tree); }
});

test('focus after an acknowledged profile save retries only its failed read and returns to the profile', async () => {
  const f = fixture({ read: async count => { if (count === 1) throw new Error('保存后的读取失败'); } }), tree = await render(f.PetScreen, f.props);
  try {
    await press(tree, '编辑档案'); await edit(tree, '名称', '已确认的名字'); await press(tree, '保存档案');
    assert.ok(content(tree).includes('档案已经保存')); assert.equal(f.writes.length, 1);
    await f.focus(); await change(() => tree.update(React.createElement(f.PetScreen, f.props)));
    assert.equal(f.reads, 2); assert.equal(f.writes.length, 1); assert.ok(content(tree).includes('已确认的名字'));
    assert.equal(buttons(tree, '重新读取已保存宠物').length, 0); assert.equal(tree.root.findAllByProps({ accessibilityLabel: '名称' }).length, 0);
  } finally { await close(tree); }
});

for (const mode of ['editing', 'creating']) test(`unsaved ${mode} fields survive a focus read of an externally updated current pet`, async () => {
  const response = deferred(), f = fixture({ read: () => response.promise }), tree = await render(f.PetScreen, f.props);
  try {
    await press(tree, mode === 'editing' ? '编辑档案' : '新建宠物');
    await edit(tree, '名称', '尚未提交的名字'); await edit(tree, '品种（可空）', '尚未提交的品种');
    await edit(tree, '出生日期 YYYY-MM-DD（可空）', '2020-06-01'); await edit(tree, 'IANA 时区（空则跟随家庭）', 'Asia/Tokyo');
    const weightLabel = mode === 'editing' ? '本次称重 kg（留空不新增称重）' : '初始体重 kg（可空）';
    await edit(tree, weightLabel, '9.2');
    f.persistedPet = { ...pet, name: '另一成员保存的名字', breed: '另一成员保存的品种', weight_kg: 8.4, updated_at: 'external-update' };
    await f.focus(); await change(() => response.resolve());
    await change(() => tree.update(React.createElement(f.PetScreen, f.props)));
    assert.equal(f.reads, 1); assert.equal(f.state.pet.name, '另一成员保存的名字');
    if (mode === 'editing') assert.ok(content(tree).includes('编辑 另一成员保存的名字'));
    assert.equal(field(tree, '名称').props.value, '尚未提交的名字'); assert.equal(field(tree, '品种（可空）').props.value, '尚未提交的品种');
    assert.equal(field(tree, '出生日期 YYYY-MM-DD（可空）').props.value, '2020-06-01'); assert.equal(field(tree, 'IANA 时区（空则跟随家庭）').props.value, 'Asia/Tokyo');
    assert.equal(field(tree, weightLabel).props.value, '9.2'); assert.equal(f.writes.length, 0);
    await press(tree, mode === 'editing' ? '取消编辑' : '取消新建');
    assert.ok(content(tree).includes('另一成员保存的名字')); assert.ok(content(tree).includes('8.4 kg'));
    await press(tree, '编辑档案'); assert.equal(field(tree, '名称').props.value, '另一成员保存的名字'); assert.equal(field(tree, '品种（可空）').props.value, '另一成员保存的品种');
  } finally { await close(tree); }
});

for (const access of ['viewer', 'removed']) test(`focused identity reading still clears an editable draft when access becomes ${access}`, async () => {
  const f = fixture({ read: async () => {
    f.state = { ...f.state, household: access === 'viewer' ? { ...household, role: 'viewer' } : null,
      households: access === 'viewer' ? [{ ...household, role: 'viewer' }] : [] };
  } }), tree = await render(f.PetScreen, f.props);
  try {
    await press(tree, '编辑档案'); await edit(tree, '名称', '旧权限下的未提交草稿');
    if (access === 'removed') f.persistedPet = null;
    await f.focus(); await change(() => tree.update(React.createElement(f.PetScreen, f.props)));
    assert.equal(f.reads, 1); assert.equal(f.writes.length, 0); assert.ok(!content(tree).includes('旧权限下的未提交草稿'));
    assert.equal(buttons(tree, '编辑档案').length, 0); assert.equal(buttons(tree, '保存档案').length, 0);
    if (access === 'viewer') { assert.ok(content(tree).includes('只读成员')); assert.equal(tree.root.findAllByType('TextInput').length, 0); }
    else { assert.equal(f.state.pet, null); assert.ok(!content(tree).includes('豆豆')); assert.equal(field(tree, '名称').props.value, ''); assert.equal(field(tree, '名称').props.editable, false); }
  } finally { await close(tree); }
});
