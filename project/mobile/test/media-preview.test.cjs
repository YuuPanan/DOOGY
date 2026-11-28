const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

// Execute the installed event hook; playback and AppState are explicit native doubles.
const eventModule = { exports: {} };
const eventCode = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../node_modules/expo/src/hooks/useEvent.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function('require', 'module', 'exports', eventCode)(require, eventModule, eventModule.exports);
const { useEvent } = eventModule.exports;

function fixture(load) {
  const callbacks = new Set(), appListeners = new Set(), calls = [];
  let player, recreatePlayer;
  function useVideoPlayer(source, setup) {
    const [revision, setRevision] = React.useState(0);
    recreatePlayer = () => setRevision(value => value + 1);
    player = React.useMemo(() => {
      const instance = { status: 'idle', source: null, pauses: 0, plays: 0,
        pause() { this.pauses++; }, play() { this.plays++; },
        addListener(name, callback) { assert.equal(name, 'statusChange'); callbacks.add(callback); return { remove: () => callbacks.delete(callback) }; } };
      setup(instance); return instance;
    }, [revision]);
    React.useEffect(() => { player.source = source; player.status = source ? 'readyToPlay' : 'idle'; }, [player, source]);
    return player;
  }
  const state = { user: { id: 'user-a' }, api: { accessToken: 'token-a', url: value => 'http://qa.invalid/api/v1' + value,
    get: async route => { calls.push(route); return load ? load(route) : { id: 'media-a', pet_id: 'pet-a' }; } } };
  const { MediaPreview } = screenModule('src/ui/MediaPreview.tsx', state, {
    expo: { useEvent }, 'expo-video': { useVideoPlayer, VideoView: 'VideoView' },
    'react-native': { AppState: { currentState: 'active', addEventListener: (name, callback) => { assert.equal(name, 'change'); appListeners.add(callback); return { remove: () => appListeners.delete(callback) }; } },
      Platform: { OS: 'android' }, View: 'View', Text: 'Text', Pressable: 'Pressable', StyleSheet: { create: value => value, hairlineWidth: 1 } },
  });
  return { MediaPreview, get player() { return player; }, state, calls, callbacks, appListeners,
    // Expo 58 recreates the player when a source replaceAsync fails.
    recreatePlayer: () => change(recreatePlayer),
    status: status => change(() => { player.status = status; for (const callback of callbacks) callback({ status }); }),
    appState: state => change(() => { for (const callback of appListeners) callback(state); }) };
}
const buttons = (tree, title) => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel === title);
async function press(tree, title) { const target = buttons(tree, title)[0]; assert.ok(target, `Missing ${title}`); assert.ok(!target.props.disabled, `Disabled ${title}`); await change(() => target.props.onPress()); }
const text = tree => JSON.stringify(tree.toJSON());
async function close(tree) { await change(() => tree.unmount()); }

test('authorized ready native player remains usable when the event hook still holds idle, without redundant custom playback controls', async () => {
  const f = fixture(), tree = await render(f.MediaPreview, { id: 'media-a', petId: 'pet-a' });
  try {
    assert.equal(tree.root.findAllByType('VideoView').length, 0);
    await press(tree, '重新授权并加载原生播放器');
    assert.equal(f.player.status, 'readyToPlay');
    const video = tree.root.findByType('VideoView'); assert.equal(video.props.nativeControls, true); assert.equal(video.props.player, f.player);
    assert.equal(video.props.allowsPictureInPicture, false); assert.deepEqual(video.props.fullscreenOptions, { enable: false });
    assert.equal(buttons(tree, '播放').length, 0); assert.equal(buttons(tree, '暂停').length, 0);
    assert.ok(!text(tree).includes('播放器状态：idle')); assert.ok(text(tree).includes('使用播放器内的播放/暂停控件'));
    assert.equal(f.player.plays, 0); assert.equal(f.player.staysActiveInBackground, false);
    assert.equal(f.player.source.useCaching, false); assert.deepEqual(f.player.source.headers, { Authorization: 'Bearer token-a' });
    assert.equal(f.player.source.uri.includes('token'), false);
  } finally { await close(tree); }
});

