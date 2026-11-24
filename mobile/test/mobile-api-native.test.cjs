const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const Module = require('node:module');
const { createHash } = require('node:crypto');

const TTL = 30 * 60 * 1000, MAX_BYTES = 64 * 1024 * 1024;
const ROOT = 'file:///synthetic-native-cache', OWN = `${ROOT}/doogy-shares`;
const NOW = 1795510800000;
const realNow = Date.now;
const cachedName = (time, n = 1) => `${time}-00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}-synthetic.txt`;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t, transport, options = {}) {
  const writeStarted = deferred(), shareStarted = deferred(), entries = new Map([[ROOT, { directory: true }]]);
  const files = [], events = [], shares = [], stored = [];
  let now = options.now ?? NOW, uuid = 100, listError = options.listError, deleteError;
  Date.now = () => now; t.after(() => { Date.now = realNow; });
  const join = parts => parts.map(part => typeof part === 'string' ? part.replace(/\/$/, '') : part.uri).join('/');
  class NativeFile {
    constructor(...parts) { this.uri = join(parts); }
    get name() { return this.uri.slice(this.uri.lastIndexOf('/') + 1); }
    get exists() { return entries.has(this.uri); }
    get size() { return entries.get(this.uri)?.size ?? 0; }
    create() {
      assert.equal(this.exists, false, 'cache files must never overwrite an earlier export');
      assert.equal(entries.has(this.uri.slice(0, this.uri.lastIndexOf('/'))), true);
      entries.set(this.uri, { size: 0, bytes: null }); files.push(this); events.push('create');
    }
    write(bytes) {
      events.push('write:start'); writeStarted.resolve();
      const completion = (options.writeGate?.promise ?? Promise.resolve()).then(() => {
        // Model SDK native IO recreating a file if deletion happened before its delayed write.
        assert.equal(entries.has(this.uri.slice(0, this.uri.lastIndexOf('/'))), true);
        entries.set(this.uri, { size: bytes.byteLength, bytes: Buffer.from(bytes) }); events.push('write:complete');
      });
      completion.catch(() => {}); return completion;
    }
    delete() { if (deleteError) throw deleteError; assert.equal(this.exists, true); entries.delete(this.uri); events.push('delete'); }
  }
  class NativeDirectory {
    constructor(...parts) { this.uri = join(parts); }
    get exists() { return entries.has(this.uri); }
    create(config) { assert.deepEqual(config, { idempotent: true }); entries.set(this.uri, { directory: true }); }
    list() {
      if (listError) throw listError;
      return [...entries].filter(([uri]) => uri.startsWith(this.uri + '/') && !uri.slice(this.uri.length + 1).includes('/'))
        .map(([uri, value]) => value.directory ? new NativeDirectory(uri) : new NativeFile(uri));
    }
    delete() { throw new Error('recursive directory deletion is forbidden'); }
  }
  for (const entry of options.seed ?? []) {
    const uri = entry.uri ?? `${OWN}/${cachedName(entry.time ?? now, entry.id)}`;
    entries.set(uri.slice(0, uri.lastIndexOf('/')), { directory: true });
    entries.set(uri, { bytes: Buffer.from('seed'), size: 4, ...entry });
  }
  const stubs = {
    'expo-file-system': { File: NativeFile, Directory: NativeDirectory, Paths: { cache: ROOT } },
    'expo-sharing': {
      isAvailableAsync: async () => { events.push('sharing:available'); return options.available !== false; },
      shareAsync: async (uri, config) => {
        events.push('share:start'); shares.push({ uri, options: config }); shareStarted.resolve();
        if (options.shareError) throw options.shareError;
        await options.shareGate?.promise; events.push('share:complete');
      },
    },
    'react-native': { Platform: { OS: 'android' } },
    'expo-crypto': {
      randomUUID: () => `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12, '0')}`,
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digestStringAsync: async (_algorithm, content) => createHash('sha256').update(content).digest('hex'),
    },
  };
  const modules = ['mobileApi', 'shareCache'].map(name => require.resolve(`../.test-dist/${name}.js`)), originalLoad = Module._load;
  for (const path of modules) delete require.cache[path];
  let MobileApi;
  try {
    Module._load = function (request, ...args) { return Object.hasOwn(stubs, request) ? stubs[request] : originalLoad.call(this, request, ...args); };
    ({ MobileApi } = require(modules[0]));
  } finally { Module._load = originalLoad; for (const path of modules) delete require.cache[path]; }
  const api = new MobileApi('https://native-test.example.invalid', { read: async () => null, write: async token => { stored.push(token); } }, undefined, transport);
  return { api, writeStarted, shareStarted, files, events, shares, entries, stored,
    advance: ms => { now += ms; }, failList: error => { listError = error; }, failDelete: error => { deleteError = error; },
    read: uri => { assert.equal(entries.has(uri), true, 'receiver can still open the shared URI'); return entries.get(uri).bytes; } };
}
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const login = f => f.api.setSession({ access_token: 'native-access', refresh_token: 'native-refresh' });

