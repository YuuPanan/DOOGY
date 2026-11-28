const test = require('node:test');
const assert = require('node:assert/strict');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

async function setup() {
  const choice = deferred(), uploads = [];
  let focused = true;
  const records = ['care-a', 'care-b'].map(id => ({ id, pet_id: 'pet-a', type: 'note', value: { text: id }, created_by: 'owner', recorded_at: '2026-11-28T08:00:00Z', updated_at: 'v1', attachments: [] }));
  const api = { baseUrl: 'http://test/api/v1', get: async path => {
    if (path.includes('/history')) return {};
    if (path.startsWith('/care-records/')) return structuredClone(records.find(row => path === `/care-records/${row.id}`));
    return { items: structuredClone(records) };
  }, upload: async (...args) => { uploads.push(args); return {}; } };
  let state = { api, user: { id: 'owner' }, pet: { id: 'pet-a', household_id: 'home', name: '合成宠物' }, household: { id: 'home', role: 'owner' } };
  const { CareScreen } = screenModule('src/screens/CareScreens.tsx', () => state, {
    'expo-document-picker': { getDocumentAsync: () => choice.promise },
    '@react-navigation/native': { useIsFocused: () => focused },
  });
  const props = { navigation: { navigate() {}, popTo() {}, setParams() {} }, route: { params: {} } };
  const tree = await render(CareScreen, props);
  const buttons = title => tree.root.findAllByProps({ accessibilityRole: 'button', accessibilityLabel: title });
  const select = async index => change(() => buttons('详情与修订')[index].props.onPress());
  await select(0);
  let pending;
  await change(() => { pending = buttons('选择并上传附件')[0].props.onPress(); });
  return { uploads, select, async update(mutator) { state = mutator(state); await change(() => tree.update(React.createElement(CareScreen, props))); },
    async blurReturn() { focused = false; await change(() => tree.update(React.createElement(CareScreen, props))); focused = true; await change(() => tree.update(React.createElement(CareScreen, props))); },
    async finish(canceled = false) { await change(async () => { choice.resolve(canceled ? { canceled: true } : { canceled: false, assets: [{ uri: 'file:///synthetic.pdf', name: 'synthetic.pdf', mimeType: 'application/pdf', size: 12 }] }); await pending; }); },
    close: () => change(() => tree.unmount()) };
}

test('care attachment selection uploads once to the unchanged current record', async () => {
  const fixture = await setup();
  try { await fixture.finish(); assert.equal(fixture.uploads.length, 1); assert.equal(fixture.uploads[0][0], '/care-records/care-a/attachments'); }
  finally { await fixture.close(); }
});

for (const [name, move] of [
  ['select another record', f => f.select(1)],
  ['select A then B then A', async f => { await f.select(1); await f.select(0); }],
  ['switch pets', f => f.update(s => ({ ...s, pet: { ...s.pet, id: 'pet-b' } }))],
  ['switch accounts', f => f.update(s => ({ ...s, user: { id: 'another-user' } }))],
  ['switch API client', f => f.update(s => ({ ...s, api: { ...s.api, baseUrl: 'http://other/api/v1' } }))],
  ['lose write permission', f => f.update(s => ({ ...s, household: { ...s.household, role: 'viewer' } }))],
  ['leave and return to the screen', f => f.blurReturn()],
  ['unmount the screen', f => f.close()],
]) test(`late care attachment selection does not upload after ${name}`, async () => {
  const fixture = await setup();
  try { await move(fixture); await fixture.finish(); assert.equal(fixture.uploads.length, 0); }
  finally { await fixture.close(); }
});

test('canceling the care attachment picker does not upload', async () => {
  const fixture = await setup();
  try { await fixture.finish(true); assert.equal(fixture.uploads.length, 0); }
  finally { await fixture.close(); }
});
