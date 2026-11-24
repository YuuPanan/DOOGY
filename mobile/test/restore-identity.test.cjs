const assert = require('node:assert/strict');
const { test: nodeTest } = require('node:test');
const { ApiClient, ApiError } = require('../.test-dist/client.js');
const { restoreIdentity } = require('../.test-dist/restoreIdentity.js');
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const session = name => ({ access_token: `access-${name}`, refresh_token: `refresh-${name}` });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  let token = 'refresh-original', expired = 0;
  const writes = [], store = { read: async () => token, write: async value => { token = value; writes.push(value); } };
  return { store, writes, saved: () => token, expired: () => expired,
    client: (transport, origin = 'https://restore.example.invalid') => new ApiClient(origin, store, () => expired++, transport) };
}
function identity(url) {
  if (url.endsWith('/auth/me')) return { id: 'synthetic-user' };
  if (url.endsWith('/households')) return { items: [{ id: 'synthetic-household' }] };
  if (url.endsWith('/pets')) return { items: [{ id: 'synthetic-pet' }] };
  if (url.endsWith('/auth/onboarding')) return { pet_id: 'synthetic-pet', next_step: 'done' };
  throw new Error('Unexpected synthetic endpoint');
}

for (const failure of ['503', 'network']) test(`refresh succeeds then identity ${failure}: next cold restore uses the rotated refresh and succeeds`, async () => {
  const f = fixture(), refreshBodies = []; let fail = true;
  const transport = async (url, options) => {
    if (url.endsWith('/auth/refresh')) { refreshBodies.push(JSON.parse(options.body).refresh_token); return json(200, session(`rotation-${refreshBodies.length}`)); }
    if (fail && url.endsWith('/households')) { if (failure === 'network') throw new TypeError('Synthetic disconnected transport'); return json(503, { code: 'TEMPORARY', message: 'Synthetic unavailable' }); }
    return json(200, identity(url));
  };
  await assert.rejects(restoreIdentity(f.client(transport), () => true), error => error instanceof ApiError && error.status === (failure === 'network' ? 0 : 503));
  assert.equal(f.saved(), 'refresh-rotation-1'); assert.equal(f.writes.includes(null), false);
  fail = false;
  const recovered = await restoreIdentity(f.client(transport), () => true);
  assert.deepEqual(refreshBodies, ['refresh-original', 'refresh-rotation-1']);
  assert.equal(recovered.profile.id, 'synthetic-user'); assert.equal(recovered.animals.items[0].id, 'synthetic-pet');
  assert.equal(f.saved(), 'refresh-rotation-2'); assert.equal(f.expired(), 0);
});

for (const failure of ['503', 'network']) test(`temporary refresh ${failure} is visible to the caller and preserves the stored token`, async () => {
  const f = fixture(), client = f.client(async () => {
    if (failure === 'network') throw new TypeError('Synthetic disconnected transport');
    return json(503, { code: 'TEMPORARY', message: 'Synthetic unavailable' });
  });
  await assert.rejects(restoreIdentity(client, () => true));
  assert.equal(f.saved(), 'refresh-original'); assert.deepEqual(f.writes, []); assert.equal(f.expired(), 0);
});

test('an explicit invalid refresh 401 clears the session through ApiClient and loads no identity', async () => {
  const f = fixture(); let calls = 0;
  const client = f.client(async url => { calls++; assert.ok(url.endsWith('/auth/refresh')); return json(401, { code: 'INVALID_REFRESH_TOKEN', message: 'Synthetic revoked' }); });
  assert.equal(await restoreIdentity(client, () => true), null);
  assert.equal(f.saved(), null); assert.equal(client.accessToken, null); assert.equal(f.expired(), 1); assert.equal(calls, 1);
});

test('identity 401 followed by invalid refresh also clears the stored session', async () => {
  const f = fixture(); let refreshes = 0;
  const client = f.client(async url => {
    if (url.endsWith('/auth/refresh') && ++refreshes === 1) return json(200, session('rotated'));
    return json(401, { code: 'INVALID_SESSION', message: 'Synthetic revoked' });
  });
  assert.equal(await restoreIdentity(client, () => true), null);
  assert.equal(f.saved(), null); assert.equal(client.accessToken, null); assert.equal(f.expired(), 1);
});

test('a late identity response from a previous server never returns data or clears the new server session', async () => {
  const f = fixture(), entered = deferred(), response = deferred(); let current = true;
  const old = f.client(async url => {
    if (url.endsWith('/auth/refresh')) return json(200, session('old-server'));
    if (url.endsWith('/auth/me')) { entered.resolve(); return response.promise; }
    return json(200, identity(url));
  });
  const recovering = restoreIdentity(old, () => current); await entered.promise;
  current = false; await old.clear();
  const next = f.client(async () => { throw new Error('No HTTP expected'); }, 'https://new-server.example.invalid'); await next.setSession(session('new-server'));
  response.resolve(json(200, { id: 'old-user' }));
  assert.equal(await recovering, null); assert.equal(f.saved(), 'refresh-new-server'); assert.equal(next.accessToken, 'access-new-server');
});

test('a late identity response cannot replace a newer login on the same client', async () => {
  const f = fixture(), entered = deferred(), response = deferred();
  const client = f.client(async url => {
    if (url.endsWith('/auth/refresh')) return json(200, session('old-login'));
    if (url.endsWith('/auth/me')) { entered.resolve(); return response.promise; }
    return json(200, identity(url));
  });
  const recovering = restoreIdentity(client, () => true); await entered.promise;
  await client.setSession(session('new-login')); response.resolve(json(200, { id: 'old-user' }));
  assert.equal(await recovering, null); assert.equal(f.saved(), 'refresh-new-login'); assert.equal(client.accessToken, 'access-new-login'); assert.equal(f.expired(), 0);
});

test('a pending secure-store read cannot overwrite a newer session or issue an old-token refresh', async () => {
  const f = fixture(), read = deferred(); let requests = 0;
  f.store.read = () => read.promise;
  const client = f.client(async () => { requests++; throw new Error('No HTTP expected'); });
  const recovering = restoreIdentity(client, () => true);
  await client.setSession(session('new-login')); read.resolve('refresh-original');
  assert.equal(await recovering, null); assert.equal(f.saved(), 'refresh-new-login'); assert.equal(client.accessToken, 'access-new-login'); assert.equal(requests, 0);
});
