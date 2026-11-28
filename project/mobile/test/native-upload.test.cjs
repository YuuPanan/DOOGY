const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const babel = require('@babel/core');
const { screenModule } = require('./helpers/render-screen.cjs');

const mobile = path.resolve(__dirname, '..'), modules = new Map();
// Execute the installed SDK implementations. Only filesystem native IO is stubbed below.
function sdkModule(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} }; modules.set(filename, module);
  const local = createRequire(filename), source = fs.readFileSync(filename, 'utf8');
  const code = filename.endsWith('.ts')
    ? ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    : babel.transformSync(source, { filename, configFile: false, babelrc: false,
      plugins: [require.resolve('@babel/plugin-transform-flow-strip-types'), require.resolve('@babel/plugin-transform-modules-commonjs')] }).code;
  const requireSdk = name => {
    if (!name.startsWith('.')) return local(name);
    const base = path.resolve(path.dirname(filename), name);
    return sdkModule([base, base + '.ts', base + '.js'].find(file => fs.existsSync(file) && fs.statSync(file).isFile()));
  };
  new Function('require', 'module', 'exports', code)(requireSdk, module, module.exports);
  return module.exports;
}
const NativeFormData = sdkModule(path.join(mobile, 'node_modules/react-native/Libraries/Network/FormData.js')).default;
const { installFormDataPatch } = sdkModule(path.join(mobile, 'node_modules/expo/src/winter/FormData.ts'));
const { convertFormDataAsync } = sdkModule(path.join(mobile, 'node_modules/expo/src/winter/fetch/convertFormData.ts'));
const ExpoFormData = installFormDataPatch(NativeFormData);
const origin = 'http://native-upload.example.invalid', uri = 'file:///owned-cache/generated-uuid.wav';
const source = { uri, name: 'original-owner-recording.wav', mimeType: 'audio/wav' };
const captured = '2026-11-24T13:00:00Z', fields = { captured_at: captured };
function wave() {
  const bytes = Buffer.alloc(16044); bytes.write('RIFF'); bytes.writeUInt32LE(16036, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
  return bytes;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(t, transport, platform = 'android') {
  const previousFormData = globalThis.FormData, documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.FormData = ExpoFormData; delete globalThis.document;
  t.after(() => { globalThis.FormData = previousFormData; if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor); else delete globalThis.document; });
  const bytes = wave(), reads = [], files = [];
  class NativeFile {
    constructor(value) { this.uri = value; this.name = 'generated-uuid.wav'; this.type = 'application/native-default'; files.push(this); }
    async bytes() { assert.equal(this.uri, uri); reads.push(this.uri); return new Uint8Array(bytes); }
  }
  const { MobileApi } = screenModule('src/lib/mobileApi.ts', null, { 'react-native': { Platform: { OS: platform } }, 'expo-file-system': { File: NativeFile },
    './shareCache': { cleanExpiredShares() {}, clearShares: async () => {}, shareCachedFile: async () => {} } });
  const api = new MobileApi(origin, { read: async () => null, write: async () => {} }, () => {}, transport);
  return { api, bytes, reads, files };
}
async function multipart(options) {
  return Buffer.from((await convertFormDataAsync(options.body, 'test-fixed-sdk-boundary')).body);
}

test('installed Expo converter rejects the former RN URI part before any network send', async () => {
  const body = new ExpoFormData(); body.append('file', { uri: source.uri, name: source.name, type: source.mimeType }); body.append('captured_at', captured);
  await assert.rejects(convertFormDataAsync(body), /Unsupported FormDataPart implementation/);
});

test('native upload reaches the installed Expo encoder with all 16044 bytes, original filename, MIME and capture field', async t => {
  let wire, sent;
  const f = fixture(t, async (url, options) => { sent = { url, options }; wire = await multipart(options); return json(201, { id: 'media-saved', pet_id: 'pet-a' }); });
  await f.api.setSession({ access_token: 'access-owner', refresh_token: 'refresh-owner' });
  assert.equal((await f.api.upload('/pets/pet-a/media', source, 'explicit-media-key', { fields })).id, 'media-saved');
  assert.equal(sent.url, origin + '/api/v1/pets/pet-a/media'); assert.equal(sent.options.method, 'POST');
  const headers = new Headers(sent.options.headers); assert.equal(headers.get('authorization'), 'Bearer access-owner');
  assert.equal(headers.get('idempotency-key'), 'explicit-media-key'); assert.equal(headers.get('content-type'), null);
  assert.ok(wire.includes(f.bytes)); assert.equal(f.bytes.length, 16044); assert.equal(f.reads.length, 1);
  const text = wire.toString('utf8'); assert.ok(text.includes('filename="original-owner-recording.wav"'));
  assert.ok(text.includes('content-type: audio/wav\r\n')); assert.ok(text.includes('name="captured_at"\r\n\r\n' + captured));
  assert.ok(!text.includes('generated-uuid.wav')); assert.ok(!text.includes('file:///'));
});

test('a failed native upload retries identical multipart content with the same generated idempotency key', async t => {
  const attempts = [];
  const f = fixture(t, async (_url, options) => { attempts.push({ key: new Headers(options.headers).get('idempotency-key'), wire: await multipart(options) });
    if (attempts.length === 1) throw new TypeError('Synthetic connection failure after serialization'); return json(201, { id: 'same-upload' }); });
  await f.api.setSession({ access_token: 'access-owner', refresh_token: 'refresh-owner' });
  await assert.rejects(f.api.upload('/pets/pet-a/media', source, undefined, { fields }), error => error.code === 'NETWORK_ERROR');
  assert.equal((await f.api.upload('/pets/pet-a/media', source, undefined, { fields })).id, 'same-upload');
  assert.equal(attempts.length, 2); assert.ok(attempts[0].key); assert.equal(attempts[1].key, attempts[0].key);
  assert.deepEqual(attempts[1].wire, attempts[0].wire); assert.equal(f.reads.length, 2);
});

test('401 refresh resends native PUT avatar bytes, expected_version and the same explicit key', async t => {
  const uploads = []; let refreshes = 0;
  const f = fixture(t, async (url, options) => {
    if (url.endsWith('/auth/refresh')) { refreshes++; assert.deepEqual(JSON.parse(options.body), { refresh_token: 'refresh-owner' }); return json(200, { access_token: 'access-new', refresh_token: 'refresh-new' }); }
    uploads.push({ url, method: options.method, headers: new Headers(options.headers), wire: await multipart(options) });
    return uploads.length === 1 ? json(401, { code: 'UNAUTHENTICATED' }) : json(200, { version: 2 });
  });
  await f.api.setSession({ access_token: 'access-owner', refresh_token: 'refresh-owner' });
  const result = await f.api.upload('/pets/pet-a/avatar', { ...source, name: 'owner-avatar.png', mimeType: 'image/png' }, 'same-avatar-key', { method: 'PUT', fields: { expected_version: '1' } });
  assert.equal(result.version, 2); assert.equal(refreshes, 1); assert.equal(uploads.length, 2);
  assert.equal(uploads[0].headers.get('authorization'), 'Bearer access-owner'); assert.equal(uploads[1].headers.get('authorization'), 'Bearer access-new');
  for (const attempt of uploads) { assert.equal(attempt.method, 'PUT'); assert.equal(attempt.url, origin + '/api/v1/pets/pet-a/avatar'); assert.equal(attempt.headers.get('idempotency-key'), 'same-avatar-key');
    const text = attempt.wire.toString('utf8'); assert.ok(text.includes('filename="owner-avatar.png"')); assert.ok(text.includes('content-type: image/png'));
    assert.ok(text.includes('name="expected_version"\r\n\r\n1')); assert.ok(attempt.wire.includes(f.bytes)); }
  assert.deepEqual(uploads[0].wire, uploads[1].wire);
});

test('web upload keeps the browser Blob path and does not open a native filesystem file', async t => {
  let wire;
  const f = fixture(t, async (_url, options) => { wire = await multipart(options); return json(201, { id: 'browser-upload' }); }, 'web');
  const originalFetch = globalThis.fetch; globalThis.document = {}; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async location => { assert.equal(location, uri); return new Response(f.bytes, { headers: { 'content-type': source.mimeType } }); };
  await f.api.setSession({ access_token: 'access-owner', refresh_token: 'refresh-owner' });
  assert.equal((await f.api.upload('/pets/pet-a/media', source, 'web-key', { fields })).id, 'browser-upload');
  assert.equal(f.files.length, 0); assert.ok(wire.includes(f.bytes)); assert.ok(wire.toString('utf8').includes('filename="original-owner-recording.wav"'));
});
