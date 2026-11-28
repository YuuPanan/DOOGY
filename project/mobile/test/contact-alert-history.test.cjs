const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { ApiClient, ApiError } = require('../.test-dist/client.js');
const { Db } = require('../../dist/src/db.js');
const { createApp } = require('../../dist/src/app.js');
const { ContactAlertsService } = require('../../dist/src/contact-alerts.js');

async function withBackend(work) {
  process.chdir(resolve(__dirname, '../..'));
  process.env.DATA_MODE = 'offline'; process.env.DB_DRIVER = 'sqlite'; process.env.MANAGED_BACKUP_ENABLED = 'false';
  process.env.SUPPORT_ADMIN_USER_IDS = ''; process.env.DEVICE_ADMIN_USER_IDS = '';
  for (const name of ['DATABASE_URL', 'DOOGY_DEMO', 'PUSH_WEBHOOK_URL', 'PUSH_WEBHOOK_TOKEN', 'VENDOR_WEBHOOK_SECRET']) delete process.env[name];
  let now = Date.parse('2026-11-24T12:00:00.000Z'), app, externalCalls = 0, loseCreate = false;
  const db = new Db(':memory:', () => new Date(now)), nativeFetch = globalThis.fetch, calls = [];
  try {
    app = await createApp({ db, quiet: true }); await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.origin !== origin) { externalCalls++; throw new Error('External calls are forbidden by this synthetic history test'); }
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', key: new Headers(init?.headers).get('idempotency-key') });
      const response = await nativeFetch(input, init);
      if (loseCreate && init?.method === 'POST' && /\/pets\/[^/]+\/contact-alerts$/.test(url.pathname)) {
        loseCreate = false; await response.arrayBuffer(); throw new TypeError('Synthetic response lost after the server accepted the request');
      }
      return response;
    };
    function client() {
      let token = null;
      return { api: new ApiClient(origin, { read: async () => token, write: async value => { token = value; } }), saved: () => token };
    }
    const password = 'Synthetic-contact-history-2026', owner = client(), viewer = client(), outsider = client();
    async function register(target, name) {
      const value = await target.api.post('/auth/register', { email: `history-${name}@example.invalid`, password, timezone: 'UTC' });
      await target.api.setSession(value); return value;
    }
    const registered = await register(owner, 'owner'), viewerIdentity = await register(viewer, 'viewer'); await register(outsider, 'outsider');
    const invitation = await owner.api.post(`/households/${registered.household.id}/invitations`, { email: viewerIdentity.user.email, role: 'viewer' });
    await viewer.api.post(`/invitations/${invitation.token}/accept`);
    const pet = await owner.api.post('/pets', { household_id: registered.household.id, name: 'History synthetic pet' });
    const otherPet = await owner.api.post('/pets', { household_id: registered.household.id, name: 'Other history synthetic pet' });
    const granted = await owner.api.post(`/households/${registered.household.id}/contacts`, { name: 'Reported synthetic recipient', email: 'history-recipient@example.invalid', consent: { status: 'reported_granted' } });
    const unknown = await owner.api.post(`/households/${registered.household.id}/contacts`, { name: 'Unknown synthetic recipient', phone: '+86 13800000000' });
    const selection = contact => ({ contact_id: contact.id, expected_version: contact.version, method: contact.email ? 'email' : 'phone' });
    const body = (contacts, message) => ({ consent: true, message, recipients: contacts.map(selection) });
    const listPath = `/pets/${pet.id}/contact-alerts`;
    function noCopies(value) {
      function keys(item) {
        if (!item || typeof item !== 'object') return;
        for (const [name, nested] of Object.entries(item)) {
          assert.doesNotMatch(name, /^(phone|email|address|url|share_token|access_token|refresh_token|token)$/i);
          keys(nested);
        }
      }
      keys(value);
      const encoded = JSON.stringify(value);
      for (const secret of [granted.email, unknown.phone, password, owner.api.accessToken, owner.saved()].filter(Boolean)) assert.equal(encoded.includes(secret), false);
    }
    await work({ db, owner, viewer, outsider, registered, viewerIdentity, pet, otherPet, granted, unknown, body, listPath, client, password, calls,
      service: app.get(ContactAlertsService), advance: () => { now += 1000; }, now: () => now, noCopies, loseNextCreate: () => { loseCreate = true; } });
    assert.equal(externalCalls, 0); assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
  } finally {
    globalThis.fetch = nativeFetch;
    try { if (app) await app.close(); } finally { await db.close(); }
  }
}
const status = expected => error => error instanceof ApiError && error.status === expected;

