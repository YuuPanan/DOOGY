import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`safety history HTTP ${mode}: half-open windows, scoped cursors and legacy all-history compatibility`, async () => {
  process.env.DATA_MODE = mode;
  let now = Date.parse('2026-11-24T12:00:00.000Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db;
  const app = await createApp({ db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).origin !== origin) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(path: string, options: { method?: string; body?: unknown; token?: string; expected?: number } = {}) {
      const method = options.method ?? 'GET', token = options.token ?? access;
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(10000) });
      const value = await response.json() as any;
      assert.equal(response.status, options.expected ?? (method === 'POST' ? 201 : 200), `${method} ${path}: ${value.code ?? 'unexpected response'}`);
      return value;
    }
    const register = (name: string) => api('/auth/register', { method: 'POST', body: { email: `safety-history-${name}-${mode}@example.invalid`, password: 'Synthetic-safety-history-2026', timezone: 'UTC' } });
    const owner = await register('owner'), viewer = await register('viewer'), outsider = await register('outsider'); access = owner.access_token;
    const invitation = await api(`/households/${owner.household.id}/invitations`, { method: 'POST', body: { email: viewer.user.email, role: 'viewer' } });
    await api(`/invitations/${invitation.token}/accept`, { method: 'POST', token: viewer.access_token, expected: 200 });
    const pet = await api('/pets', { method: 'POST', body: { household_id: owner.household.id, name: 'Safety history window fixture' } });
    const otherPet = await api('/pets', { method: 'POST', body: { household_id: owner.household.id, name: 'Other safety history fixture' } });
    const device = db.id();
    // Synthetic historical event fixtures only; no telemetry, hardware or device secrets are exercised.
    await db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', device, `safety-history-${mode}`, 'fixture', 'fixture', 'unused', db.now());
    async function event(occurredAt: string, petId = pet.id, closed = false) {
      const id = db.id();
      await db.run(`INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json,status,closed_at,closed_reason)
        VALUES (?,?,?,?,?,?,?,?,?)`, id, petId, device, 'battery.low', occurredAt, JSON.stringify({ fixture: true }),
      closed ? 'closed' : 'open', closed ? db.now() : null, closed ? 'battery_recovered' : null);
      return id;
    }
    const from = '2026-11-24T00:00:00.000Z', to = '2026-11-24T12:00:00.000Z';
    const old = await event('2026-01-01T00:00:00.000Z'), before = await event('2026-11-23T23:59:59.999Z');
    const atFrom = await event(from, pet.id, true), ties: string[] = [];
    for (let index = 0; index < 3; index++) ties.push(await event('2026-11-24T01:00:00.000Z'));
    const beforeTo = await event('2026-11-24T11:59:59.999Z'), atTo = await event(to), otherEvent = await event(from, otherPet.id);
    const path = (values: Record<string, string | number | undefined> = {}, petId = pet.id) => `/pets/${petId}/safety-events?${new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`;
    const expected = [beforeTo, ...ties.sort().reverse(), atFrom];
    const all = await api(path());
    assert.deepEqual(all.range, { from: null, to: null });
    assert.deepEqual(all.items.map((row: any) => row.id), [atTo, ...expected, before, old]);
    assert.equal(all.next_cursor, null);

    const legacyStart = await api(path({ limit: 1 }));
    const legacyPage = await api(path({ cursor: legacyStart.items[0].id, limit: 2 }));
    assert.deepEqual(legacyPage.items.map((row: any) => row.id), expected.slice(0, 2)); assert.ok(legacyPage.next_cursor);
    const legacyScoped = await api(path({ cursor: legacyStart.next_cursor, limit: 2 }));
    assert.deepEqual(legacyScoped.items, legacyPage.items);
    for (const cursor of [otherEvent, db.id(), 'not-a-cursor']) await api(path({ cursor }), { expected: 400 });
    await api(path({ from, to, cursor: legacyStart.items[0].id }), { expected: 400 });

    const bounds = { from: '2026-11-24T08:00:00+08:00', to: '2026-11-24T20:00:00+08:00' };
    const first = await api(path({ ...bounds, limit: 2 }));
    assert.deepEqual(first.range, { from, to }); assert.deepEqual(first.items.map((row: any) => row.id), expected.slice(0, 2)); assert.ok(first.next_cursor);
    const cursorData = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString('utf8'));
    assert.deepEqual(cursorData.scope, { user: owner.user.id, pet: pet.id, from, to, order: 'occurred_at_desc,id_desc' });
    const equivalent = await api(path({ from, to, cursor: first.next_cursor, limit: 2 }));
    now += 60000;
    const continued = await api(path({ cursor: first.next_cursor, limit: 2 }));
    assert.deepEqual(continued.range, first.range); assert.deepEqual(continued.items, equivalent.items);
    const collected = [...first.items, ...continued.items]; let cursor: string | null = continued.next_cursor, pages = 2;
    while (cursor) {
      const page = await api(path({ cursor, limit: 2 })); assert.deepEqual(page.range, first.range);
      collected.push(...page.items); cursor = page.next_cursor; assert.ok(++pages < 10);
    }
    assert.deepEqual(collected.map(row => row.id), expected); assert.equal(new Set(collected.map(row => row.id)).size, expected.length);
    const closed = collected.find(row => row.id === atFrom)!;
    assert.equal(closed.status, 'closed'); assert.equal(closed.closed_reason, 'battery_recovered'); assert.deepEqual(closed.details, { fixture: true });
    assert.equal(collected.some(row => row.id === atTo || row.id === before), false);

    await api(path({ from: '2026-11-23T23:00:00.000Z', to, cursor: first.next_cursor }), { expected: 400 });
    await api(path({ cursor: first.next_cursor }, otherPet.id), { expected: 400 });
    await api(path({ cursor: first.next_cursor }), { token: viewer.access_token, expected: 400 });
    await api(path({ from, to }), { token: outsider.access_token, expected: 404 });
    const invalidOrder = { ...cursorData, scope: { ...cursorData.scope, order: 'occurred_at_asc,id_asc' } };
    const invalidAnchor = { ...cursorData, after: { ...cursorData.after, occurred_at: to } };
    for (const changed of [invalidOrder, invalidAnchor, { ...cursorData, v: 2 },
      { ...cursorData, scope: { ...cursorData.scope, from: null } }, { ...cursorData, scope: { ...cursorData.scope, to: null } }])
      await api(path({ cursor: Buffer.from(JSON.stringify(changed)).toString('base64url') }), { expected: 400 });
    for (const invalid of [{ from }, { to }, { from, to: from }, { from: to, to: from },
      { from: '2026-10-01T00:00:00Z', to }, { from: 'invalid', to }, { from: '2026-11-24T00:00:00', to }])
      await api(path(invalid), { expected: 400 });
    const maximumFrom = new Date(Date.parse(to) - 31 * 86400000).toISOString();
    const maximum = await api(path({ from: maximumFrom, to }));
    assert.deepEqual(maximum.range, { from: maximumFrom, to }); assert.deepEqual(maximum.items.map((row: any) => row.id), [...expected, before]);
    assert.deepEqual((await api(path({ from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' }))).items, []);
    assert.equal((await api(path({ from, to }), { token: viewer.access_token })).items.length, expected.length);

    // A scoped keyset survives removal of its anchor, unlike the old ID-only cursor.
    await db.run('DELETE FROM safety_events WHERE id=?', cursorData.after.id);
    assert.deepEqual((await api(path({ cursor: first.next_cursor, limit: 2 }))).items, continued.items);
    await api(path({ cursor: cursorData.after.id }), { expected: 400 });

    for (const [start, end, hours] of [['2026-03-08T00:00:00-05:00', '2026-03-09T00:00:00-04:00', 23],
      ['2026-11-01T00:00:00-04:00', '2026-11-02T00:00:00-05:00', 25]] as const) {
      const normalizedFrom = new Date(start).toISOString(), normalizedTo = new Date(end).toISOString();
      const included = await event(normalizedFrom), excluded = await event(normalizedTo);
      const dst = await api(path({ from: start, to: end }));
      assert.deepEqual(dst.range, { from: normalizedFrom, to: normalizedTo });
      assert.equal((Date.parse(dst.range.to) - Date.parse(dst.range.from)) / 3600000, hours);
      assert.deepEqual(dst.items.map((row: any) => row.id), [included]); assert.ok(!dst.items.some((row: any) => row.id === excluded));
    }
    const viewerPage = await api(path({ from, to, limit: 1 }), { token: viewer.access_token }); assert.ok(viewerPage.next_cursor);
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, { method: 'DELETE' });
    await api(path({ cursor: viewerPage.next_cursor }), { token: viewer.access_token, expected: 404 });
    assert.equal(externalCalls, 0); if (db.driver === 'sqlite') assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
