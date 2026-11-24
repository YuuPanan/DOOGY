const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const ts = require('typescript');
const React = require('react');
const renderer = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mobile = path.resolve(__dirname, '../..');

// Run real screen/hooks with host elements; native SDK calls stay explicit test doubles.
function screenModule(file, state, overrides = {}) {
  const cache = new Map();
  const native = Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'KeyboardAvoidingView', 'ActivityIndicator', 'RefreshControl', 'Switch', 'Image'].map(name => [name, name]));
  Object.assign(native, { Platform: { OS: 'android', select: value => value.android ?? value.default },
    StyleSheet: { create: value => value, hairlineWidth: 1 }, Alert: { alert() {} },
    Linking: { openURL: async () => {}, canOpenURL: async () => true },
    Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} }, Dimensions: { get: () => ({ width: 400, height: 800 }) },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, findNodeHandle: () => 1 });
  const mocks = { 'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '@react-navigation/native': { useIsFocused: () => true, useFocusEffect: effect => React.useEffect(effect, [effect]) },
    'expo-crypto': { randomUUID: crypto.randomUUID },
    'expo-image-picker': { launchImageLibraryAsync: async () => ({ canceled: true }), requestMediaLibraryPermissionsAsync: async () => ({ granted: true }) },
    'expo-document-picker': { getDocumentAsync: async () => ({ canceled: true }) },
    'expo-clipboard': { setStringAsync: async () => {} }, ...overrides };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    if (state !== null && filename === path.join(mobile, 'src/state/AppContext.tsx')) return { useApp: () => typeof state === 'function' ? state() : state };
    if (filename === path.join(mobile, 'src/ui/MediaPreview.tsx') && filename !== path.resolve(mobile, file)) return { MediaPreview: () => React.createElement('MediaPreview') };
    const module = { exports: {} }; cache.set(filename, module);
    const local = createRequire(filename);
    const requireMock = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      const base = path.resolve(path.dirname(filename), name);
      const resolved = name.startsWith('.')
        ? [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(candidate => fs.existsSync(candidate)) ?? local.resolve(name)
        : local.resolve(name);
      if (resolved.startsWith(path.join(mobile, 'src') + path.sep) && /\.tsx?$/.test(resolved)) return load(resolved);
      return local(name);
    };
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    new Function('require', 'module', 'exports', '__filename', '__dirname', code)(requireMock, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  return load(path.resolve(mobile, file));
}
async function render(Component, props = {}) {
  let tree; await renderer.act(async () => { tree = renderer.create(React.createElement(Component, props)); }); return tree;
}
async function change(run) { await renderer.act(async () => { await run(); }); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
module.exports = { React, act: renderer.act, screenModule, render, change, deferred };