test('mobile history pages current offline outcomes and a new login rediscovers each request without saved request IDs', { timeout: 30000 }, async () => {
  await withBackend(async f => {
    const mixedBody = f.body([f.granted, f.unknown], 'Synthetic mixed history');
    f.loseNextCreate(); await assert.rejects(f.owner.api.post(f.listPath, mixedBody), error => error instanceof ApiError && error.code === 'NETWORK_ERROR');
    const mixed = await f.owner.api.post(f.listPath, mixedBody);
    const creates = f.calls.filter(row => row.path.endsWith('/contact-alerts') && row.method === 'POST');
    assert.equal(creates.length, 2); assert.ok(creates[0].key); assert.equal(creates[0].key, creates[1].key);
    assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM contact_alerts')).n), 1);
    f.advance(); const failed = await f.owner.api.post(f.listPath, f.body([f.unknown], 'Synthetic failed history'));
    f.advance(); const simulated = await f.owner.api.post(f.listPath, f.body([f.granted], 'Synthetic simulated history'));
    assert.equal(await f.service.work(), 3);
    const oldRefresh = f.owner.saved();
    await f.db.run('UPDATE sessions SET expires_at=? WHERE user_id=?', new Date(f.now() - 1000).toISOString(), f.registered.user.id);
    const first = await f.owner.api.get(`${f.listPath}?limit=1`);
    assert.equal(first.items[0].id, simulated.id); assert.ok(first.next_cursor); assert.notEqual(f.owner.saved(), oldRefresh);
    assert.equal(f.calls.filter(row => row.path.endsWith('/auth/refresh')).length, 1);

    const fresh = f.client();
    await fresh.api.setSession(await fresh.api.post('/auth/login', { email: f.registered.user.email, password: f.password }));
    const chosen = (await fresh.api.get('/pets')).items.find(row => row.name === 'History synthetic pet'); assert.ok(chosen);
    const rows = []; let cursor = null;
    do {
      const query = new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) });
      const page = await fresh.api.get(`/pets/${chosen.id}/contact-alerts?${query}`);
      assert.equal(page.pet_id, chosen.id); assert.equal(page.items.length, 1); f.noCopies(page);
      for (const row of page.items) {
        assert.equal(Object.hasOwn(row, 'recipients'), false); assert.equal(row.content_scope, 'message_only');
        assert.equal(row.location_link_included, false); assert.equal(row.recipient_consent_verified, false);
        const detail = await fresh.api.get(`/contact-alerts/${row.id}`);
        assert.equal(detail.status, row.status); assert.deepEqual(detail.counts, row.counts); assert.equal(detail.pet_id, chosen.id);
        assert.equal(detail.recipients.length, row.counts.total); f.noCopies(detail); rows.push(row);
      }
      cursor = page.next_cursor;
    } while (cursor !== null);
    assert.deepEqual(rows.map(row => [row.id, row.status]), [[simulated.id, 'simulated'], [failed.id, 'failed'], [mixed.id, 'partial']]);
    assert.equal(rows[2].counts.simulated, 1); assert.equal(rows[2].counts.failed, 1);
  });
});

