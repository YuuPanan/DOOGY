const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');
const host = name => props => React.createElement(name, props, props.children);
const app = { authenticated: true, pet: { name: 'Milo' } };
const ui = () => screenModule('src/pawch/ui.tsx', app, { './assets': { Asset: host('PawchAsset') } });
const pressables = tree => tree.root.findAllByType('Pressable');
const output = tree => JSON.stringify(tree.toJSON());

test('Pawch async buttons reject a rapid duplicate before React commits the busy render', async () => {
  const { Button } = ui(), wait = deferred(); let writes = 0, first, second;
  const tree = await render(Button, { title: 'Save actual data', run: async () => { writes++; await wait.promise; } });
  try {
    const oldPress = pressables(tree)[0].props.onPress;
    await change(() => { first = oldPress(); second = oldPress(); });
    assert.equal(writes, 1); assert.equal(pressables(tree)[0].props.disabled, true);
    await change(async () => { wait.resolve(); await Promise.all([first, second]); });
    assert.equal(pressables(tree)[0].props.disabled, false);
  } finally { await change(() => tree.unmount()); }
});

test('a delayed native button handler cannot write after permission disables the button', async () => {
  const { Button } = ui(); let writes = 0; const props = { title: 'Save', run: async () => { writes++; } };
  const tree = await render(Button, props);
  try { const late = pressables(tree)[0].props.onPress; await change(() => tree.update(React.createElement(Button, { ...props, disabled: true }))); await change(late); assert.equal(writes, 0); }
  finally { await change(() => tree.unmount()); }
});
test('a queued button press cannot write after its source page has unmounted', async () => {
  const { Button } = ui(); let writes = 0; const tree = await render(Button, { title: 'Save old pet', run: async () => { writes++; } });
  const late = pressables(tree)[0].props.onPress; await change(() => tree.unmount()); await change(late); assert.equal(writes, 0);
});
test('a completed request cannot invoke a removed source page completion handler', async () => {
  const { Button } = ui(), pending = deferred(); let done = 0, running; const tree = await render(Button, { title: 'Save', run: () => pending.promise, onDone: () => { done++; } });
  await change(() => { running = pressables(tree)[0].props.onPress(); }); await change(() => tree.unmount()); await change(async () => { pending.resolve({ id: 'old-source' }); await running; }); assert.equal(done, 0);
});

test('a failed Pawch write leaves a visible retryable error rather than a saved message', async () => {
  const { Button } = ui(); let writes = 0;
  const tree = await render(Button, { title: 'Save', success: 'Saved', run: async () => { writes++; throw new Error('Network unavailable; not confirmed saved'); } });
  try { await change(() => pressables(tree)[0].props.onPress()); assert.equal(writes, 1); assert.ok(output(tree).includes('Network unavailable; not confirmed saved')); assert.ok(!tree.root.findAllByType('Text').some(node => node.props.children === 'Saved')); assert.equal(pressables(tree)[0].props.disabled, false); }
  finally { await change(() => tree.unmount()); }
});

test('the primary footer remains outside the scrolling long form', async () => {
  const { Page, Button, Field } = ui(); const tree = await render(Page, { screenId: '15a', title: 'Observations', navigation: {}, footer: React.createElement(Button, { title: 'Save observations', onPress() {} }), children: React.createElement(Field, { label: 'Energy', value: 'Long draft', multiline: true }) });
  try { const footer = tree.root.findByProps({ testID: 'pawch-footer-15a' }); let parent = footer.parent; while (parent) { assert.notEqual(parent.type, 'ScrollView'); parent = parent.parent; } assert.equal(tree.root.findAllByType('ScrollView').length, 1); }
  finally { await change(() => tree.unmount()); }
});

function routerFixture(authenticated = true) {
  const state = { authenticated };
  const child = group => ({ screenId, params = {} }) => { const [draft, setDraft] = React.useState(params.recordId ?? ''); return React.createElement('RouteBody', { group, screenId }, React.createElement('TextInput', { accessibilityLabel: 'Source draft', value: draft, onChangeText: setDraft })); };
  const module = screenModule('src/pawch/Router.tsx', () => state, {
    './OnboardingFlow': { PawchOnboardingScreen: child('01') }, './WellbeingFlow': { PawchWellbeingScreen: child('02') }, './NutritionFlow': { PawchNutritionScreen: child('03') }, './CareFlow': { PawchCareScreen: child('04') }, './SafetyFlow': { PawchSafetyScreen: child('05') }, './BehaviorFlow': { PawchBehaviorScreen: child('06') }, './LearnFlow': { PawchLearnScreen: child('07') },
  });
  return { ...module, state };
}
test('all 51 main screens and 14 supplemental states reach the intended seven group renderers', async () => {
  const { PawchRouter, screenIds } = routerFixture(); assert.equal(screenIds.length, 65); assert.equal(new Set(screenIds).size, 65);
  const counts = {};
  for (const id of screenIds) {
    const tree = await render(PawchRouter, { screenId: id, navigation: {} });
    try { const route = tree.root.findByType('RouteBody'), n = parseInt(id, 10), group = n <= 8 ? '01' : n <= 17 ? '02' : n <= 23 ? '03' : n <= 27 ? '04' : n <= 39 ? '05' : n <= 47 ? '06' : '07'; assert.equal(route.props.screenId, id); assert.equal(route.props.group, group); counts[group] = (counts[group] ?? 0) + 1; }
    finally { await change(() => tree.unmount()); }
  }
  assert.deepEqual(counts, { '01': 8, '02': 12, '03': 9, '04': 4, '05': 15, '06': 13, '07': 4 });
});
test('private frame deep links still require authentication', async () => {
  const { PawchRouter, screenIds, publicScreenIds } = routerFixture(false);
  for (const id of screenIds) {
    const tree = await render(PawchRouter, { screenId: id, navigation: {} });
    try { assert.equal(tree.root.findByType('RouteBody').props.screenId, publicScreenIds.has(id) ? id : '06'); }
    finally { await change(() => tree.unmount()); }
  }
});
test('changing a meal source on the same screen clears the previous source draft', async () => {
  const { PawchRouter } = routerFixture(); const props = { screenId: '21', navigation: {}, route: { params: { recordId: 'meal-a' } } }, tree = await render(PawchRouter, props);
  try { await change(() => tree.root.findByType('TextInput').props.onChangeText('Unsent draft for A')); await change(() => tree.update(React.createElement(PawchRouter, { ...props, route: { params: { recordId: 'meal-b' } } }))); assert.equal(tree.root.findByType('TextInput').props.value, 'meal-b'); }
  finally { await change(() => tree.unmount()); }
});
