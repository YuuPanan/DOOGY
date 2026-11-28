import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { NotificationService } from '../src/notifications';
import { TelemetryService } from '../src/telemetry';
import { privacyMaintenance } from '../scripts/privacy-maintenance';
import { openBackendFixture } from './backend-fixture';

test('库存保留HTTP/维护：管理员配置预览、双数据库清理、家庭隔离、去重和Swagger', async () => {
  process.env.DATA_MODE = 'offline'; process.env.DEVICE_ADMIN_USER_IDS = '';
  let time = Date.parse('2026-11-01T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(time)), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/api/v1`;
    async function api(path: string, options: { method?: string; body?: unknown; token?: string; deviceToken?: string; status?: number; noStore?: boolean } = {}) {
      const response = await fetch(base + path, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.deviceToken ? { 'x-device-token': options.deviceToken } : {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(5000) });
      const value = await response.json() as any;
      assert.equal(response.status, options.status ?? 200, JSON.stringify(value));
      if (options.noStore) assert.match(response.headers.get('cache-control') ?? '', /no-store/);
      return value;
    }
    const password = 'Synthetic-inventory-http-2026', identity = new IdentityService(db), devices = new DevicesService(db);
    const admin = await identity.register({ email: 'inventory-http-admin@example.invalid', password });
    const owner = await identity.register({ email: 'inventory-http-owner@example.invalid', password });
    const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Inventory HTTP control pet' });
    process.env.DEVICE_ADMIN_USER_IDS = admin.user.id;
    const inventory = await provisionDevice(db, { serial_no: 'INVENTORY-HTTP-STOCK' });
    const family = await provisionDevice(db, { serial_no: 'INVENTORY-HTTP-FAMILY' });
    await devices.claim(owner.user.id, { ...family, pet_id: pet.id });
    const telemetry = new TelemetryService(db, devices, new NotificationService(db));
    const packet = { schema_version: '1.0', event_id: randomUUID(), device_id: inventory.device_id, device_ts: db.now(),
      seq: 1, boot_id: 'inventory-http', event_type: 'location.reported', source_metadata: { private: 'HTTP-STOCK-VENDOR-PRIVATE' },
      payload: { lat: 31.23, lon: 121.47, accuracy_m: 5, source: 'gnss', signal: { private: 'HTTP-STOCK-SIGNAL-PRIVATE' } } };
    await telemetry.ingest(packet, inventory.device_token);
    const familyPacket = { ...packet, event_id: randomUUID(), device_id: family.device_id, payload: { ...packet.payload, signal: { private: 'HTTP-FAMILY-PRIVATE' } } };
    await telemetry.ingest(familyPacket, family.device_token); await telemetry.work();
    const familyState = await db.get('SELECT * FROM device_state WHERE device_id=?', family.device_id);
    time += 3 * 86400000;
    const adminSession = await identity.login({ email: admin.user.email, password }), ownerSession = await identity.login({ email: owner.user.email, password });
    const path = '/admin/retention/inventory';
    await api(path, { status: 401 });
    await api(path, { token: ownerSession.access_token, status: 403 });
    const initial = await api(path, { token: adminSession.access_token, noStore: true }); assert.equal(initial.enabled, false);
    await api(path, { method: 'PATCH', token: adminSession.access_token, body: { password: 'Wrong-inventory-password', enabled: true }, status: 401 });
    await api(path, { method: 'PATCH', token: adminSession.access_token, body: { password, enabled: true, telemetry_days: 0 }, status: 400 });
    await api(path, { method: 'PATCH', token: ownerSession.access_token, body: { password, enabled: true }, status: 403 });
    await api(path, { method: 'PATCH', token: adminSession.access_token, body: { password, enabled: false, telemetry_days: 2 } });
    const preview = await api(path + '/preview', { method: 'POST', token: adminSession.access_token, noStore: true });
    assert.equal(preview.counts.telemetry_payloads, 1); assert.equal(preview.counts.device_signal, 1);
    assert.equal((await api(path + '/run', { method: 'POST', token: adminSession.access_token, body: { password } })).skipped, 'disabled');
    assert.deepEqual((await privacyMaintenance(db, 'inventory-preview')).counts, preview.counts);
    assert.equal((await privacyMaintenance(db, 'inventory-run')).skipped, 'disabled');
    assert.notEqual((await db.get('SELECT envelope_json FROM device_events WHERE event_id=?', packet.event_id))!.envelope_json, '{}');
    await api(path, { method: 'PATCH', token: adminSession.access_token, body: { password, enabled: true, telemetry_days: 2 } });
    const executed = await privacyMaintenance(db, 'inventory-run'); assert.deepEqual(executed.counts, preview.counts);
    assert.equal((await db.get('SELECT envelope_json FROM device_events WHERE event_id=?', packet.event_id))!.envelope_json, '{}');
    assert.equal((await db.get('SELECT signal_json FROM device_state WHERE device_id=?', inventory.device_id))!.signal_json, null);
    assert.deepEqual(await db.get('SELECT * FROM device_state WHERE device_id=?', family.device_id), familyState);
    assert.notEqual((await db.get('SELECT envelope_json FROM device_events WHERE event_id=?', familyPacket.event_id))!.envelope_json, '{}');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM locations WHERE pet_id=?', pet.id))!.n, 1);
    const duplicate = await api('/ingest/events', { method: 'POST', deviceToken: inventory.device_token, body: packet, status: 409 });
    assert.equal(duplicate.code, 'EVENT_DATA_EXPIRED');
    await api(path + '/preview', { method: 'POST', token: ownerSession.access_token, status: 403 });
    const empty = await api(path + '/run', { method: 'POST', token: adminSession.access_token, body: { password } });
    assert.ok(Object.values(empty.counts).every(value => value === 0));
    const returned = JSON.stringify({ initial, preview, executed, empty });
    for (const secret of [adminSession.access_token, inventory.device_token, inventory.claim_code, password, 'HTTP-STOCK-VENDOR-PRIVATE', 'HTTP-STOCK-SIGNAL-PRIVATE', 'HTTP-FAMILY-PRIVATE']) assert.ok(!returned.includes(secret), 'Inventory response leaked private data');
    const schema = await (await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
    for (const endpoint of [path, path + '/preview', path + '/run']) assert.ok(schema.paths['/api/v1' + endpoint], endpoint);
    assert.ok(schema.paths['/api/v1' + path].get); assert.ok(schema.paths['/api/v1' + path].patch);
  } finally { process.env.DEVICE_ADMIN_USER_IDS = ''; await app.close(); await backend.close(); }
});
