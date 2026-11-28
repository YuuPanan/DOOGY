import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { configurationFixture, fenceInput } from './configuration-history-fixture';

for (const mode of ['offline', 'api'] as const) test(`configuration history HTTP ${mode}: truthful actors, sequence pagination and current household authorization`, async () => {
  const f = await configurationFixture(mode), app = await createApp({ db: f.db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    async function api(path: string, method = 'GET', body?: unknown, key?: string, expected = method === 'POST' ? 201 : 200, token = f.owner.access_token) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
        authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const path = `/pets/${f.pet.id}/configuration-history`, range = '?from=2026-11-24T11:59:59Z&to=2026-11-25T00:00:00Z';
    assert.deepEqual((await api(path)).items, []);
    const fence = await api('/geofences', 'POST', fenceInput(f.pet.id), 'http-history-fence');
    await api(`/geofences/${fence.id}`, 'PATCH', { name: 'Garden' }, undefined, 200, f.caregiver.access_token);
    await api(`/geofences/${fence.id}`, 'PATCH', { name: 'Garden' }); await api(`/geofences/${fence.id}`, 'PATCH', {});
    await api(`/geofences/${fence.id}`, 'PATCH', { buffer_m: 25 }, undefined, 403, f.viewer.access_token);
    const requested = await api(`/devices/${f.device.device_id}/reporting-policy`, 'PUT', { mode: 'home_idle', interval_seconds: 600 }, 'http-policy');
    await f.reporting.acknowledge(f.device.device_id, requested.command_id, f.device.device_token, { status: 'applied', applied_version: requested.desired_version });
    await api(`/geofences/${fence.id}`, 'DELETE'); await api(`/geofences/${fence.id}`, 'DELETE');
    const full = await api(path + range, 'GET', undefined, undefined, 200, f.viewer.access_token);
    assert.equal(full.scope, 'recorded_changes_only'); assert.deepEqual(full.items.map((row: any) => row.version), [4, 3, 2, 1]);
    assert.equal(new Set(full.items.map((row: any) => row.changed_at)).size, 1);
    assert.equal(full.items[2].actor_user_id, f.caregiver.user.id); assert.deepEqual(full.items[2].changed_fields, ['name']);
    assert.equal(full.items[2].before_version, full.items[2].after_version);
    assert.equal(full.items[1].command_id, requested.command_id); assert.equal(full.items[1].action, 'policy_requested');
    assert.deepEqual((await api(path + range + '&kind=reporting_policy')).items.map((row: any) => row.version), [3]);
    assert.deepEqual((await api(path + range + `&resource_id=${fence.id}`)).items.map((row: any) => row.version), [4, 2, 1]);
    assert.deepEqual((await api(path + '?from=2026-11-24T12:00:00Z&to=2026-11-24T12:00:01Z')).items.map((row: any) => row.version), [4, 3, 2, 1]);
    assert.deepEqual((await api(path + '?from=2026-11-24T11:59:59Z&to=2026-11-24T12:00:00Z')).items, []);
    const paged = path + range + '&limit=1', versions: number[] = []; let cursor: string | null = null;
    do { const page = await api(paged + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')); versions.push(...page.items.map((row: any) => row.version)); cursor = page.next_cursor; } while (cursor);
    assert.deepEqual(versions, [4, 3, 2, 1]);
    const first = await api(paged), encoded = encodeURIComponent(first.next_cursor);
    await api(`${paged}&cursor=${encoded}`, 'GET', undefined, undefined, 400, f.viewer.access_token);
    await api(`${paged}&kind=geofence&cursor=${encoded}`, 'GET', undefined, undefined, 400);
    await api(`${paged}&resource_id=${fence.id}&cursor=${encoded}`, 'GET', undefined, undefined, 400);
    await api(paged.replace('11:59:59', '11:59:58') + `&cursor=${encoded}`, 'GET', undefined, undefined, 400);
    await api(path, 'GET', undefined, undefined, 404, f.stranger.access_token);
    await api(`/pets/${f.otherPet.id}/configuration-history`, 'GET', undefined, undefined, 404);
    await api(path + '?kind=unknown', 'GET', undefined, undefined, 400);
    await api(path + '?from=2026-10-01T00:00:00Z&to=2026-11-24T00:00:00Z', 'GET', undefined, undefined, 400);
    await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
    await api(path + range, 'GET', undefined, undefined, 404, f.viewer.access_token);
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/pets/{id}/configuration-history'].get); assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await f.close(); }
});
