import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`今日概览HTTP：${mode}模式的围栏、待办、当前策略和数据缺口在双驱动一致`, async () => {
  process.env.DATA_MODE = mode; process.env.FRESH_SECONDS = '300'; process.env.OFFLINE_SECONDS = '300';
  let now = Date.parse('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db, app = await createApp({ db, quiet: true });
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(route: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token = access, deviceToken?: string) {
      const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(deviceToken ? { 'x-device-token': deviceToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const result = await response.json() as any; assert.equal(response.status, expected, JSON.stringify(result)); return result;
    }
    const password = 'Synthetic-overview-http-2026';
    const register = (name: string) => api('/auth/register', 'POST', { email: `overview-${name}-${mode}@example.invalid`, password, timezone: 'UTC' });
    const owner = await register('owner'), viewer = await register('viewer'), outsider = await register('outsider'); access = owner.access_token;
    const invitation = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, 200, viewer.access_token);
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'HTTP overview pet' });
    const overviewPath = `/pets/${pet.id}/overview`, historicalPath = `${overviewPath}?date=2026-11-16`;
    await api(overviewPath, 'GET', undefined, 401, ''); await api(overviewPath, 'GET', undefined, 404, outsider.access_token);
    const empty = await api(historicalPath);
    assert.equal(empty.current_state_at, db.now()); assert.equal(empty.activity.local_date, '2026-11-16'); assert.equal(empty.pet.id, pet.id);
    assert.equal(empty.device, null); assert.equal(empty.location, null); assert.deepEqual(empty.care_records, []); assert.deepEqual(empty.safety_events, []);
    assert.deepEqual(empty.data_gaps, { activity_period: ['activity_missing'], current_state: ['device_unbound', 'location_missing', 'geofence_unconfigured'] });
    const device = await provisionDevice(db, { serial_no: `OVERVIEW-E2E-${mode}` });
    await api('/devices/claim', 'POST', { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    assert.deepEqual((await api(overviewPath)).location_wait, { status: 'waiting', elapsed_seconds: 0 });
    now += 599_000;
    assert.deepEqual((await api(overviewPath)).location_wait, { status: 'waiting', elapsed_seconds: 599 });
    now += 1000;
    const late = await api(overviewPath);
    assert.deepEqual(late.location_wait, { status: 'delayed', elapsed_seconds: 600 });
    assert.equal(late.location, null);
    const fence = await api('/geofences', 'POST', { pet_id: pet.id, name: 'HTTP overview fence', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 } });
    const policy = await api(`/devices/${device.device_id}/reporting-policy`, 'PUT', { mode: 'home_active', interval_seconds: 120 });
    assert.equal((await api(overviewPath)).device.reporting.status, 'pending');
    await api(`/device-ingress/${device.device_id}/commands/${policy.command_id}/ack`, 'POST', { status: 'applied', applied_version: policy.desired_version }, 200, '', device.device_token);
    let seq = 0;
    async function location(lat: number, accuracy = 10) {
      await api('/ingest/events', 'POST', { schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
        boot_id: 'overview-http', seq: seq++, device_ts: db.now(), event_type: 'location.reported',
        payload: { lat, lon: 121.47, accuracy_m: accuracy, source: 'gnss' } }, 202, '', device.device_token);
      assert.equal(await app.get(TelemetryService).work(), 1);
    }
    await location(31.23); now += 10_000; await location(31.232); now += 10_000; await location(31.232);
    const current = await api(historicalPath, 'GET', undefined, 200, viewer.access_token);
    assert.equal(current.location_wait, null);
    assert.equal(current.current_state_at, db.now()); assert.equal(current.activity.local_date, '2026-11-16');
    assert.equal(current.geofences.items[0].id, fence.id); assert.equal(current.geofences.items[0].state.effective_status, 'outside');
    assert.deepEqual(current.data_gaps.current_state, []); assert.equal(current.device.reporting.status, 'applied');
    assert.equal(current.device.reporting.execution_source, mode === 'offline' ? 'simulator' : 'device');
    assert.equal(current.attention.open_event_count, 1); assert.equal(current.attention.unacknowledged_open_event_count, 1); assert.equal(current.attention.unread_notification_count, 1);
    const eventId = current.attention.unacknowledged_open_events[0].id, viewerNote = current.attention.unread_notifications[0].id;
    const ownerCurrent = await api(overviewPath), ownerNote = ownerCurrent.attention.unread_notifications[0].id;
    assert.notEqual(ownerNote, viewerNote);
    await api(`/safety-events/${eventId}/ack`, 'POST', { note: 'owner following up' });
    const acknowledged = await api(overviewPath, 'GET', undefined, 200, viewer.access_token);
    assert.equal(acknowledged.attention.open_event_count, 1); assert.equal(acknowledged.attention.unacknowledged_open_event_count, 0); assert.equal(acknowledged.attention.unread_notification_count, 1);
    await api(`/notifications/${viewerNote}/read`, 'PATCH', undefined, 200, viewer.access_token);
    assert.equal((await api(overviewPath, 'GET', undefined, 200, viewer.access_token)).attention.unread_notification_count, 0);
    assert.equal((await api(overviewPath)).attention.unread_notification_count, 1);
    now += 10_000; await location(31.232, 500);
    const uncertain = await api(overviewPath);
    assert.ok(uncertain.location.last_usable_location.usable_for_tracking); assert.equal(uncertain.geofences.items[0].state.effective_status, 'unknown');
    assert.deepEqual(uncertain.data_gaps.current_state, ['location_unusable', 'geofence_state_unknown']);
    const lost = await api(`/devices/${device.device_id}/lost-mode`, 'POST', { enabled: true, expires_in_seconds: 60 });
    assert.equal((await api(overviewPath)).device.reporting.lost_mode.enabled, true);
    const commands = await db.all('SELECT * FROM device_commands ORDER BY id'), sessions = await db.all('SELECT * FROM lost_mode_sessions ORDER BY id'), audits = await db.all('SELECT * FROM audit_logs ORDER BY id');
    now += 361_000;
    const stale = await api(historicalPath);
    assert.equal(stale.current_state_at, db.now()); assert.equal(stale.activity.local_date, '2026-11-16');
    assert.deepEqual(stale.data_gaps.current_state, ['device_offline', 'location_unusable', 'geofence_state_unknown']);
    assert.equal(stale.device.reporting.command_id, lost.command_id); assert.equal(stale.device.reporting.status, 'expired'); assert.equal(stale.device.reporting.lost_mode.enabled, false);
    assert.deepEqual(await db.all('SELECT * FROM device_commands ORDER BY id'), commands); assert.deepEqual(await db.all('SELECT * FROM lost_mode_sessions ORDER BY id'), sessions); assert.deepEqual(await db.all('SELECT * FROM audit_logs ORDER BY id'), audits);
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, 'DELETE');
    await api(overviewPath, 'GET', undefined, 404, viewer.access_token);
    await api(`${overviewPath}?date=2026-02-30`, 'GET', undefined, 400); await api(`${overviewPath}?timezone=Invalid/Zone`, 'GET', undefined, 400);
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/pets/{id}/overview'].get); assert.equal(externalCalls, 0); assert.equal((await api('/health')).mode, mode);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