test('native playback errors retain an explicit reauthorization path and use a refreshed bearer header', async () => {
  const f = fixture(), tree = await render(f.MediaPreview, { id: 'media-a', petId: 'pet-a' });
  try {
    await press(tree, '重新授权并加载原生播放器'); await f.status('error');
    assert.ok(text(tree).includes('媒体无法加载或解码')); assert.equal(tree.root.findByType('VideoView').props.nativeControls, true);
    f.state.api.accessToken = 'token-new'; await press(tree, '重新授权并加载原生播放器'); await f.status('readyToPlay');
    assert.deepEqual(f.calls, ['/media/media-a', '/media/media-a']);
    assert.deepEqual(f.player.source.headers, { Authorization: 'Bearer token-new' }); assert.ok(!text(tree).includes('媒体无法加载或解码'));
    assert.equal(f.player.plays, 0);
  } finally { await close(tree); }
});

test('SDK recovery recreates the player without discarding its authorized source; stop pauses the current instance', async () => {
  const f = fixture(), tree = await render(f.MediaPreview, { id: 'media-a', petId: 'pet-a' });
  try {
    await press(tree, '重新授权并加载原生播放器'); const previous = f.player;
    await f.recreatePlayer();
    assert.notEqual(f.player, previous);
    assert.equal(tree.root.findByType('VideoView').props.player, f.player);
    assert.equal(f.player.source.uri, 'http://qa.invalid/api/v1/media/media-a/content');
    assert.deepEqual(f.player.source.headers, { Authorization: 'Bearer token-a' });
    assert.equal(f.calls.length, 1);
    const current = f.player, previousPauses = previous.pauses;
    await press(tree, '停止并清除播放来源');
    assert.ok(current.pauses > 0); assert.equal(current.source, null);
    assert.equal(previous.pauses, previousPauses);
  } finally { await close(tree); }
});

test('explicit stop and entering background pause and clear the source without resuming automatically', async () => {
  const f = fixture(), tree = await render(f.MediaPreview, { id: 'media-a', petId: 'pet-a' });
  try {
    await press(tree, '重新授权并加载原生播放器'); const beforeStop = f.player.pauses;
    await press(tree, '停止并清除播放来源'); assert.equal(f.player.source, null); assert.ok(f.player.pauses > beforeStop);
    assert.equal(tree.root.findAllByType('VideoView').length, 0);
    await press(tree, '重新授权并加载原生播放器'); const beforeBackground = f.player.pauses;
    await f.appState('background'); assert.equal(f.player.source, null); assert.ok(f.player.pauses > beforeBackground);
    assert.equal(tree.root.findAllByType('VideoView').length, 0); assert.equal(buttons(tree, '重新授权并加载原生播放器').length, 0);
    await f.appState('active'); assert.equal(f.player.source, null); assert.equal(f.player.plays, 0);
    assert.equal(buttons(tree, '重新授权并加载原生播放器').length, 1);
  } finally { await close(tree); }
  assert.equal(f.callbacks.size, 0); assert.equal(f.appListeners.size, 0);
});

test('metadata authorization completing after background entry cannot restore a cleared playback source', async () => {
  const pending = deferred(), f = fixture(() => pending.promise), tree = await render(f.MediaPreview, { id: 'media-a', petId: 'pet-a' }); let running;
  try {
    await change(() => { running = buttons(tree, '重新授权并加载原生播放器')[0].props.onPress(); });
    await f.appState('background');
    await change(async () => { pending.resolve({ id: 'media-a', pet_id: 'pet-a' }); await running; });
    await f.appState('active'); assert.equal(f.player.source, null); assert.equal(f.player.plays, 0);
    assert.equal(tree.root.findAllByType('VideoView').length, 0);
  } finally { await close(tree); }
});

test('a user A to B to A change discards earlier authorization even after native player recovery', async () => {
  const pending = deferred(), f = fixture(() => pending.promise), props = { id: 'media-a', petId: 'pet-a' };
  const tree = await render(f.MediaPreview, props); let running;
  try {
    await change(() => { running = buttons(tree, '重新授权并加载原生播放器')[0].props.onPress(); });
    await f.recreatePlayer();
    f.state.user = { id: 'user-b' }; await change(() => tree.update(React.createElement(f.MediaPreview, props)));
    f.state.user = { id: 'user-a' }; await change(() => tree.update(React.createElement(f.MediaPreview, props)));
    await change(async () => { pending.resolve({ id: 'media-a', pet_id: 'pet-a' }); await running; });
    assert.equal(f.player.source, null); assert.equal(tree.root.findAllByType('VideoView').length, 0);
  } finally { await close(tree); }
});
