const { strict: assert } = require('node:assert');
const { test: nodeTest } = require('node:test');
const { ApiClient, ApiError } = require('../.test-dist/client.js');
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);

const origin = 'https://mobile-test.example.invalid';
const session = name => ({ access_token: `access-${name}`, refresh_token: `refresh-${name}` });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthorized = () => json(401, { code: 'UNAUTHENTICATED', message: 'Synthetic access expired' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(transport) {
  let saved = null, expired = 0;
  const writes = [];
  const store = { read: async () => saved, write: async token => { writes.push(token); saved = token; } };
  const client = new ApiClient(origin, store, () => expired++, transport);
  return { client, writes, saved: () => saved, expired: () => expired };
}
const authorization = options => new Headers(options.headers).get('authorization');
const idempotency = options => new Headers(options.headers).get('idempotency-key');
const isCode = code => error => error instanceof ApiError && error.code === code;

test('default transport calls browser fetch with its global receiver', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = function () { assert.equal(this, globalThis); return Promise.resolve(json(200, { status: 'ok' })); };
  try {
    const client = new ApiClient(origin, { read: async () => null, write: async () => {} });
    assert.deepEqual(await client.get('/health'), { status: 'ok' });
  } finally { globalThis.fetch = saved; }
});

test('signed-out health checks are public and never send or refresh authentication', async () => {
  const calls = [];
  const f = fixture(async (url, options) => {
    calls.push(url); assert.equal(new URL(url).pathname, '/api/v1/health');
    assert.equal(authorization(options), null); assert.equal(idempotency(options), null);
    return json(200, { status: 'ok', mode: 'offline', database: 'sqlite' });
  });
  assert.equal((await f.client.get('/health?probe=mobile')).status, 'ok');
  await assert.rejects(f.client.get('/auth/me'), isCode('SESSION_CHANGED'));
  assert.equal(calls.length, 1); assert.equal(f.saved(), null); assert.deepEqual(f.writes, []); assert.equal(f.expired(), 0);
});

test('401 refresh rotates the stored session once and retries with the new access token', async () => {
  const calls = [];
  const f = fixture(async (url, options) => {
    calls.push({ url, auth: authorization(options), body: options.body });
    if (url.endsWith('/auth/refresh')) {
      assert.deepEqual(JSON.parse(options.body), { refresh_token: 'refresh-old' });
      assert.equal(authorization(options), null);
      return json(200, session('new'));
    }
    return authorization(options) === 'Bearer access-old' ? unauthorized() : json(200, { id: 'same-user' });
  });
  await f.client.setSession(session('old'));
  assert.deepEqual(await f.client.get('/auth/me'), { id: 'same-user' });
  assert.deepEqual(calls.map(call => call.auth), ['Bearer access-old', null, 'Bearer access-new']);
  assert.equal(f.saved(), 'refresh-new'); assert.equal(f.client.accessToken, 'access-new'); assert.equal(f.expired(), 0);
});

test('an uncertain network mutation reuses its key; success ends that intent and changed content gets a new key', async () => {
  const keys = [], bodies = [];
  const f = fixture(async (_url, options) => {
    keys.push(idempotency(options)); bodies.push(options.body);
    if (keys.length === 1) throw new TypeError('Synthetic connection lost after request transmission');
    return json(201, { id: `operation-${keys.length}` });
  });
  await f.client.setSession(session('owner'));
  await assert.rejects(f.client.post('/pets', { name: 'First pet' }), isCode('NETWORK_ERROR'));
  await f.client.post('/pets', { name: 'First pet' });
  await f.client.post('/pets', { name: 'First pet' });
  await f.client.post('/pets', { name: 'Different pet' });
  assert.ok(keys.every(key => typeof key === 'string' && key.length > 0));
  assert.equal(keys[0], keys[1]); assert.equal(bodies[0], bodies[1]);
  assert.notEqual(keys[1], keys[2]); assert.notEqual(keys[2], keys[3]);
});

test('concurrent old-token 401 responses share one refresh, including a late 401 after rotation', async () => {
  const oldA = deferred(), oldB = deferred(), refreshEntered = deferred(), refreshResponse = deferred();
  const reads = [], oldEntered = deferred(); let oldRequests = 0, refreshes = 0;
  const f = fixture(async (url, options) => {
    if (url.endsWith('/auth/refresh')) { refreshes++; refreshEntered.resolve(); return refreshResponse.promise; }
    const path = new URL(url).pathname;
    reads.push({ path, auth: authorization(options) });
    if (authorization(options) === 'Bearer access-old') {
      if (++oldRequests === 2) oldEntered.resolve();
      return path.endsWith('/one') ? oldA.promise : oldB.promise;
    }
    assert.equal(authorization(options), 'Bearer access-new'); return json(200, { path });
  });
  await f.client.setSession(session('old'));
  const first = f.client.get('/one'), second = f.client.get('/two'); await oldEntered.promise;
  oldA.resolve(unauthorized()); await refreshEntered.promise;
  refreshResponse.resolve(json(200, session('new'))); await first;
  oldB.resolve(unauthorized()); await second;
  assert.equal(refreshes, 1); assert.equal(reads.filter(row => row.auth === 'Bearer access-new').length, 2);
  assert.equal(f.saved(), 'refresh-new'); assert.equal(f.expired(), 0);
});

test('two simultaneous 401 responses wait for the same in-flight refresh', async () => {
  const refreshEntered = deferred(), refreshResponse = deferred(); let refreshes = 0, oldRequests = 0, newRequests = 0;
  const f = fixture(async (url, options) => {
    if (url.endsWith('/auth/refresh')) { refreshes++; refreshEntered.resolve(); return refreshResponse.promise; }
    if (authorization(options) === 'Bearer access-old') { oldRequests++; return unauthorized(); }
    newRequests++; return json(200, { ok: true });
  });
  await f.client.setSession(session('old'));
  const requests = [f.client.get('/one'), f.client.get('/two')]; await refreshEntered.promise;
  assert.equal(oldRequests, 2); assert.equal(refreshes, 1);
  refreshResponse.resolve(json(200, session('new'))); await Promise.all(requests);
  assert.equal(refreshes, 1); assert.equal(newRequests, 2);
});

test('a stale account A 401 never replays its mutation using account B', async () => {
  const firstResponse = deferred(), entered = deferred(); let requests = 0, refreshes = 0, effectsForB = 0;
  const f = fixture(async (url, options) => {
    if (url.endsWith('/auth/refresh')) { refreshes++; return json(200, session('unexpected')); }
    requests++;
    if (authorization(options) === 'Bearer access-B') { effectsForB++; return json(201, { id: 'must-not-be-created' }); }
    assert.equal(authorization(options), 'Bearer access-A'); entered.resolve(); return firstResponse.promise;
  });
  await f.client.setSession(session('A'));
  const outcome = assert.rejects(f.client.post('/pets', { name: 'Account A draft' }), isCode('SESSION_CHANGED'));
  await entered.promise; await f.client.setSession(session('B')); firstResponse.resolve(unauthorized()); await outcome;
  assert.equal(requests, 1); assert.equal(refreshes, 0); assert.equal(effectsForB, 0);
  assert.equal(f.saved(), 'refresh-B'); assert.equal(f.client.accessToken, 'access-B'); assert.equal(f.expired(), 0);
});

test('a second 401 from an older request cannot clear a newly signed-in session', async () => {
  const retryEntered = deferred(), retryResponse = deferred(); let calls = 0;
  const f = fixture(async (url, options) => {
    if (url.endsWith('/auth/refresh')) return json(200, session('A-refreshed'));
    calls++;
    if (calls === 1) return unauthorized();
    assert.equal(authorization(options), 'Bearer access-A-refreshed'); retryEntered.resolve(); return retryResponse.promise;
  });
  await f.client.setSession(session('A'));
  const outcome = assert.rejects(f.client.get('/auth/me'), isCode('SESSION_CHANGED'));
  await retryEntered.promise; await f.client.setSession(session('B')); retryResponse.resolve(unauthorized()); await outcome;
  assert.equal(calls, 2); assert.equal(f.saved(), 'refresh-B'); assert.equal(f.client.accessToken, 'access-B'); assert.equal(f.expired(), 0);
});

for (const failure of ['network', '503']) test(`transient refresh ${failure} preserves the refresh token for a later retry`, async () => {
  let refreshes = 0;
  const f = fixture(async (url, options) => {
    if (url.endsWith('/auth/refresh')) {
      assert.deepEqual(JSON.parse(options.body), { refresh_token: 'refresh-old' });
      if (++refreshes === 1) {
        if (failure === 'network') throw new TypeError('Synthetic offline connection');
        return json(503, { code: 'TEMPORARILY_UNAVAILABLE', message: 'Synthetic retry later' });
      }
      return json(200, session('new'));
    }
    return authorization(options) === 'Bearer access-new' ? json(200, { recovered: true }) : unauthorized();
  });
  await f.client.setSession(session('old'));
  await assert.rejects(f.client.get('/auth/me'));
  assert.equal(f.saved(), 'refresh-old'); assert.equal(f.expired(), 0);
  assert.deepEqual(await f.client.get('/auth/me'), { recovered: true });
  assert.equal(refreshes, 2); assert.equal(f.saved(), 'refresh-new');
});

test('an explicitly invalid refresh token clears the local session', async () => {
  const f = fixture(async url => url.endsWith('/auth/refresh')
    ? json(401, { code: 'INVALID_REFRESH_TOKEN', message: 'Synthetic revoked session' }) : unauthorized());
  await f.client.setSession(session('old'));
  await assert.rejects(f.client.get('/auth/me'), isCode('INVALID_REFRESH_TOKEN'));
  assert.equal(f.saved(), null); assert.equal(f.client.accessToken, null); assert.equal(f.expired(), 1);
});

test('persistent token writes serialize so a late old write cannot replace the newer account', async () => {
  const oldStarted = deferred(), releaseOld = deferred(); let saved = null;
  const started = [], finished = [];
  const store = { read: async () => saved, write: async token => {
    started.push(token);
    if (token === 'refresh-A') { oldStarted.resolve(); await releaseOld.promise; }
    saved = token; finished.push(token);
  } };
  const client = new ApiClient(origin, store, () => {}, async () => { throw new Error('No HTTP expected'); });
  const first = client.setSession(session('A')); await oldStarted.promise;
  const second = client.setSession(session('B'));
  await Promise.resolve(); await Promise.resolve();
  const queuedBeforeRelease = [...started]; releaseOld.resolve(); await Promise.all([first, second]);
  assert.deepEqual(queuedBeforeRelease, ['refresh-A']); assert.deepEqual(finished, ['refresh-A', 'refresh-B']);
  assert.equal(saved, 'refresh-B'); assert.equal(client.accessToken, 'access-B');
  await client.clear(); assert.equal(saved, null);
});

test('invalid server URLs and non-relative endpoint paths are rejected without HTTP', async () => {
  const store = { read: async () => null, write: async () => {} }; let requests = 0;
  const transport = async () => { requests++; return json(200, {}); };
  for (const url of ['not a URL', 'file:///tmp', 'ftp://example.invalid', 'https://user:pass@example.invalid',
    `${origin}/other-path`, `${origin}?token=private`, `${origin}#fragment`]) assert.throws(() => new ApiClient(url, store, () => {}, transport));
  const client = new ApiClient(`${origin}/api/v1/`, store, () => {}, transport);
  assert.equal(client.baseUrl, `${origin}/api/v1`); assert.equal(client.url('/api/v1/health'), `${origin}/api/v1/health`);
  for (const path of ['https://other.invalid/path', '//other.invalid', '/bad\\path', '/bad\r\nHeader:value']) assert.throws(() => client.url(path));
  assert.equal(requests, 0);
});

test('logout clears local credentials before a pending server response and cannot clear a subsequent login', async () => {
  const entered = deferred(), response = deferred();
  const f = fixture(async (url, options) => {
    assert.ok(url.endsWith('/auth/logout')); assert.equal(authorization(options), 'Bearer access-old');
    entered.resolve(); return response.promise;
  });
  await f.client.setSession(session('old'));
  const loggingOut = f.client.logout(); await entered.promise;
  assert.equal(f.saved(), null); assert.equal(f.client.accessToken, null);
  const cold = new ApiClient(origin, { read: async () => f.saved(), write: async () => {} }, () => {}, async () => { throw new Error('A cleared session must not refresh'); });
  assert.equal(await cold.restore(), false);
  await f.client.setSession(session('new')); response.resolve(json(200, { logged_out: true })); await loggingOut;
  assert.equal(f.saved(), 'refresh-new'); assert.equal(f.client.accessToken, 'access-new'); assert.equal(f.expired(), 0);
});

test('failed server logout still clears local credentials without refreshing them', async () => {
  const f = fixture(async (url, options) => {
    assert.ok(url.endsWith('/auth/logout')); assert.equal(authorization(options), 'Bearer access-old'); assert.equal(f.saved(), null);
    throw new TypeError('Synthetic disconnected logout');
  });
  await f.client.setSession(session('old'));
  await assert.rejects(f.client.logout(), /Synthetic disconnected logout/);
  assert.equal(f.saved(), null); assert.equal(f.client.accessToken, null); assert.equal(f.expired(), 0);
});

test('logout does not wait for an old refresh or persist its late rotated credentials', async () => {
  const entered = deferred(), response = deferred();
  const f = fixture(async url => {
    if (url.endsWith('/auth/refresh')) { entered.resolve(); return response.promise; }
    if (url.endsWith('/auth/logout')) return json(200, { logged_out: true });
    return unauthorized();
  });
  await f.client.setSession(session('old'));
  const reading = assert.rejects(f.client.get('/auth/me'), isCode('SESSION_CHANGED')); await entered.promise;
  await f.client.logout(); assert.equal(f.saved(), null); assert.equal(f.client.accessToken, null);
  response.resolve(json(200, session('late-refresh'))); await reading;
  assert.equal(f.saved(), null); assert.equal(f.client.accessToken, null); assert.equal(f.writes.includes('refresh-late-refresh'), false);
});

test('401 invalidation notifies the app even when an extra cache cleanup rejects', async () => {
  let saved = null, expired = 0;
  class CleanupFailureClient extends ApiClient { async clear() { await super.clear(); throw new Error('Synthetic cache delete failure'); } }
  const client = new CleanupFailureClient(origin, { read: async () => saved, write: async token => { saved = token; } }, () => expired++, async () => unauthorized());
  await client.setSession(session('old'));
  await assert.rejects(client.get('/auth/me'));
  assert.equal(saved, null); assert.equal(client.accessToken, null); assert.equal(expired, 1);
});
