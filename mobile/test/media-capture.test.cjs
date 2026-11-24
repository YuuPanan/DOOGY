const assert = require('node:assert/strict');
const { test } = require('node:test');
const { React, screenModule, render, change, deferred } = require('./helpers/render-screen.cjs');

function fixture(options = {}) {
  const files = new Map(), deleted = [], modes = [], recordings = [], uploads = [], appListeners = new Set();
  let serial = 0, permissionCalls = 0, prepares = 0, stops = 0, listener, focused = true, picker = async () => ({ canceled: true }), permission = async () => ({ granted: true });
  const uri = (...parts) => parts.map(part => typeof part === 'string' ? part : part.uri).reduce((joined, part) => joined ? `${joined.replace(/\/$/, '')}/${part.replace(/^\//, '')}` : part, '');
  class Directory { constructor(...parts) { this.uri = uri(...parts); } create() {} }
  class File {
    constructor(...parts) { this.uri = uri(...parts); }
    get exists() { return files.has(this.uri); } get size() { return files.get(this.uri) ?? 0; }
    delete() { deleted.push(this.uri); files.delete(this.uri); }
    copy(destination) { files.set(destination.uri, this.size); }
  }
  const recorder = { uri: null, isRecording: false,
    prepareToRecordAsync: async () => { prepares++; recorder.uri = `file:///cache/Audio/recording-${++serial}.m4a`; files.set(recorder.uri, 1024); },
    record: value => { recordings.push(value); recorder.isRecording = true; },
    stop: async () => { stops++; if (recorder.isRecording) { recorder.isRecording = false; listener({ isFinished: true, hasError: false, error: null, url: recorder.uri }); } },
  };
  const audio = { RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } }, requestRecordingPermissionsAsync: async () => { permissionCalls++; return permission(); },
    setAudioModeAsync: async mode => { modes.push(mode); }, useAudioRecorder: (preset, callback) => { listener = callback; return recorder; },
    useAudioRecorderState: () => ({ durationMillis: recorder.isRecording ? 1000 : 59000, isRecording: recorder.isRecording }) };
  const native = { ...Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'KeyboardAvoidingView', 'ActivityIndicator', 'RefreshControl', 'Switch', 'Image'].map(name => [name, name])),
    Platform: { OS: 'android' }, StyleSheet: { create: value => value, hairlineWidth: 1 }, AppState: { currentState: 'active', addEventListener: (name, callback) => { appListeners.add(callback); return { remove: () => appListeners.delete(callback) }; } } };
  const firstPet = { id: 'pet-a', household_id: 'family-a', name: 'Synthetic A' }, secondPet = { id: 'pet-b', household_id: 'family-a', name: 'Synthetic B' };
  let state = { user: { id: 'user-a' }, pet: firstPet, pets: [firstPet, secondPet], households: [{ id: 'family-a', role: options.role ?? 'owner' }],
    api: { baseUrl: 'http://qa.invalid/api/v1', get: async () => ({ upload_enabled: options.enabled !== false, reason: options.enabled === false ? 'MEDIA_VALIDATOR_NOT_CONFIGURED' : null }),
      upload: async (...args) => { uploads.push(args); return options.upload ? options.upload(...args) : { id: 'saved-media', pet_id: state.pet.id, filename: args[1].name }; } } };
  const { MediaCapture } = screenModule('src/ui/MediaCapture.tsx', () => state, { 'react-native': native, 'expo-audio': audio,
    '@react-navigation/native': { useIsFocused: () => focused }, 'expo-file-system': { Directory, File, Paths: { cache: { uri: 'file:///cache' } } },
    'expo-document-picker': { getDocumentAsync: async request => picker(request) } });
  return { Component: MediaCapture, files, deleted, modes, recordings, uploads, recorder,
    setPermission(value) { permission = value; }, setPicker(value) { picker = value; },
    setPet(id) { state = { ...state, pet: state.pets.find(row => row.id === id) }; }, setFocus(value) { focused = value; },
    background(value) { for (const callback of appListeners) callback(value); }, finish() { recorder.isRecording = false; listener({ isFinished: true, hasError: false, error: null, url: recorder.uri }); },
    counts: () => ({ permissionCalls, prepares, stops }),
  };
}
function button(tree, title) { return tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === title); }
async function press(tree, title) { const node = button(tree, title); assert.ok(node, title); assert.ok(!node.props.disabled, title); await change(() => node.props.onPress()); }
const contents = tree => JSON.stringify(tree.toJSON());
async function close(tree) { await change(() => tree.unmount()); }
async function pickFile(f, tree, name = 'synthetic.wav', source = 'content://provider/original.wav', size = 4096) {
  f.files.set(source, size); f.setPicker(async () => ({ canceled: false, assets: [{ uri: source, name, size }] }));
  await press(tree, '从本机导入音频或 MP4');
}
async function time(tree) { await change(() => tree.root.findByProps({ accessibilityLabel: '片段实际采集开始时间 ISO（含时区）' }).props.onChangeText('2026-11-24T10:00:00+08:00')); }