test('native download awaits write and keeps readable bytes after chooser completion', { timeout: 5000 }, async t => {
  const writeGate = deferred(), shareGate = deferred(), payload = Buffer.from('synthetic attachment bytes');
  const f = fixture(t, async (_url, options) => {
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer native-access');
    return new Response(payload, { headers: { 'content-type': 'application/pdf' } });
  }, { writeGate, shareGate });
  await login(f);
  const operation = f.api.download('/care-attachments/synthetic/content', 'attachment.pdf'); operation.catch(() => {});
  t.after(async () => { writeGate.resolve(); shareGate.resolve(); await operation.catch(() => {}); });
  await f.writeStarted.promise; await new Promise(setImmediate);
  assert.deepEqual(f.events, ['create', 'write:start']); assert.equal(f.shares.length, 0);
  writeGate.resolve(); await f.shareStarted.promise;
  assert.deepEqual(f.read(f.shares[0].uri), payload);
  assert.deepEqual(f.shares, [{ uri: f.files[0].uri, options: { mimeType: 'application/pdf' } }]);
  shareGate.resolve(); await operation;
  assert.deepEqual(f.read(f.shares[0].uri), payload);
  assert.deepEqual(f.events, ['create', 'write:start', 'write:complete', 'sharing:available', 'share:start', 'share:complete']);
});

test('write failure is returned, never shares and removes its temporary file', { timeout: 5000 }, async t => {
  const writeGate = deferred(), f = fixture(t, async () => new Response('synthetic data'), { writeGate });
  await login(f);
  const operation = f.api.download('/care-attachments/synthetic/content', 'failed.txt'); operation.catch(() => {});
  await f.writeStarted.promise;
  const failure = new Error('Synthetic native disk failure'); writeGate.reject(failure);
  await assert.rejects(operation, error => error === failure);
  assert.deepEqual(f.events, ['create', 'write:start', 'delete']); assert.equal(f.shares.length, 0); assert.equal(f.files[0].exists, false);
});

test('native UTF-8 account export also awaits the write and remains readable after sharing', { timeout: 5000 }, async t => {
  const writeGate = deferred(), manifest = { personal_sections: ['profile'], households: [], generated_at: '2026-11-24T12:00:00.000Z' };
  const f = fixture(t, async url => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/auth/data-export') return json(manifest);
    assert.equal(path, '/api/v1/auth/data-export/profile');
    return json({ section: 'profile', household_id: null, generated_at: manifest.generated_at, items: [{ display_name: '原生文件测试' }], next_cursor: null });
  }, { writeGate });
  await login(f);
  const operation = f.api.exportAccount(); operation.catch(() => {});
  await f.writeStarted.promise; assert.equal(f.shares.length, 0);
  writeGate.resolve(); const result = await operation;
  const lines = f.read(f.shares[0].uri).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[1].data.display_name, '原生文件测试'); assert.equal(lines.at(-1).type, 'complete');
  assert.equal(f.shares[0].options.mimeType, 'application/x-ndjson'); assert.equal(result.total_records, 1);
});