test('mobile history reflects same-ID retry and cancellation without requeueing an old create key', { timeout: 30000 }, async () => {
  await withBackend(async f => {
    const input = f.body([f.granted], 'Synthetic retry history'), alert = await f.owner.api.post(f.listPath, input, 'history-create-once');
    assert.equal(await f.service.work(), 1);
    const successful = await f.owner.api.get(`/contact-alerts/${alert.id}`); assert.equal(successful.status, 'simulated');
    // Test-only recoverable outcome injection, not evidence of a real provider attempt.
    await f.db.run("UPDATE contact_alert_recipients SET status='failed',error_code='CHANNEL_NOT_CONFIGURED',execution_source=NULL WHERE alert_id=?", alert.id);
    assert.equal((await f.owner.api.get(f.listPath)).items[0].status, 'failed');
    f.advance(); const retry = await f.owner.api.post(`/contact-alerts/${alert.id}/retry`, { expected_attempt: 1 }, 'history-retry-once');
    assert.equal(retry.id, alert.id); assert.equal(retry.attempt, 2); assert.equal(retry.status, 'pending');
    assert.equal(retry.recipients[0].id, successful.recipients[0].id);
    assert.equal((await f.owner.api.post(`/contact-alerts/${alert.id}/retry`, { expected_attempt: 1 }, 'history-retry-once')).attempt, 2);
    const pending = (await f.owner.api.get(f.listPath)).items[0]; assert.equal(pending.status, 'pending'); assert.equal(pending.counts.pending, 1);
    await f.owner.api.post(`/contact-alerts/${alert.id}/cancel`, { expected_attempt: 2 }, 'history-cancel-once');
    const cancelled = (await f.owner.api.get(f.listPath)).items[0]; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.counts.cancelled, 1);
    assert.equal((await f.owner.api.get(`/contact-alerts/${cancelled.id}`)).recipients[0].status, 'cancelled'); f.noCopies(cancelled);
    assert.equal((await f.owner.api.post(f.listPath, input, 'history-create-once')).status, 'cancelled');
    assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM contact_alerts')).n), 1); assert.equal(await f.service.work(), 0);
  });
});

test('mobile history and its cursor follow current household access, pet and caller scope', { timeout: 30000 }, async () => {
  await withBackend(async f => {
    const a = await f.owner.api.post(f.listPath, f.body([f.granted], 'Synthetic permission history one'));
    f.advance(); await f.owner.api.post(f.listPath, f.body([f.granted], 'Synthetic permission history two'));
    const ownerPage = await f.owner.api.get(`${f.listPath}?limit=1`), viewerPage = await f.viewer.api.get(`${f.listPath}?limit=1`);
    assert.ok(ownerPage.next_cursor); assert.ok(viewerPage.next_cursor); assert.equal(viewerPage.items[0].id, ownerPage.items[0].id); f.noCopies(viewerPage);
    assert.equal((await f.viewer.api.get(`/contact-alerts/${a.id}`)).id, a.id);
    await assert.rejects(f.viewer.api.post(`/contact-alerts/${a.id}/retry`, { expected_attempt: 1 }), status(403));
    await assert.rejects(f.outsider.api.get(f.listPath), status(404)); await assert.rejects(f.outsider.api.get(`/contact-alerts/${a.id}`), status(404));
    await assert.rejects(f.owner.api.get(`/pets/${f.otherPet.id}/contact-alerts?limit=1&cursor=${encodeURIComponent(ownerPage.next_cursor)}`), status(400));
    await assert.rejects(f.viewer.api.get(`${f.listPath}?limit=1&cursor=${encodeURIComponent(ownerPage.next_cursor)}`), status(400));
    assert.deepEqual((await f.owner.api.get(`/pets/${f.otherPet.id}/contact-alerts`)).items, []);
    await f.owner.api.delete(`/households/${f.registered.household.id}/members/${f.viewerIdentity.user.id}`);
    await assert.rejects(f.viewer.api.get(`${f.listPath}?limit=1&cursor=${encodeURIComponent(viewerPage.next_cursor)}`), status(404));
    await assert.rejects(f.viewer.api.get(`/contact-alerts/${a.id}`), status(404));
    assert.equal((await f.owner.api.get(f.listPath)).items.length, 2);
  });
});