test('microphone denial and cancelled import do not record, upload, or claim success', async () => {
  const f = fixture(); f.setPermission(async () => ({ granted: false }));
  const tree = await render(f.Component, { petId: 'pet-a', onSaved() { throw new Error('Must not save'); } });
  try {
    await press(tree, '请求麦克风权限并开始录音'); assert.ok(contents(tree).includes('未获得麦克风权限'));
    assert.equal(f.counts().prepares, 0); assert.equal(f.recordings.length, 0);
    await press(tree, '从本机导入音频或 MP4'); assert.equal(f.uploads.length, 0); assert.equal(f.files.size, 0);
  } finally { await close(tree); }
});

test('manual stop and native 59-second completion create only an explicit pending upload draft', async () => {
  for (const mode of ['manual', 'native-limit']) {
    const f = fixture(), saved = [], tree = await render(f.Component, { petId: 'pet-a', onSaved: value => saved.push(value) });
    try {
      await press(tree, '请求麦克风权限并开始录音'); assert.deepEqual(f.recordings, [{ forDuration: 59 }]);
      assert.ok(f.modes.some(mode => mode.allowsRecording && mode.allowsBackgroundRecording === false && mode.shouldPlayInBackground === false));
      if (mode === 'manual') await press(tree, '停止录音，保留待上传草稿'); else await change(() => f.finish());
      assert.ok(button(tree, '确认上传此片段')); assert.equal(f.uploads.length, 0); assert.equal(saved.length, 0);
      await press(tree, '确认上传此片段'); assert.equal(saved.length, 1); assert.equal(f.uploads[0][0], '/pets/pet-a/media');
      assert.equal(f.uploads[0][1].mimeType, 'audio/mp4'); assert.ok(Number.isFinite(Date.parse(f.uploads[0][3].fields.captured_at)));
      assert.equal(f.files.size, 0);
    } finally { await close(tree); }
  }
});

test('import checks 20 MiB and real capture time; failed upload preserves the same key, fields, and file', async () => {
  let attempts = 0; const f = fixture({ upload: async () => { if (++attempts === 1) throw new Error('Synthetic upload unavailable'); return { id: 'saved', pet_id: 'pet-a' }; } }), saved = [];
  const tree = await render(f.Component, { petId: 'pet-a', onSaved: value => saved.push(value) });
  try {
    await pickFile(f, tree, 'large.mp4', 'content://provider/large.mp4', 20971521); assert.ok(contents(tree).includes('超过 20 MiB')); assert.equal(f.uploads.length, 0);
    await pickFile(f, tree); await press(tree, '确认上传此片段'); assert.equal(f.uploads.length, 0); assert.ok(contents(tree).includes('请填写片段实际采集开始时间'));
    await time(tree); await press(tree, '确认上传此片段'); assert.ok(contents(tree).includes('Synthetic upload unavailable'));
    assert.equal(tree.root.findByProps({ accessibilityLabel: '片段实际采集开始时间 ISO（含时区）' }).props.editable, false);
    await press(tree, '重试上传同一草稿'); assert.equal(saved.length, 1); assert.equal(f.uploads.length, 2);
    assert.deepEqual(f.uploads[0], f.uploads[1]); assert.equal(f.uploads[0][3].fields.captured_at, '2026-11-24T10:00:00+08:00');
    assert.equal(f.files.has('content://provider/original.wav'), true); assert.ok(!f.deleted.some(uri => uri.startsWith('content:')));
    assert.equal([...f.files.keys()].filter(uri => uri.includes('doogy-media-capture')).length, 0);
  } finally { await close(tree); }
});