test('startup and next download clean at exactly 30 minutes, only owned direct files', async t => {
  const expired = `${OWN}/${cachedName(NOW - TTL)}`, fresh = `${OWN}/${cachedName(NOW - TTL + 1, 2)}`;
  const unrelated = `${ROOT}/another-module/${cachedName(NOW - TTL)}`, unknown = `${OWN}/keep.txt`;
  const nested = `${OWN}/nested/${cachedName(NOW - TTL)}`, namedDirectory = `${OWN}/${cachedName(NOW - TTL, 3)}`;
  const f = fixture(t, async () => new Response('next'), { seed: [{ uri: expired }, { uri: fresh }, { uri: unrelated }, { uri: unknown }, { uri: nested }, { uri: namedDirectory, directory: true }] });
  assert.equal(f.entries.has(expired), false); assert.equal(f.entries.has(fresh), true);
  await login(f); f.advance(1); await f.api.download('/synthetic', 'next.txt');
  assert.equal(f.entries.has(fresh), false);
  for (const uri of [unrelated, unknown, nested, namedDirectory]) assert.equal(f.entries.has(uri), true, uri);
});

test('cache cleanup failure never blocks client startup, but the next export reports it', async t => {
  const failure = new Error('Synthetic inaccessible cache'), f = fixture(t, async () => new Response('next'), { listError: failure, seed: [{ time: NOW - TTL }] });
  await login(f); assert.equal(f.api.accessToken, 'native-access');
  await assert.rejects(f.api.download('/synthetic', 'next.txt'), error => error === failure);
  assert.equal(f.shares.length, 0);
});

test('eight retained exports fill the cache; same names/time never reuse or evict a shared file', async t => {
  const f = fixture(t, async () => new Response('retained bytes')); await login(f);
  for (let n = 0; n < 8; n++) await f.api.download('/synthetic', '../../same.txt');
  assert.equal(new Set(f.shares.map(share => share.uri)).size, 8);
  for (const share of f.shares) { assert.ok(share.uri.startsWith(OWN + '/')); assert.deepEqual(f.read(share.uri), Buffer.from('retained bytes')); }
  await assert.rejects(f.api.download('/synthetic', 'ninth.txt'), /最多 8 个文件.*服务端导出/);
  assert.equal(f.shares.length, 8); assert.equal(f.events.includes('delete'), false);
  f.advance(TTL); await f.api.download('/synthetic', 'after-expiry.txt');
  assert.equal(f.files.filter(file => file.exists).length, 1);
});

test('64 MiB total boundary is allowed and the next byte is rejected without eviction', async t => {
  const original = `${OWN}/${cachedName(NOW)}`, f = fixture(t, async () => new Response('x'), { seed: [{ uri: original, size: MAX_BYTES - 1 }] });
  await login(f); await f.api.download('/synthetic', 'last-byte.txt');
  await assert.rejects(f.api.download('/synthetic', 'over-limit.txt'), /64 MiB.*服务端导出/);
  assert.equal(f.entries.get(original).size, MAX_BYTES - 1); assert.equal(f.shares.length, 1); assert.equal(f.events.includes('delete'), false);
});

test('a single oversized file is rejected before creating a cache file', async t => {
  const f = fixture(t, async () => new Response(new Uint8Array(MAX_BYTES + 1))); await login(f);
  await assert.rejects(f.api.download('/synthetic', 'too-large.bin'), /超过本机 64 MiB.*服务端导出/);
  assert.equal(f.files.length, 0); assert.equal(f.shares.length, 0);
});

