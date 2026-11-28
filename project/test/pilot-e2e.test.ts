import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';
import { CareService } from '../src/care';

test('试点HTTP：走失分享、客服授权/处理/撤销、日汇总和观察接口共同运行', async () => {
  process.env.DATA_MODE = 'offline';
  delete process.env.SUPPORT_ADMIN_USER_IDS;
  const backend = await openBackendFixture(() => new Date('2026-11-17T06:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    async function api(path: string, method = 'GET', body?: unknown, token?: string, deviceToken?: string, expected?: number) {
      const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(deviceToken ? { 'x-device-token': deviceToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json() as any;
      if (expected) assert.equal(response.status, expected, JSON.stringify(value));
      else assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`);
      return value;
    }
    const owner = await api('/auth/register', 'POST', { email: 'pilot-owner@example.invalid', password: 'Synthetic-pilot-2026', timezone: 'UTC' });
    const staff = await api('/auth/register', 'POST', { email: 'pilot-staff@example.invalid', password: 'Synthetic-pilot-2026' });
    process.env.SUPPORT_ADMIN_USER_IDS = staff.user.id;
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: '试点合成宠物' }, owner.access_token);
    const device = (await provisionDevice(db, { serial_no: 'PILOT-HTTP' }));
    await api('/devices/claim', 'POST', { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code }, owner.access_token);
    await api('/ingest/events', 'POST', { schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
      event_type: 'location.reported', device_ts: db.now(), seq: 1, boot_id: 'pilot-boot',
      payload: { lat: 31.23, lon: 121.47, accuracy_m: 12, source: 'gnss', battery_pct: 75 } }, undefined, device.device_token, 202);
    await app.get(TelemetryService).work();
    await api(`/devices/${device.device_id}/lost-mode`, 'POST', { enabled: true, expires_in_seconds: 600 }, owner.access_token);
    const share = await api(`/pets/${pet.id}/location-shares`, 'POST', { consent: true, expires_in_seconds: 3600 }, owner.access_token);
    assert.equal(share.expires_at, '2026-11-17T06:10:00.000Z');
    const shared = await api(share.public_path.replace('/api/v1', ''));
    assert.equal(shared.location.lat, 31.23);
    assert.equal(shared.location.usable_for_tracking, true);
    assert.ok(!JSON.stringify(shared).includes(device.device_token));
    assert.ok(!JSON.stringify(shared).includes(owner.user.email));
    const ticket = await api('/support/tickets', 'POST', { device_id: device.device_id, category: 'location',
      description: '合成定位排障', diagnostics_consent: true }, owner.access_token);
    await api('/admin/support/tickets', 'GET', undefined, owner.access_token, undefined, 403);
    const diagnosticsPath = `/admin/devices/${device.device_id}/diagnostics?ticket_id=${ticket.id}`;
    const diagnostics = await api(diagnosticsPath, 'GET', undefined, staff.access_token);
    assert.equal(diagnostics.snapshot.telemetry.event_count, 1);
    assert.ok(!JSON.stringify(diagnostics.snapshot).includes('"lat"'));
    assert.ok(!JSON.stringify(diagnostics.snapshot).includes(device.device_token));
    const updated = await api(`/admin/support/tickets/${ticket.id}`, 'PATCH', { status: 'in_progress', reply: '正在检查合成数据' }, staff.access_token);
    assert.equal(updated.status, 'in_progress');
    assert.equal((await api(`/support/tickets/${ticket.id}`, 'GET', undefined, owner.access_token)).history.length, 2);
    await api(`/support/tickets/${ticket.id}/diagnostics-consent`, 'DELETE', undefined, owner.access_token);
    await api(diagnosticsPath, 'GET', undefined, staff.access_token, undefined, 404);
    await api(`/devices/${device.device_id}/lost-mode`, 'POST', { enabled: false }, owner.access_token);
    await api(share.public_path.replace('/api/v1', ''), 'GET', undefined, undefined, undefined, 404);
    const daily = await api(`/pets/${pet.id}/activity/daily?date=2026-11-16`, 'GET', undefined, owner.access_token);
    assert.equal(daily.aggregation_version, 'daily-v2');
    assert.equal(daily.steps, null);
    assert.deepEqual(await api(`/pets/${pet.id}/activity/daily?date=2026-11-16`, 'GET', undefined, owner.access_token), daily);
    const observation = await api(`/pets/${pet.id}/observations`, 'GET', undefined, owner.access_token);
    assert.equal(observation.local_date, '2026-11-16');
    assert.equal(observation.status, 'insufficient_data');
    assert.equal(observation.model_output, null);
    assert.deepEqual(observation.observations, []);
    const schema = await (await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
    for (const route of ['/api/v1/pets/{id}/location-shares', '/api/v1/support/tickets', '/api/v1/pets/{id}/observations']) assert.ok(schema.paths[route], route);
  } finally { await app.close(); await backend.close(); delete process.env.SUPPORT_ADMIN_USER_IDS; }
});

test('替换设备补传的重叠活动不能使同一宠物日汇总重复计数', async () => {
  process.env.DATA_MODE = 'offline';
  const backend = await openBackendFixture(() => new Date('2026-11-17T06:00:00Z')), db = backend.db;
  try {
    const identity = new IdentityService(db), devices = new DevicesService(db);
    const owner = (await identity.register({ email: 'replacement@example.invalid', password: 'Synthetic-pilot-2026' }));
    const pet = (await identity.createPet(owner.user.id, { household_id: owner.household.id, name: '替换设备宠物' }));
    const telemetry = new TelemetryService(db, devices, new NotificationService(db));
    for (let n = 1; n <= 2; n++) {
      const device = (await provisionDevice(db, { serial_no: `REPLACEMENT-${n}` }));
      await devices.claim(owner.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
      const event = { schema_version: '1.0', event_id: `replacement-event-${n}`, device_id: device.device_id, boot_id: 'replacement', seq: 1,
        device_ts: db.now(), event_type: 'activity.reported', payload: { start_at: '2026-11-17T05:40:00Z', end_at: '2026-11-17T05:50:00Z', steps: 600, active_seconds: 300 } };
      await telemetry.ingest(event, device.device_token); await telemetry.work();
      if (n === 1) await devices.unbind(owner.user.id, device.device_id);
      else assert.equal((await telemetry.event(owner.user.id, event.event_id)).process_status, 'dead');
    }
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM activity_samples'))!.n, 1);
    assert.equal((await new CareService(db).daily(owner.user.id, pet.id, { date: '2026-11-17' })).steps, 600);
  } finally { await backend.close(); }
});
