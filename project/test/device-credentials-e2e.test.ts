import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

test('设备凭证HTTP：轮换、吊销、供应商拒绝和管理员补发同双驱动业务链路运行', async () => {
  process.env.DATA_MODE = 'offline'; process.env.DEVICE_ADMIN_USER_IDS = '';
  const backend = await openBackendFixture(() => new Date('2026-11-17T06:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    async function api(path: string, options: { method?: string; body?: unknown; token?: string; deviceToken?: string; key?: string; status?: number } = {}) {
      const response = await fetch(base + path, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.deviceToken ? { 'x-device-token': options.deviceToken } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(5000) });
      const body = await response.json() as any;
      assert.equal(response.status, options.status ?? (options.method === 'POST' ? 201 : 200), JSON.stringify(body));
      return body;
    }
    const register = (name: string) => api('/auth/register', { method: 'POST', body: { email: `${name}@example.invalid`, password: 'Synthetic-credential-http-2026' } });
    const owner = await register('credential-http-owner'), admin = await register('credential-http-admin');
    const pet = await api('/pets', { method: 'POST', token: owner.access_token, body: { household_id: owner.household.id, name: 'Credential HTTP pet' } });
    const device = await provisionDevice(db, { serial_no: 'CREDENTIAL-HTTP' });
    await api('/devices/claim', { method: 'POST', token: owner.access_token, body: { ...device, pet_id: pet.id } });
    const credentialPath = `/devices/${device.device_id}/credential`;
    assert.equal((await api(credentialPath, { token: owner.access_token })).credential.version, 1);
    const request = { method: 'POST', token: owner.access_token, body: { reason: 'HTTP rotation check' }, key: 'must-not-cache-secret' };
    const first = await api(`${credentialPath}/rotate`, request), second = await api(`${credentialPath}/rotate`, request);
    assert.equal(first.credential.version, 2); assert.equal(second.credential.version, 3); assert.notEqual(first.device_token, second.device_token);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key='must-not-cache-secret'"))!.n, 0);
    let seq = 0;
    const event = () => ({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'credential-http', seq: seq++, device_ts: db.now(), event_type: 'state.reported', payload: { battery_pct: 80 } });
    await api('/ingest/events', { method: 'POST', body: event(), deviceToken: device.device_token, status: 401 });
    await api('/ingest/events', { method: 'POST', body: event(), deviceToken: first.device_token, status: 401 });
    const queued = event(); await api('/ingest/events', { method: 'POST', body: queued, deviceToken: second.device_token, status: 202 });
    const policy = await api(`/devices/${device.device_id}/reporting-policy`, { method: 'PUT', token: owner.access_token, body: { mode: 'alert', interval_seconds: 15 }, status: 200 });
    await api(`/device-ingress/${device.device_id}/commands`, { deviceToken: second.device_token });
    const revoked = await api(`${credentialPath}/revoke`, { method: 'POST', token: owner.access_token, body: { reason: 'HTTP revoke check' } });
    assert.equal(revoked.credential.version, 3); assert.equal(revoked.credential.status, 'revoked');
    await api('/ingest/events', { method: 'POST', body: event(), deviceToken: second.device_token, status: 401 });
    await api(`/device-ingress/${device.device_id}/commands`, { deviceToken: second.device_token, status: 401 });
    await api(`/device-ingress/${device.device_id}/commands/${policy.command_id}/ack`, { method: 'POST', deviceToken: second.device_token,
      body: { status: 'applied', applied_version: policy.desired_version }, status: 401 });
    process.env.DATA_MODE = 'api';
    process.env.VENDOR_WEBHOOK_SECRET = 'synthetic-credential-http-vendor-secret';
    const raw = JSON.stringify(event()), timestamp = String(db.clock().getTime() / 1000);
    const signature = createHmac('sha256', process.env.VENDOR_WEBHOOK_SECRET).update(timestamp + '.' + raw).digest('hex');
    const vendor = await fetch(base + '/integrations/vendor/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-doogy-timestamp': timestamp, 'x-doogy-signature': signature }, body: raw });
    assert.equal(vendor.status, 401);
    process.env.DATA_MODE = 'offline';
    assert.equal(await app.get(TelemetryService).work(), 1);
    assert.equal((await db.get('SELECT process_status FROM device_events WHERE event_id=?', queued.event_id))!.process_status, 'processed');
    const renewed = await api(`${credentialPath}/rotate`, { method: 'POST', token: owner.access_token, body: { reason: 'Recover revoked token' } });
    assert.equal(renewed.credential.version, 4);
    await api('/ingest/events', { method: 'POST', body: event(), deviceToken: renewed.device_token, status: 202 });
    const unclaimed = await provisionDevice(db, { serial_no: 'UNCLAIMED-CREDENTIAL-HTTP' });
    const claimPath = `/admin/devices/${unclaimed.device_id}/claim-code`;
    await api(claimPath, { method: 'POST', token: admin.access_token, body: { reason: 'Replace lost claim code' }, status: 403 });
    process.env.DEVICE_ADMIN_USER_IDS = admin.user.id;
    const code = await api(claimPath, { method: 'POST', token: admin.access_token, body: { reason: 'Replace lost claim code' } });
    const otherPet = await api('/pets', { method: 'POST', token: owner.access_token, body: { household_id: owner.household.id, name: 'Claimed with replacement code' } });
    await api('/devices/claim', { method: 'POST', token: owner.access_token, body: { ...unclaimed, pet_id: otherPet.id }, status: 400 });
    await api('/devices/claim', { method: 'POST', token: owner.access_token, body: { ...code, pet_id: otherPet.id } });
    await api(claimPath, { method: 'POST', token: admin.access_token, body: { reason: 'Must not alter claimed hardware' }, status: 409 });
    const view = await api(credentialPath, { token: owner.access_token });
    const audits = await db.all("SELECT metadata_json FROM audit_logs WHERE action IN ('device.credential.rotated','device.credential.revoked','device.claim_code_reissued')");
    const serialized = JSON.stringify({ view, audits });
    for (const secret of [device.device_token, first.device_token, second.device_token, renewed.device_token, code.claim_code, 'secret_hash']) assert.ok(!serialized.includes(secret), secret);
    const schema = await (await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
    for (const path of ['/api/v1/devices/{id}/credential', '/api/v1/devices/{id}/credential/rotate', '/api/v1/devices/{id}/credential/revoke', '/api/v1/admin/devices/{id}/claim-code', '/api/v1/admin/devices/{id}/credential/rotate']) assert.ok(schema.paths[path], path);
  } finally { process.env.DATA_MODE = 'offline'; process.env.DEVICE_ADMIN_USER_IDS = ''; delete process.env.VENDOR_WEBHOOK_SECRET; await app.close(); await backend.close(); }
});