test('pending async writes reserve their full bytes against concurrent exports', { timeout: 5000 }, async t => {
  const writeGate = deferred(), f = fixture(t, async () => new Response('four'), { writeGate, seed: [{ size: MAX_BYTES - 6 }] });
  await login(f);
  const first = f.api.download('/synthetic', 'first.txt'); first.catch(() => {});
  t.after(async () => { writeGate.resolve(); await first.catch(() => {}); });
  await f.writeStarted.promise;
  await assert.rejects(f.api.download('/synthetic', 'second.txt'), /缓存已满/);
  assert.equal(f.files.length, 1); writeGate.resolve(); await first; assert.equal(f.shares.length, 1);
});

test('clear invalidates the session immediately, awaits delayed IO and prevents file revival/sharing', { timeout: 5000 }, async t => {
  const writeGate = deferred(), f = fixture(t, async () => new Response('old session'), { writeGate }); await login(f);
  const operation = f.api.download('/synthetic', 'old.txt'); operation.catch(() => {});
  t.after(async () => { writeGate.resolve(); await operation.catch(() => {}); });
  await f.writeStarted.promise;
  let cleared = false; const clearing = f.api.clear().then(() => { cleared = true; });
  assert.equal(f.api.accessToken, null); await new Promise(setImmediate); assert.equal(cleared, false);
  writeGate.resolve(); await assert.rejects(operation, error => error.code === 'SESSION_CHANGED'); await clearing;
  assert.equal(f.files[0].exists, false); assert.equal(f.shares.length, 0); assert.equal(f.stored.at(-1), null);
});

test('logout removes only owned files, even while the chooser is open, and later login uses a new file', { timeout: 5000 }, async t => {
  const shareGate = deferred(), unrelated = `${ROOT}/unrelated-private.txt`, unknown = `${OWN}/keep.txt`;
  const f = fixture(t, async url => new URL(url).pathname.endsWith('/auth/logout') ? json({ ok: true }) : new Response('session bytes'), { shareGate, seed: [{ uri: unrelated }, { uri: unknown }] });
  await login(f); const operation = f.api.download('/synthetic', 'same.txt'); operation.catch(() => {});
  t.after(async () => { shareGate.resolve(); await operation.catch(() => {}); });
  await f.shareStarted.promise; await f.api.logout();
  assert.equal(f.files[0].exists, false); assert.equal(f.entries.has(unrelated), true); assert.equal(f.entries.has(unknown), true);
  assert.equal(f.api.accessToken, null); shareGate.resolve(); await operation;
  await login(f); await f.api.download('/synthetic', 'same.txt');
  assert.notEqual(f.shares[0].uri, f.shares[1].uri); assert.equal(f.files[1].exists, true);
  await f.api.clear(); assert.equal(f.files[1].exists, false); await f.api.clear();
});

test('unavailable sharing and pre-launch SDK rejection immediately remove the prepared file', async t => {
  const unavailable = fixture(t, async () => new Response('prepared'), { available: false }); await login(unavailable);
  await assert.rejects(unavailable.api.download('/synthetic', 'unavailable.txt'), /本机未提供/);
  assert.equal(unavailable.files[0].exists, false); assert.equal(unavailable.shares.length, 0);
  const failure = new Error('Synthetic chooser launch failure'), rejected = fixture(t, async () => new Response('prepared'), { shareError: failure }); await login(rejected);
  await assert.rejects(rejected.api.download('/synthetic', 'rejected.txt'), error => error === failure);
  assert.equal(rejected.files[0].exists, false);
});

test('explicit clear still clears credentials if cache deletion reports a disk error', async t => {
  const f = fixture(t, async () => new Response('prepared')); await login(f); await f.api.download('/synthetic', 'retained.txt');
  const failure = new Error('Synthetic cache delete failure'); f.failDelete(failure);
  await assert.rejects(f.api.clear(), error => error === failure);
  assert.equal(f.api.accessToken, null); assert.equal(f.stored.at(-1), null); assert.equal(f.files[0].exists, true);
  f.failDelete(); await f.api.clear(); assert.equal(f.files[0].exists, false);
});
