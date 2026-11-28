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

for (const mode of ['offline', 'api'] as const) test(`展示MVP HTTP：${mode}模式家庭协作、档案纠正、历史追溯与设备重绑使用实际客户端`, async () => {
  process.env.DATA_MODE = mode;
  let now = new Date('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => now), db = backend.db;
  const app = await createApp({ db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(target).origin !== origin) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    const { ApiClient } = await apiModule, password = 'Synthetic-mvp-workbench-2026';
    const owner = new ApiClient(base, null), caregiver = new ApiClient(base, null), viewer = new ApiClient(base, null);
    const ownerSession = await owner.register({ email: `mvp-owner-${mode}@example.invalid`, password, household_name: '合成共享家庭', timezone: 'Asia/Shanghai' });
    const careSession = await caregiver.register({ email: `mvp-carer-${mode}@example.invalid`, password, household_name: '照护者自己的家庭', timezone: 'UTC' });
    const viewerSession = await viewer.register({ email: `mvp-viewer-${mode}@example.invalid`, password, household_name: '访客自己的家庭', timezone: 'UTC' });
    const householdId = ownerSession.households[0].id;
    const pet = await owner.send('POST', '/pets', { household_id: householdId, name: '待纠正档案', species: 'dog', breed: '合成品种', birth_date: '2024-01-02', weight_kg: 8.5, timezone: 'Europe/London' });
    const privatePet = await caregiver.send('POST', '/pets', { household_id: careSession.households[0].id, name: '独立家庭宠物', species: 'cat' });
    const denied = (status: number) => (error: any) => error.status === status && Boolean(error.code && error.requestId);
    await assert.rejects(viewer.get(`/pets/${pet.id}`), denied(404));

    const caregiverInvite = await owner.send('POST', `/households/${householdId}/invitations`, { email: careSession.user.email, role: 'caregiver' });
    const viewerInvite = await owner.send('POST', `/households/${householdId}/invitations`, { email: viewerSession.user.email, role: 'viewer' });
    assert.equal((await caregiver.send('POST', `/invitations/${caregiverInvite.token}/accept`)).role, 'caregiver');
    assert.equal((await viewer.send('POST', `/invitations/${viewerInvite.token}/accept`)).role, 'viewer');
    assert.equal((await caregiver.resume()).households.length, 2);
    assert.deepEqual(new Set((await caregiver.get('/pets')).items.map((item: any) => item.id)), new Set([pet.id, privatePet.id]));
    assert.deepEqual((await viewer.get('/pets')).items.map((item: any) => item.id), [pet.id]);
    assert.equal((await owner.get(`/households/${householdId}/members`)).items.length, 3);
    await assert.rejects(viewer.send('PATCH', `/pets/${pet.id}`, { name: '只读修改' }), denied(403));
    assert.equal((await caregiver.send('PATCH', `/pets/${pet.id}`, { name: '共享宠物' })).name, '共享宠物');
    const corrected = await owner.send('PATCH', `/pets/${pet.id}`, { species: 'cat', breed: null, birth_date: null, weight_kg: null, timezone: null });
    assert.equal(corrected.species, 'cat');
    for (const field of ['breed', 'birth_date', 'weight_kg', 'timezone']) assert.equal(corrected[field], null, field);
    assert.equal(corrected.effective_timezone, 'Asia/Shanghai');
    await owner.send('PATCH', `/households/${householdId}`, { name: '已核对共享家庭', timezone: 'UTC' });
    assert.equal((await caregiver.get(`/pets/${pet.id}`)).effective_timezone, 'UTC');
    assert.equal((await viewer.resume()).households.find((item: any) => item.id === householdId).name, '已核对共享家庭');
    await owner.send('PATCH', `/pets/${pet.id}`, { timezone: 'Europe/London' });
    assert.equal((await viewer.get(`/pets/${pet.id}`)).effective_timezone, 'Europe/London');
    await owner.send('PATCH', `/pets/${pet.id}`, { timezone: null });

    await owner.send('PATCH', `/households/${householdId}/members/${viewerSession.user.id}`, { role: 'caregiver' });
    assert.equal((await viewer.resume()).households.find((item: any) => item.id === householdId).role, 'caregiver');
    const sharedCare = await viewer.send('POST', '/care-records', { pet_id: pet.id, type: 'note', value: { text: '改为照护者后可共同记录' }, recorded_at: db.now() });
    assert.equal((await owner.get(`/care-records/${sharedCare.id}`)).created_by, viewerSession.user.id);
    await owner.send('PATCH', `/households/${householdId}/members/${viewerSession.user.id}`, { role: 'viewer' });
    await assert.rejects(viewer.send('PATCH', `/pets/${pet.id}`, { name: '恢复只读后修改' }), denied(403));
    const secondPet = await owner.send('POST', '/pets', { household_id: householdId, name: '换绑目标宠物', species: 'dog' });

    const device = await provisionDevice(db, { serial_no: `MVP-WORKBENCH-${mode}` });
    await owner.send('POST', '/devices/claim', { device_id: device.device_id, claim_code: device.claim_code, pet_id: pet.id });
    assert.equal((await owner.get(`/pets/${pet.id}/overview`)).device.is_owner, true);
    assert.equal((await caregiver.get(`/pets/${pet.id}/overview`)).device.is_owner, false);
    assert.equal((await viewer.get(`/pets/${pet.id}/overview`)).device.is_owner, false);
    const originalBinding = (await db.get('SELECT id FROM device_bindings WHERE device_id=? AND unbound_at IS NULL', device.device_id))!.id;
    await owner.send('POST', '/geofences', { pet_id: pet.id, name: '合成安全区', geometry: { type: 'circle', lat: 31.23, lon: 121.47, radius_m: 100 }, buffer_m: 10, confirm_points: 2 });
    let seq = 0;
    async function location(lat: number) {
      now = new Date(now.getTime() + 30_000);
      const event = { schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, boot_id: 'mvp-workbench', seq: seq++, device_ts: db.now(), event_type: 'location.reported', transport: 'simulator', payload: { lat, lon: 121.47, accuracy_m: 5, source: 'gnss', battery_pct: 15 } };
      const response = await fetch(`${base}/ingest/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-token': device.device_token }, body: JSON.stringify(event) });
      assert.equal(response.status, 202, await response.text());
      assert.equal(await app.get(TelemetryService).work(), 1);
    }
    for (const lat of [31.23, 31.23, 31.232, 31.232, 31.232]) await location(lat);
    const first = await viewer.get(`/pets/${pet.id}/locations?limit=2`);
    assert.equal(first.items.length, 2); assert.ok(first.next_cursor);
    assert.equal(first.items[0].usable_for_tracking, true);
    await location(31.232);
    const nextQuery = new URLSearchParams({ limit: '2', from: first.range.from, to: first.range.to, cursor: first.next_cursor });
    const second = await viewer.get(`/pets/${pet.id}/locations?${nextQuery}`);
    assert.deepEqual(second.range, first.range); assert.ok(second.next_cursor);
    nextQuery.set('cursor', second.next_cursor);
    const third = await viewer.get(`/pets/${pet.id}/locations?${nextQuery}`);
    const historyIds = [...first.items, ...second.items, ...third.items].map((item: any) => item.id);
    assert.equal(historyIds.length, 5); assert.equal(new Set(historyIds).size, 5); assert.equal(third.next_cursor, null);
    assert.ok([...first.items, ...second.items, ...third.items].every((item: any) => item.binding_id === originalBinding));

    const eventsFirst = await viewer.get(`/pets/${pet.id}/safety-events?limit=1`);
    assert.ok(eventsFirst.next_cursor);
    const eventsSecond = await viewer.get(`/pets/${pet.id}/safety-events?limit=1&cursor=${encodeURIComponent(eventsFirst.next_cursor)}`);
    assert.equal(eventsSecond.next_cursor, null);
    const events = [...eventsFirst.items, ...eventsSecond.items];
    assert.deepEqual(new Set(events.map((item: any) => item.type)), new Set(['battery.low', 'geofence.exited']));
    const exited = events.find((item: any) => item.type === 'geofence.exited');
    const eventPath = `/safety-events/${exited.id}`, before = await viewer.get(eventPath);
    assert.equal(before.status, 'open'); assert.equal(before.delivery_status, 'unknown');
    assert.equal(before.location.pet_id, pet.id); assert.equal(before.acknowledgement, null);
    await assert.rejects(viewer.send('POST', `${eventPath}/ack`, {}), denied(403));
    const acknowledgement = await caregiver.send('POST', `${eventPath}/ack`, { note: '家人已查看合成越界提醒' });
    assert.equal(acknowledgement.event_status, 'open');
    const viewerNote = (await viewer.get('/notifications?unread=true')).items.find((item: any) => item.event_id === exited.id);
    const ownerNote = (await owner.get('/notifications?unread=true')).items.find((item: any) => item.event_id === exited.id);
    assert.ok(viewerNote && ownerNote); assert.notEqual(viewerNote.id, ownerNote.id);
    await viewer.send('PATCH', `/notifications/${viewerNote.id}/read`);
    assert.ok((await viewer.get(eventPath)).notifications[0].read_at);
    const ownerDetail = await owner.get(eventPath);
    assert.equal(ownerDetail.status, 'open'); assert.equal(ownerDetail.acknowledgement.user_id, careSession.user.id);
    assert.equal(ownerDetail.notifications[0].read_at, null);
    await owner.send('PATCH', `/notifications/${ownerNote.id}/read`);
    assert.ok((await owner.get(eventPath)).notifications[0].read_at);

    const unbound = await owner.send('POST', `/devices/${device.device_id}/unbind`);
    assert.ok(unbound.claim_code && unbound.claim_expires_at);
    assert.equal((await owner.get(`/pets/${pet.id}/overview`)).device, null);
    const rebound = await owner.send('POST', '/devices/claim', { device_id: device.device_id, claim_code: unbound.claim_code, pet_id: secondPet.id });
    assert.equal(rebound.pet_id, secondPet.id); assert.equal(rebound.state.last_seen_at, null); assert.equal(rebound.state.battery_pct, null);
    assert.equal(await owner.get(`/pets/${secondPet.id}/location/latest`), null);
    assert.equal((await owner.get(`/pets/${secondPet.id}/locations`)).items.length, 0);
    const priorHistory = (await owner.get(`/pets/${pet.id}/locations`)).items;
    assert.equal(priorHistory.length, 6);
    assert.ok(priorHistory.every((item: any) => item.binding_id === originalBinding));
    assert.equal((await owner.get(eventPath)).status, 'closed');
    assert.equal((await owner.get(`/pets/${secondPet.id}/overview`)).device.id, device.device_id);

    await owner.send('DELETE', `/households/${householdId}/members/${careSession.user.id}`);
    assert.deepEqual((await caregiver.get('/pets')).items.map((item: any) => item.id), [privatePet.id]);
    assert.equal((await caregiver.resume()).households.length, 1);
    await owner.send('DELETE', `/households/${householdId}/members/${viewerSession.user.id}`);
    await assert.rejects(viewer.get(eventPath), denied(404));
    assert.equal((await viewer.get('/notifications')).items.length, 0);
    assert.equal((await owner.get(`/households/${householdId}/members`)).items.length, 1);
    assert.equal((await owner.get('/health')).mode, mode); assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
