import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

const apiModule = new Function('url', 'return import(url)')(pathToFileURL(resolve('web/api.mjs')).href);

for (const mode of ['offline', 'api'] as const) test(`走失分享 HTTP：${mode} 模式从家庭创建到匿名读取与失效`, async t => {
  const previousMode = process.env.DATA_MODE;
  process.env.DATA_MODE = mode;
  t.after(() => { if (previousMode === undefined) delete process.env.DATA_MODE; else process.env.DATA_MODE = previousMode; });
  let time = Date.parse('2026-11-18T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(time)), db = backend.db;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ db, quiet: true });
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl(), base = `${origin}/api/v1`;
    const { ApiClient } = await apiModule, password = 'Synthetic-share-web-password';
    const owner = new ApiClient(base, null), caregiver = new ApiClient(base, null);
    const viewer = new ApiClient(base, null), guest = new ApiClient(base, null);
    const account = await owner.register({ email: 'share-web-owner@example.invalid', password });
    const household = account.households[0].id;
    const pet = await owner.send('POST', '/pets', { household_id: household, name: '合成走失分享宠物' });
    for (const [client, role] of [[caregiver, 'caregiver'], [viewer, 'viewer']] as const) {
      const email = `share-web-${role}@example.invalid`;
      await client.register({ email, password });
      const invite = await owner.send('POST', `/households/${household}/invitations`, { email, role });
      await client.send('POST', `/invitations/${invite.token}/accept`);
    }

    const device = await provisionDevice(db, { serial_no: 'SYNTHETIC-SHARE-WEB' });
    await owner.send('POST', '/devices/claim', { device_id: device.device_id, claim_code: device.claim_code, pet_id: pet.id });
    const lostPath = `/devices/${device.device_id}/lost-mode`;
    await owner.send('POST', lostPath, { enabled: true, expires_in_seconds: 600 });
    const ingest = await fetch(`${base}/ingest/events`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-device-token': device.device_token
    }, body: JSON.stringify({ schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id,
      boot_id: 'synthetic-share', seq: 1, event_type: 'location.reported', device_ts: db.now(),
      payload: { lat: 31.23, lon: 121.47, accuracy_m: 12, source: 'gnss' } }) });
    assert.equal(ingest.status, 202, await ingest.text());
    assert.equal(await app.get(TelemetryService).work(), 1);

    const managementPath = `/pets/${pet.id}/location-shares`, consent = { consent: true, expires_in_seconds: 60 };
    const denied = (status: number) => (error: any) => error.status === status;
    await assert.rejects(viewer.send('POST', managementPath, consent), denied(403));
    await assert.rejects(guest.get(managementPath), denied(401));
    const share = await caregiver.send('POST', managementPath, consent);
    assert.match(share.token, /^[A-Za-z0-9_-]{43}$/);
    const listing = await owner.get(managementPath);
    assert.equal(listing.items[0].id, share.id);
    for (const field of ['token', 'token_hash', 'public_path']) assert.ok(!Object.hasOwn(listing.items[0], field));

    const recipient = await fetch(`${origin}/app/share.html#${share.token}`);
    assert.equal(recipient.status, 200);
    assert.match(recipient.headers.get('content-type') ?? '', /^text\/html\b/);
    await recipient.text();
    const script = await fetch(`${origin}/app/share.mjs`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    await script.text();

    const publicPath = `/location-shares/${share.token}`;
    const response = await guest.response(publicPath);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(await response.json(), { share_id: share.id, pet: { id: pet.id, name: pet.name }, expires_at: share.expires_at,
      location: { lat: 31.23, lon: 121.47, device_ts: db.now(), received_at: db.now(), accuracy_m: 12, source: 'gnss',
        freshness: 'fresh', quality_flags: [], usable_for_tracking: true }, last_usable_location: null });

    await owner.send('DELETE', `/location-shares/${share.id}`);
    await assert.rejects(guest.get(publicPath), denied(404));
    const expiring = await owner.send('POST', managementPath, consent);
    assert.equal((await guest.get(expiring.public_path)).share_id, expiring.id);
    time += 61_000;
    await assert.rejects(guest.get(expiring.public_path), denied(404));
    const afterExpiry = await owner.send('POST', managementPath, consent);
    await owner.send('POST', lostPath, { enabled: false });
    await assert.rejects(guest.get(afterExpiry.public_path), denied(404));
    assert.equal((await guest.get('/health')).mode, mode);
  } finally { try { await app?.close(); } finally { await backend.close(); } }
});
