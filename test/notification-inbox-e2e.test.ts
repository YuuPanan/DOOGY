import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

const apiModule = new Function('url', 'return import(url)')(pathToFileURL(resolve('web/api.mjs')).href);
const denied = (status: number) => (error: any) => error.status === status;

for (const mode of ['offline', 'api'] as const) test(`通知中心 HTTP：${mode} 模式分页、本人已读、事件详情和偏好相互独立`, async t => {
  const previousMode = process.env.DATA_MODE;
  process.env.DATA_MODE = mode;
  t.after(() => { if (previousMode === undefined) delete process.env.DATA_MODE; else process.env.DATA_MODE = previousMode; });
  let time = Date.parse('2026-11-18T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(time)), db = backend.db;
  const fetchBefore = globalThis.fetch;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({ db, quiet: true });
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(new URL(url).origin, origin, '通知中心不得发起外部请求');
      return fetchBefore(input, init);
    };
    const { ApiClient } = await apiModule, password = 'Synthetic-notification-inbox-password';
    const owner = new ApiClient(base, null), viewer = new ApiClient(base, null);
    const ownerAccount = await owner.register({ email: 'inbox-owner@example.invalid', password });
    const viewerEmail = 'inbox-viewer@example.invalid';
    await viewer.register({ email: viewerEmail, password });
    const householdId = ownerAccount.households[0].id;
    const invite = await owner.send('POST', `/households/${householdId}/invitations`, { email: viewerEmail, role: 'viewer' });
    await viewer.send('POST', `/invitations/${invite.token}/accept`);
    const pet = await owner.send('POST', '/pets', { household_id: householdId, name: '合成通知宠物' });
    const device = await provisionDevice(db, { serial_no: 'SYNTHETIC-INBOX' });
    await owner.send('POST', '/devices/claim', { device_id: device.device_id, claim_code: device.claim_code, pet_id: pet.id });
    const telemetry = app.get(TelemetryService);
    const emit = (type: string) => db.transaction(() => telemetry.emitSafety(pet.id, device.device_id, type, db.now(), null, null, {}));
    const olderEventId = await emit('device.offline');
    time += 1000;
    const newerEventId = await emit('location.stale');

    const page1 = await owner.get('/notifications?limit=1&unread=true');
    assert.equal(page1.items.length, 1);
    assert.equal(page1.items[0].event_id, newerEventId);
    assert.equal(page1.items[0].pet_id, pet.id);
    assert.ok(page1.next_cursor);
    const page2 = await owner.get(`/notifications?limit=1&unread=true&cursor=${encodeURIComponent(page1.next_cursor)}`);
    assert.equal(page2.next_cursor, null);
    assert.deepEqual(page2.items.map((item: any) => item.event_id), [olderEventId]);
    const viewerPage = await viewer.get('/notifications?limit=1&unread=true');
    assert.equal(viewerPage.items[0].event_id, newerEventId);
    assert.notEqual(viewerPage.items[0].id, page1.items[0].id);
    assert.deepEqual((await viewer.get(`/notifications?limit=1&unread=true&cursor=${encodeURIComponent(viewerPage.next_cursor)}`)).items.map((item: any) => item.event_id), [olderEventId]);
    await assert.rejects(viewer.get(`/notifications?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`), denied(400));

    const ownerNotificationId = page1.items[0].id, viewerNotificationId = viewerPage.items[0].id;
    // Seed the delivery outcome. This test exercises the inbox response, not push transport.
    await db.run("UPDATE notifications SET status='dead',retry_count=5,error='PUSH_HTTP_503' WHERE id=?", ownerNotificationId);
    await assert.rejects(viewer.send('PATCH', `/notifications/${ownerNotificationId}/read`), denied(404));
    await owner.send('PATCH', `/notifications/${ownerNotificationId}/read`);
    const read = (await owner.get('/notifications?unread=false')).items;
    assert.equal(read.length, 1);
    assert.equal(read[0].id, ownerNotificationId);
    assert.equal(read[0].read_at, db.now());
    assert.equal(read[0].status, 'dead');
    assert.equal(read[0].retry_count, 5);
    assert.equal(read[0].error, 'PUSH_HTTP_503');
    assert.deepEqual((await owner.get('/notifications?unread=true')).items.map((item: any) => item.event_id), [olderEventId]);
    assert.equal((await viewer.get('/notifications?unread=true')).items.length, 2);

    await viewer.send('PATCH', `/notifications/${viewerNotificationId}/read`);
    assert.deepEqual((await viewer.get('/notifications?unread=false')).items.map((item: any) => item.id), [viewerNotificationId]);
    const detail = await viewer.get(`/safety-events/${newerEventId}`);
    assert.equal(detail.status, 'open');
    assert.equal(detail.acknowledgement, null);
    assert.equal(detail.delivery_status, 'unknown');
    assert.deepEqual(detail.notifications.map((item: any) => item.id), [viewerNotificationId]);

    const defaults = { geofence: true, battery: true, offline: true, location: true };
    assert.deepEqual(await owner.get('/notification-preferences'), defaults);
    await owner.send('PATCH', '/notification-preferences', { ...defaults, battery: false });
    assert.deepEqual(await owner.get('/notification-preferences'), { ...defaults, battery: false });
    assert.deepEqual(await viewer.get('/notification-preferences'), defaults);
    time += 1000;
    const batteryEventId = await emit('battery.low');
    assert.equal((await owner.get(`/safety-events/${batteryEventId}`)).type, 'battery.low');
    assert.equal((await owner.get('/notifications')).items.some((item: any) => item.event_id === batteryEventId), false);
    assert.equal((await viewer.get('/notifications?unread=true')).items[0].event_id, batteryEventId);
  } finally {
    globalThis.fetch = fetchBefore;
    try { await app?.close(); } finally { await backend.close(); }
  }
});
