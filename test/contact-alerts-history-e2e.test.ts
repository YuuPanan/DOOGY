import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { contactAlertFixture, contactAlertBody, selectedContact } from './contact-alerts-fixture';

for (const mode of ['offline', 'api'] as const) test(`contact alert history HTTP ${mode}: scoped pagination, current access and live summary states`, async () => {
  const f = await contactAlertFixture(mode), app = await createApp({ db: f.db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    async function api(path: string, token = f.owner.access_token, expected = 200) {
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
      if (expected === 200 && path.includes('/contact-alerts')) assert.equal(response.headers.get('cache-control'), 'no-store');
      return value;
    }
    const path = `/pets/${f.pet.id}/contact-alerts`;
    assert.deepEqual(await api(path), { pet_id: f.pet.id, items: [], next_cursor: null });
    for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'limit=no', 'cursor=', 'cursor=%25', 'status=failed', 'from=2026-11-24T00%3A00%3A00Z', 'limit=1&limit=2']) await api(`${path}?${query}`, undefined, 400);
    await api(path, '', 401); await api(path, f.stranger.access_token, 404);
    const input = contactAlertBody([selectedContact(f.granted)]), created = [];
    for (let n = 0; n < 3; n++) created.push(await f.service.create(f.caregiver.user.id, f.pet.id, { ...input, message: `History ${n}` }));
    const expectedIds = created.map(row => row.id).sort().reverse();
    const full = await api(path, f.viewer.access_token);
    assert.deepEqual(full.items.map((row: any) => row.id), expectedIds);
    assert.ok(full.items.every((row: any) => row.created_by === f.caregiver.user.id));
    const first = await api(path + '?limit=1'), cursor = encodeURIComponent(first.next_cursor);
    await api(`${path}?limit=1&cursor=${cursor}`, f.viewer.access_token, 400);
    const sameHouseholdPet = await f.identity.createPet(f.owner.user.id, { household_id: f.owner.household.id, name: 'Another history pet' });
    await api(`/pets/${sameHouseholdPet.id}/contact-alerts?cursor=${cursor}`, undefined, 400);
    await api(`/pets/${f.otherPet.id}/contact-alerts?cursor=${cursor}`, undefined, 404);
    f.advance(); const newest = await f.service.create(f.owner.user.id, f.pet.id, input);
    const ids = [first.items[0].id]; let next = first.next_cursor;
    while (next) { const page = await api(`${path}?limit=1&cursor=${encodeURIComponent(next)}`); ids.push(...page.items.map((row: any) => row.id)); next = page.next_cursor; }
    assert.deepEqual(ids, expectedIds); assert.equal(new Set(ids).size, 3);
    assert.equal((await api(path)).items[0].id, newest.id);
    await f.service.work();
    const processed = await api(path);
    for (const row of processed.items) {
      const { recipients, ...detail } = await api(`/contact-alerts/${row.id}`); assert.deepEqual(row, detail);
      assert.equal(row.status, mode === 'offline' ? 'simulated' : 'failed'); assert.equal(recipients.length, 1);
      assert.equal(row.content_scope, 'message_only'); assert.equal(row.location_link_included, false); assert.equal(row.recipient_consent_verified, false);
      for (const key of ['recipients', 'email', 'phone', 'token', 'share_id', 'public_path']) assert.equal(key in row, false);
    }
    assert.equal(JSON.stringify(processed).includes(f.granted.email), false);
    if (mode === 'api') {
      f.advance(); const retried = await f.service.retry(f.owner.user.id, created[0].id, { expected_attempt: 1 });
      const updated = await api(path); assert.equal(updated.items.find((row: any) => row.id === retried.id).attempt, 2);
      assert.deepEqual(updated.items.map((row: any) => row.id), processed.items.map((row: any) => row.id));
      await f.service.work();
    }
    const cancelled = await f.service.create(f.owner.user.id, f.pet.id, input); await f.service.cancel(f.owner.user.id, cancelled.id, { expected_attempt: 1 });
    const expiring = await f.service.create(f.owner.user.id, f.pet.id, contactAlertBody([selectedContact(f.granted)], { expires_in_seconds: 60 }));
    f.advance(59999); assert.equal((await api(path)).items.find((row: any) => row.id === expiring.id).status, 'pending');
    f.advance(1); const expiredList = await api(path, f.viewer.access_token), expired = expiredList.items.find((row: any) => row.id === expiring.id);
    assert.equal(expired.status, 'failed'); assert.equal(expired.counts.failed, 1);
    assert.equal(expiredList.items.find((row: any) => row.id === cancelled.id).status, 'cancelled');
    const { recipients, ...detail } = await api(`/contact-alerts/${expiring.id}`); assert.deepEqual(expired, detail); assert.equal(recipients[0].error_code, 'REQUEST_EXPIRED');
    const viewerFirst = await api(path + '?limit=1', f.viewer.access_token);
    await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
    await api(`${path}?cursor=${encodeURIComponent(viewerFirst.next_cursor)}`, f.viewer.access_token, 404);
    const spec = await (await fetch(`${origin}/openapi.json`)).json() as any, operation = spec.paths['/api/v1/pets/{id}/contact-alerts'].get;
    assert.ok(operation); assert.ok(operation.parameters.some((row: any) => row.name === 'limit')); assert.ok(operation.parameters.some((row: any) => row.name === 'cursor'));
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await f.close(); }
});