test('cancelling while microphone permission is pending prevents a late recording start', async () => {
  const pending = deferred(), f = fixture(); f.setPermission(() => pending.promise); let running;
  const tree = await render(f.Component, { petId: 'pet-a', onSaved() {} });
  try {
    await change(() => { running = button(tree, '请求麦克风权限并开始录音').props.onPress(); });
    await press(tree, '取消并清理本机草稿');
    await change(async () => { pending.resolve({ granted: true }); await running; });
    assert.equal(f.counts().prepares, 0); assert.equal(f.recordings.length, 0); assert.ok(!button(tree, '确认上传此片段'));
  } finally { await close(tree); }
});

test('switching pets during upload drops its late callback and removes only owned temporary files', async () => {
  const pending = deferred(), f = fixture({ upload: () => pending.promise }), saved = []; let running;
  const tree = await render(f.Component, { petId: 'pet-a', onSaved: value => saved.push(value) });
  try {
    await pickFile(f, tree); await time(tree);
    await change(() => { running = button(tree, '确认上传此片段').props.onPress(); });
    f.setPet('pet-b'); await change(() => tree.update(React.createElement(f.Component, { petId: 'pet-b', onSaved: value => saved.push(value) })));
    await change(async () => { pending.resolve({ id: 'old-upload', pet_id: 'pet-a' }); await running; });
    assert.equal(saved.length, 0); assert.ok(!contents(tree).includes('old-upload')); assert.ok(!button(tree, '重试上传同一草稿'));
    assert.equal([...f.files.keys()].filter(uri => uri.includes('doogy-media-capture')).length, 0); assert.ok(f.files.has('content://provider/original.wav'));
  } finally { await close(tree); }
});

test('background and leaving the page stop recording and discard its local file instead of resuming', async () => {
  for (const reason of ['background', 'blur']) {
    const f = fixture(), tree = await render(f.Component, { petId: 'pet-a', onSaved() {} });
    try {
      await press(tree, '请求麦克风权限并开始录音');
      await change(() => { if (reason === 'background') f.background('background'); else { f.setFocus(false); tree.update(React.createElement(f.Component, { petId: 'pet-a', onSaved() {} })); } });
      assert.ok(f.counts().stops > 0); assert.equal(f.recorder.isRecording, false); assert.equal(f.files.size, 0); assert.ok(!button(tree, '确认上传此片段'));
      assert.ok(button(tree, '请求麦克风权限并开始录音').props.disabled);
    } finally { await close(tree); }
  }
});

test('a document picker foreground handoff can finish, and cancellation clears its requested cache copy', async () => {
  const pending = deferred(), f = fixture(); f.setPicker(() => pending.promise); let running;
  const tree = await render(f.Component, { petId: 'pet-a', onSaved() {} });
  try {
    await change(() => { running = button(tree, '从本机导入音频或 MP4').props.onPress(); });
    await change(() => f.background('background')); f.files.set('file:///cache/DocumentPicker/owned.mp3', 1024);
    await change(async () => { f.background('active'); pending.resolve({ canceled: false, assets: [{ name: 'owned.mp3', uri: 'file:///cache/DocumentPicker/owned.mp3', size: 1024 }] }); await running; });
    assert.ok(button(tree, '确认上传此片段')); await press(tree, '取消并清理本机草稿');
    assert.equal(f.files.size, 0); assert.equal(f.uploads.length, 0); assert.ok(f.deleted.includes('file:///cache/DocumentPicker/owned.mp3'));
  } finally { await close(tree); }
});

test('read-only households and an unavailable validator do not request microphone permission', async () => {
  for (const options of [{ role: 'viewer' }, { enabled: false }]) {
    const f = fixture(options), tree = await render(f.Component, { petId: 'pet-a', onSaved() {} });
    try {
      const start = button(tree, '请求麦克风权限并开始录音'); assert.ok(!start || start.props.disabled);
      assert.equal(f.counts().permissionCalls, 0); assert.equal(f.recordings.length, 0);
    } finally { await close(tree); }
  }
});
