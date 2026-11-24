import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';
import { provisionDevice } from '../src/devices';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';

test('HTTP：家庭绑定→异步定位→越界→返回→通知→照护，重复和乱序不破坏结果', async () => {
  process.env.DATA_MODE = 'offline';
  process.env.PUSH_MODE = 'mock';
  let now = new Date('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => now), db = backend.db, app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    async function api(path: string, options: { method?: string; body?: unknown; token?: string; deviceToken?: string; status?: number } = {}) {
      const response = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET', headers: { 'content-type': 'application/json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.deviceToken ? { 'x-device-token': options.deviceToken } : {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const body = await response.json() as any;
      assert.ok(response.headers.get('x-request-id'));
      if (options.status) assert.equal(response.status, options.status, JSON.stringify(body));
      else assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(body)}`);
      return body;
    }
    const unauthorized = await api('/pets', { status: 401 });
    assert.ok(unauthorized.code && unauthorized.request_id);
    const owner = await api('/auth/register', { method: 'POST', body: { email: 'owner-e2e@example.invalid', password: 'Offline-test-password' } });
    const visitor = await api('/auth/register', { method: 'POST', body: { email: 'viewer-e2e@example.invalid', password: 'Offline-test-password' } });
    const ownerToken = owner.access_token, visitorToken = visitor.access_token;
    const pet = await api('/pets', { method: 'POST', token: ownerToken, body: { household_id: owner.household.id, name: '合成豆吉', species: 'dog' } });
    await api(`/pets/${pet.id}`, { token: visitorToken, status: 404 });
    const invitation = await api(`/households/${owner.household.id}/invitations`, { method: 'POST', token: ownerToken, body: { email: visitor.user.email, role: 'viewer' } });
    await api(`/invitations/${invitation.token}/accept`, { method: 'POST', token: visitorToken });
    assert.equal((await api(`/pets/${pet.id}`, { token: visitorToken })).id, pet.id);
    await api(`/pets/${pet.id}`, { method: 'PATCH', token: visitorToken, body: { name: '不能修改' }, status: 403 });
    const device = (await provisionDevice(db, { serial_no: 'E2E-SYNTHETIC-001' }));
    await api('/devices/claim', { method: 'POST', token: ownerToken, body: { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code } });
    const fixture = JSON.parse(readFileSync(resolve('fixtures/walk.json'), 'utf8'));
    const fence = await api('/geofences', { method: 'POST', token: ownerToken, body: { pet_id: pet.id, name: '安全区', geometry: fixture.geometry, buffer_m: 10, confirm_points: 2 } });
    assert.ok(fence.id);
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
    let seq = 0;
    const events = fixture.locations.map(({ relative_time_seconds, ...payload }: any) => ({
      schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'test-boot',
      device_ts: at(relative_time_seconds), seq: seq++, event_type: 'location.reported', payload,
    }));
    const worker = app.get(TelemetryService);
    for (const event of events) {
      await api('/ingest/events', { method: 'POST', deviceToken: device.device_token, body: event, status: 202 });
      assert.equal((await db.get('SELECT process_status FROM device_events WHERE event_id=?', event.event_id))!.process_status, 'pending');
      await worker.work();
    }
    const duplicate = await api('/ingest/events', { method: 'POST', deviceToken: device.device_token, body: events[1] });
    assert.equal(duplicate.duplicate, true);
    await worker.work();
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM locations WHERE pet_id=?', pet.id))!.count, 5);
    const allEvents = (await db.all('SELECT * FROM safety_events WHERE pet_id=?', pet.id));
    assert.equal(allEvents.filter(event => event.type === 'geofence.exited').length, 1);
    assert.equal(allEvents.filter(event => event.type === 'geofence.entered').length, 1);
    assert.equal(allEvents.filter(event => event.type === 'battery.low').length, 1);
    const exit = allEvents.find(event => event.type === 'geofence.exited')!;
    assert.ok(exit.closed_at);
    const last = await api(`/pets/${pet.id}/location/latest`, { token: ownerToken });
    assert.equal(last.device_ts, at(-40));
    assert.equal(last.freshness, 'fresh');
    const firstPage = await api(`/pets/${pet.id}/locations?limit=2`, { token: ownerToken });
    assert.equal(firstPage.items.length, 2);
    assert.ok(firstPage.next_cursor);
    const secondPage = await api(`/pets/${pet.id}/locations?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor)}`, { token: ownerToken });
    assert.equal(secondPage.items.length, 2);
    assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
    await api('/ingest/events', { method: 'POST', deviceToken: device.device_token, body: {
      ...events[0], event_id: randomUUID(), seq: seq++, device_ts: at(-240),
    }, status: 202 });
    await worker.work();
    assert.equal((await api(`/pets/${pet.id}/location/latest`, { token: ownerToken })).device_ts, at(-40));
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM safety_events WHERE pet_id=? AND type='geofence.exited'", pet.id))!.count, 1);
    await api('/ingest/events', { method: 'POST', deviceToken: 'wrong-device-token', body: events[0], status: 401 });
    const activity = fixture.activity;
    await api('/ingest/events', { method: 'POST', deviceToken: device.device_token, body: {
      schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'test-boot', device_ts: at(-20), seq: seq++, event_type: 'activity.reported',
      payload: { start_at: at(activity.start_relative_seconds), end_at: at(activity.end_relative_seconds), steps: activity.steps, active_seconds: activity.active_seconds, estimated: true },
    }, status: 202 });
    await worker.work();
    const daily = await api(`/pets/${pet.id}/activity/daily?date=2026-11-17&timezone=Asia/Shanghai`, { token: visitorToken });
    assert.equal(daily.steps, 600);
    assert.equal(daily.active_minutes, 5);
    assert.equal(daily.sleep_minutes, null);
    const care = await api('/care-records', { method: 'POST', token: ownerToken, body: { pet_id: pet.id, type: 'weight', value: { weight_kg: 12.5 }, recorded_at: at(-10), source: 'owner' } });
    await api(`/care-records/${care.id}`, { method: 'PATCH', token: ownerToken, body: { value: { weight_kg: 12.8 } } });
    assert.equal((await api(`/care-records/${care.id}/history`, { token: ownerToken })).revisions.length, 1);
    await app.get(NotificationService).dispatch();
    const notifications = await api('/notifications', { token: ownerToken });
    assert.ok(notifications.items.length >= 3);
    now = new Date(now.getTime() + 600_000);
    await worker.runMaintenance();
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM safety_events WHERE pet_id=? AND type='device.offline'", pet.id))!.count, 1);
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM safety_events WHERE pet_id=? AND type='location.stale'", pet.id))!.count, 1);
    await worker.runMaintenance();
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM safety_events WHERE pet_id=? AND type='device.offline'", pet.id))!.count, 1);
    const state = await api(`/devices/${device.device_id}`, { token: ownerToken });
    assert.equal(state.state.connection_status, 'offline');
    assert.equal(state.state.data_freshness, 'stale');
    await api(`/households/${owner.household.id}/members/${visitor.user.id}`, { method: 'DELETE', token: ownerToken });
    await api(`/pets/${pet.id}/location/latest`, { token: visitorToken, status: 404 });
    const refreshed = await api('/auth/refresh', { method: 'POST', body: { refresh_token: owner.refresh_token } });
    await api('/auth/me', { token: ownerToken, status: 401 });
    await api('/auth/logout', { method: 'POST', token: refreshed.access_token });
    await api('/auth/me', { token: refreshed.access_token, status: 401 });
  } finally { await app.close(); await backend.close(); }
});
