import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';

test('续开发HTTP：幂等建宠/围栏、策略与走失回执、持续越界、确认与质量概览', async () => {
  process.env.DATA_MODE = 'offline';
  let now = new Date('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => now), db = backend.db, app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, key?: string, deviceToken?: string, status?: number) {
      const response = await fetch(`${base}${path}`, { method,
        headers: { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}), ...(deviceToken ? { 'x-device-token': deviceToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json() as any;
      if (status) assert.equal(response.status, status, JSON.stringify(result));
      else assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
      return result;
    }
    const account = await api('/auth/register', 'POST', { email: 'development-e2e@example.invalid', password: 'Synthetic-development-2026', timezone: 'America/New_York' });
    access = account.access_token;
    const input = { household_id: account.household.id, name: '续开发合成宠物' };
    const pet = await api('/pets', 'POST', input, 'pet-create-1');
    assert.deepEqual(await api('/pets', 'POST', input, 'pet-create-1'), pet);
    assert.equal(pet.effective_timezone, 'America/New_York');
    await api('/pets', 'POST', { ...input, name: '不同内容' }, 'pet-create-1', undefined, 409);
    await api(`/households/${account.household.id}`, 'PATCH', { timezone: 'Europe/London' });
    assert.equal((await api(`/pets/${pet.id}/activity/daily`)).timezone, 'Europe/London');

    const device = (await provisionDevice(db, { serial_no: 'DEVELOPMENT-E2E' }));
    await api('/devices/claim', 'POST', { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    const policyPath = `/devices/${device.device_id}/reporting-policy`;
    const requested = await api(policyPath, 'PUT', { mode: 'home_idle', interval_seconds: 600 });
    assert.equal(requested.status, 'pending');
    assert.equal(requested.applied_version, null);
    const ackCommand = async (commandId: string, version: number) => (await api(`/device-ingress/${device.device_id}/commands/${commandId}/ack`, 'POST',
      { status: 'applied', applied_version: version }, undefined, device.device_token));
    assert.equal((await api(`/device-ingress/${device.device_id}/commands`, 'GET', undefined, undefined, device.device_token)).items.length, 1);
    const applied = await ackCommand(requested.command_id, requested.desired_version);
    assert.equal(applied.execution_source, 'simulator');
    assert.equal((await api(policyPath)).timing.offline_seconds, 1800);
    const lost = await api(`/devices/${device.device_id}/lost-mode`, 'POST', { enabled: true, expires_in_seconds: 120 });
    assert.equal(lost.applied.mode, 'home_idle');
    assert.equal(lost.status, 'pending');
    await ackCommand(lost.command_id, lost.desired_version);
    assert.equal((await api(policyPath)).applied.mode, 'alert');
    const restore = await api(`/devices/${device.device_id}/lost-mode`, 'POST', { enabled: false });
    assert.equal(restore.status, 'pending');
    await ackCommand(restore.command_id, restore.desired_version);
    assert.equal((await api(policyPath)).applied.mode, 'home_idle');

    const fenceInput = { pet_id: pet.id, name: '动态安全区', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 },
      dynamic_buffer: true, min_buffer_m: 15, confirm_points: 2, min_exit_seconds: 30 };
    const fence = await api('/geofences', 'POST', fenceInput, 'fence-create-1');
    assert.deepEqual(await api('/geofences', 'POST', fenceInput, 'fence-create-1'), fence);
    let seq = 0;
    async function location(lat: number, accuracy = 10) {
      const event = { schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'development-boot',
        seq: seq++, device_ts: now.toISOString(), event_type: 'location.reported', transport: 'simulator', source_metadata: { fixture: 'development-e2e' },
        payload: { lat, lon: 121.47, accuracy_m: accuracy, source: 'gnss' } };
      await api('/ingest/events', 'POST', event, undefined, device.device_token, 202);
      assert.equal((await app.get(TelemetryService).work()), 1);
      return event.event_id;
    }
    await location(31.23);
    now = new Date(now.getTime() + 10_000); await location(31.232);
    now = new Date(now.getTime() + 10_000); await location(31.232);
    assert.equal((await api(`/pets/${pet.id}/safety-events`)).items.length, 0);
    now = new Date(now.getTime() + 20_000); await location(31.232);
    const events = await api(`/pets/${pet.id}/safety-events`);
    assert.equal(events.items.length, 1);
    const exit = events.items[0];
    assert.equal(exit.type, 'geofence.exited');
    const ack = await api(`/safety-events/${exit.id}/ack`, 'POST', { note: '主人开始寻找' }, 'ack-create-1');
    assert.equal(ack.event_status, 'open');
    assert.deepEqual(await api(`/safety-events/${exit.id}/ack`, 'POST', { note: '主人开始寻找' }, 'ack-create-1'), ack);
    const detail = await api(`/safety-events/${exit.id}`);
    assert.equal(detail.delivery_status, 'unknown');
    assert.equal(detail.acknowledgement.user_id, account.user.id);
    now = new Date(now.getTime() + 20_000); const eventId = await location(31.232, 500);
    const latest = await api(`/pets/${pet.id}/location/latest`);
    assert.equal(latest.usable_for_tracking, false);
    assert.equal(latest.last_usable_location.usable_for_tracking, true);
    const overview = await api(`/pets/${pet.id}/overview`);
    assert.equal(overview.location.usable_for_tracking, false);
    assert.equal(overview.device.timing.offline_seconds, 1800);
    const page = await api(`/pets/${pet.id}/locations?limit=2`);
    assert.ok(page.range.from && page.range.to && page.next_cursor);
    await api(`/pets/${pet.id}/locations?from=2026-01-01T00:00:00Z&to=2026-11-17T00:00:00Z`, 'GET', undefined, undefined, undefined, 400);
    assert.ok((await api(`/ingest/events/${eventId}`)).processed_at);
    const schema = await (await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/devices/{id}/reporting-policy']);
    assert.ok(schema.paths['/api/v1/safety-events/{id}/ack']);
  } finally { await app.close(); await backend.close(); }
});
