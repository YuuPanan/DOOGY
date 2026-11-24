import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

type SafetyEvent = { id: string; type: string; status: string; closed_at: string | null; closed_reason: string | null; related_event_id: string | null };

for (const mode of ['offline', 'api'] as const) test(`安全事件关闭HTTP：${mode}模式记录关闭原因并保留旧记录未知`, async () => {
  process.env.DATA_MODE = mode;
  process.env.FRESH_SECONDS = '300';
  process.env.OFFLINE_SECONDS = '300';
  process.env.LOW_BATTERY_PCT = '20';
  let now = Date.parse('2026-11-18T06:00:00Z'), seq = 0;
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, deviceToken?: string) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
        ...(access && !deviceToken ? { authorization: `Bearer ${access}` } : {}), ...(deviceToken ? { 'x-device-token': deviceToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const result = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
      return result;
    }

    const owner = await api('/auth/register', 'POST', { email: `closure-${mode}@example.invalid`, password: 'Synthetic-close-reason-2026' });
    access = owner.access_token;
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Closure HTTP pet' });
    const device = await provisionDevice(db, { serial_no: `CLOSE-REASON-${mode}` });
    await api('/devices/claim', 'POST', { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    const fence = await api('/geofences', 'POST', { pet_id: pet.id, name: 'HTTP home fence', geometry: { type: 'circle', lat: 0, lon: 0, radius_m: 100 } });
    const legacyId = randomUUID(), legacyClosedAt = db.now();
    await db.run(`INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json,status,closed_at)
      VALUES (?,?,?,?,?,?,'closed',?)`, legacyId, pet.id, device.device_id, 'battery.low', legacyClosedAt, '{}', legacyClosedAt);

    const telemetry = app.get(TelemetryService);
    async function send(eventType: 'state.reported' | 'location.reported', payload: Record<string, unknown>) {
      now += 10000;
      await api('/ingest/events', 'POST', { schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
        boot_id: 'closure-http', seq: ++seq, device_ts: db.now(), event_type: eventType, payload }, 202, device.device_token);
      assert.equal(await telemetry.work(), 1);
    }
    const location = (lat: number) => send('location.reported', { lat, lon: 0, accuracy_m: 5, source: 'gnss' });
    const list = async (): Promise<SafetyEvent[]> => (await api(`/pets/${pet.id}/safety-events?limit=50`)).items;
    const detail = (id: string) => api(`/safety-events/${id}`);
    async function openEvent(type: string) {
      const matches = (await list()).filter(event => event.type === type && event.status === 'open');
      assert.equal(matches.length, 1, type);
      assert.equal(matches[0].closed_reason, null);
      return matches[0];
    }
    async function exitFence() {
      await location(0.003);
      await location(0.003);
      return openEvent('geofence.exited');
    }
    const expected = new Map<string, [string | null, string]>();
    async function closed(id: string, reason: string | null, at = db.now()) {
      const event = await detail(id);
      assert.equal(event.status, 'closed');
      assert.equal(event.closed_at, at);
      assert.equal(event.closed_reason, reason);
      expected.set(id, [reason, at]);
    }

    const returned = await exitFence();
    const ack = await api(`/safety-events/${returned.id}/ack`, 'POST', { note: 'Checking the pet' });
    assert.equal(ack.event_status, 'open');
    assert.equal(ack.event_closed_at, null);
    assert.equal((await detail(returned.id)).closed_reason, null);
    await location(0);
    assert.equal((await openEvent('geofence.exited')).id, returned.id);
    await location(0);
    await closed(returned.id, 'geofence_returned');
    const entry = (await list()).find(event => event.type === 'geofence.entered' && event.related_event_id === returned.id);
    assert.ok(entry);
    await closed(entry.id, 'geofence_entry_recorded');

    const ruleChanged = await exitFence();
    const unchanged = await api(`/geofences/${fence.id}`, 'PATCH', { name: 'Renamed HTTP fence', buffer_m: fence.buffer_m });
    assert.equal(unchanged.rule_version, fence.rule_version);
    assert.equal((await openEvent('geofence.exited')).id, ruleChanged.id);
    await api(`/geofences/${fence.id}`, 'PATCH', { buffer_m: 15 });
    await closed(ruleChanged.id, 'fence_rule_changed');
    const disabled = await exitFence();
    await api(`/geofences/${fence.id}`, 'DELETE');
    await closed(disabled.id, 'fence_disabled');
    await api(`/geofences/${fence.id}`, 'PATCH', { enabled: true });
    const unbound = await exitFence();

    await send('state.reported', { battery_pct: 5 });
    const battery = await openEvent('battery.low');
    now += 301000;
    await telemetry.runMaintenance();
    const offline = await openEvent('device.offline'), stale = await openEvent('location.stale');
    await send('state.reported', { battery_pct: 80 });
    await closed(offline.id, 'device_reconnected');
    await closed(battery.id, 'battery_recovered');
    assert.equal((await openEvent('location.stale')).id, stale.id);
    await location(0.003);
    await closed(stale.id, 'location_recovered');
    await api(`/devices/${device.device_id}/unbind`, 'POST');
    await closed(unbound.id, 'device_unbound');
    await closed(legacyId, null, legacyClosedAt);

    const history = await list();
    const exported = (await api(`/auth/data-export/safety_events?household_id=${owner.household.id}&limit=50`)).items as SafetyEvent[];
    for (const events of [history, exported]) {
      assert.deepEqual(new Map(events.map(event => [event.id, [event.closed_reason, event.closed_at]])), expected);
    }
  } finally {
    await app.close();
    await backend.close();
  }
});
