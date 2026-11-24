import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { DevicesService, provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

test('运营HTTP：家庭简报、当前绑定失败队列、幂等重试与Worker恢复共同运行', async () => {
  process.env.DATA_MODE = 'offline';
  const backend = await openBackendFixture(() => new Date('2026-11-17T06:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    async function api(path: string, options: { method?: string; body?: unknown; token?: string; deviceToken?: string; key?: string; status?: number } = {}) {
      const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.deviceToken ? { 'x-device-token': options.deviceToken } : {}), ...(options.key ? { 'Idempotency-Key': options.key } : {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(5000) });
      const result = await response.json() as any;
      assert.equal(response.status, options.status ?? (options.method === 'POST' ? 201 : 200), JSON.stringify(result));
      return result;
    }
    const register = (name: string) => api('/auth/register', { method: 'POST', body: { email: `${name}@example.invalid`, password: 'Synthetic-operations-http-2026' } });
    const owner = await register('operations-owner'), viewer = await register('operations-viewer'), outsider = await register('operations-outsider');
    const invite = await api(`/households/${owner.household.id}/invitations`, { method: 'POST', token: owner.access_token, body: { email: viewer.user.email, role: 'viewer' } });
    await api(`/invitations/${invite.token}/accept`, { method: 'POST', token: viewer.access_token, status: 200 });
    const pet = await api('/pets', { method: 'POST', token: owner.access_token, body: { household_id: owner.household.id, name: '运营HTTP合成宠物' } });
    const device = await provisionDevice(db, { serial_no: 'OPERATIONS-HTTP' });
    await api('/devices/claim', { method: 'POST', token: owner.access_token, body: { device_id: device.device_id, claim_code: device.claim_code, pet_id: pet.id } });
    const envelope = { schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'operations-http', seq: 1,
      event_type: 'location.reported', device_ts: db.now(), payload: { lat: 31.234567, lon: 121.456789, accuracy_m: 5, source: 'gnss', signal: { private: 'raw-http-signal' } } };
    await api('/ingest/events', { method: 'POST', deviceToken: device.device_token, body: envelope, status: 202 });
    await db.run("UPDATE device_events SET process_status='dead',attempts=5,error='Error' WHERE event_id=?", envelope.event_id);
    const householdPath = `/households/${owner.household.id}/operations`;
    const failuresPath = `/pets/${pet.id}/telemetry-failures`;
    const retryPath = `/ingest/events/${envelope.event_id}/retry`;
    const summary = await api(householdPath, { token: viewer.access_token });
    assert.equal(summary.mode, 'offline'); assert.equal(summary.queue.dead, 1); assert.equal(summary.totals.devices, 1);
    assert.equal(summary.location_quality.good_point_ratio, null);
    const failures = await api(failuresPath, { token: viewer.access_token });
    assert.equal(failures.items.length, 1); assert.equal(failures.items[0].event_id, envelope.event_id);
    assert.equal(failures.items[0].process_status, 'dead');
    const redacted = JSON.stringify({ summary, failures });
    for (const value of ['"lat"', '"lon"', 'raw-http-signal', 'payload_json', 'envelope_json', device.device_token, device.claim_code]) assert.ok(!redacted.includes(value), value);
    await api(householdPath, { token: outsider.access_token, status: 404 });
    await api(failuresPath, { token: outsider.access_token, status: 404 });
    await api(retryPath, { method: 'POST', token: viewer.access_token, body: { reason: 'Viewer must not retry' }, status: 403 });
    const options = { method: 'POST', token: owner.access_token, body: { reason: 'Worker maintenance complete' }, key: 'http-retry', status: 202 };
    const queued = await api(retryPath, options);
    assert.equal(queued.event_id, envelope.event_id); assert.equal(queued.status, 'pending');
    assert.deepEqual(await api(retryPath, options), queued);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='telemetry.retry'"))!.n, 1);
    assert.equal(await app.get(TelemetryService).work(), 1);
    assert.equal((await api(failuresPath, { token: owner.access_token })).items.length, 0);
    const after = await api(householdPath, { token: owner.access_token });
    assert.equal(after.queue.dead, 0); assert.equal(after.telemetry.counts_by_status.processed, 1);
    assert.equal(after.location_quality.good_point_ratio, 1); assert.equal(after.devices[0].location.usable_for_tracking, true);
    assert.deepEqual(JSON.parse((await db.get('SELECT envelope_json FROM device_events WHERE event_id=?', envelope.event_id))!.envelope_json), envelope);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM locations WHERE event_id=?', envelope.event_id))!.n, 1);
    await api(retryPath, { ...options, key: 'another-retry', status: 409 });
    const schema = await (await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
    for (const path of ['/api/v1/households/{id}/operations', '/api/v1/pets/{id}/telemetry-failures', '/api/v1/ingest/events/{id}/retry']) assert.ok(schema.paths[path], path);
    await new DevicesService(db).unbind(owner.user.id, device.device_id);
    await api(retryPath, { ...options, status: 404 });
  } finally { await app.close(); await backend.close(); }
});
