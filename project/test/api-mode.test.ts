import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';
import { DevicesService, provisionDevice } from '../src/devices';
import { IdentityService } from '../src/identity';
import { TelemetryService } from '../src/telemetry';
import { importOffline } from '../scripts/import-offline';

test('API 模式：真实 HTTP 原始体签名进入共用队列，篡改被拒绝，OpenAPI 可读取', async () => {
  process.env.DATA_MODE = 'api';
  process.env.VENDOR_WEBHOOK_SECRET = 'synthetic-vendor-secret-for-http-contract';
  const backend = await openBackendFixture(() => new Date('2026-11-17T06:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    const identity = app.get(IdentityService), devices = app.get(DevicesService);
    const account = (await identity.register({ email: 'vendor-http@example.invalid', password: 'Synthetic-password-2026' }));
    const pet = (await identity.createPet(account.user.id, { household_id: account.household.id, name: 'API 合成宠物' }));
    const device = (await provisionDevice(db, { serial_no: 'API-HTTP-TEST' }));
    await devices.claim(account.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl(), timestamp = String(db.clock().getTime() / 1000);
    const raw = JSON.stringify({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
      event_type: 'location.reported', boot_id: 'http-boot', seq: 1, device_ts: db.now(),
      payload: { lat: 31.23, lon: 121.47, accuracy_m: 10, source: 'gnss' } }, null, 2);
    const signature = createHmac('sha256', process.env.VENDOR_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
    const send = (body: string) => fetch(`${base}/api/v1/integrations/vendor/events`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-doogy-timestamp': timestamp, 'x-doogy-signature': signature }, body });
    assert.equal((await send(raw)).status, 202);
    assert.equal((await send(raw.replace('31.23', '32.23'))).status, 401);
    const duplicate = await send(raw);
    assert.equal((await duplicate.json() as any).duplicate, true);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM locations'))!.n, 0);
    await app.get(TelemetryService).work();
    assert.equal((await app.get(TelemetryService).latest(account.user.id, pet.id))?.lat, 31.23);
    const schema = await (await fetch(`${base}/openapi.json`)).json() as any;
    assert.equal(schema.info.title, 'DOOGY Backend');
    assert.ok(schema.paths['/api/v1/ingest/events'].post.requestBody.content['application/json'].schema);
    assert.ok(schema.paths['/api/v1/integrations/vendor/events']);
    const invalid = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
    assert.equal(invalid.status, 400);
    const error = await invalid.json() as any;
    assert.equal(error.code, 'INVALID_JSON');
    assert.ok(error.request_id);
  } finally { await app.close(); await backend.close(); }
});

test('离线文件导入复用幂等处理，API 模式禁止导入，非法坐标不入队', async () => {
  process.env.DATA_MODE = 'offline';
  const backend = await openBackendFixture(), db = backend.db;
  try {
    const identity = new IdentityService(db), devices = new DevicesService(db);
    const account = (await identity.register({ email: 'import@example.invalid', password: 'Synthetic-password-2026' }));
    const pet = (await identity.createPet(account.user.id, { household_id: account.household.id, name: '离线文件宠物' }));
    const device = (await provisionDevice(db, { serial_no: 'IMPORT-TEST' }));
    await devices.claim(account.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    const event = { schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, event_type: 'location.reported',
      boot_id: 'import-boot', seq: 1, device_ts: db.now(), payload: { lat: 31.23, lon: 121.47, accuracy_m: 10, source: 'gnss' } };
    assert.deepEqual((await importOffline(db, [event], device.device_token)).statuses, { processed: 1 });
    assert.equal((await importOffline(db, [event], device.device_token)).duplicates, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM locations'))!.n, 1);
    await assert.rejects(importOffline(db, [{ ...event, payload: { ...event.payload, lat: 100 } }], device.device_token));
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM device_events'))!.n, 1);
    process.env.DATA_MODE = 'api';
    await assert.rejects(importOffline(db, [event], device.device_token), /offline/);
  } finally { await backend.close(); }
});
