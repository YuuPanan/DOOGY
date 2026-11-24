import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { NotificationService } from '../src/notifications';
import { openBackendFixture } from './backend-fixture';

const apiModule = new Function('url', 'return import(url)')(pathToFileURL(resolve('web/api.mjs')).href);

for (const mode of ['offline', 'api'] as const) test(`本地工作台HTTP：${mode}模式同源资源和实际浏览器客户端业务流程在双驱动运行`, async () => {
  process.env.DATA_MODE = mode;
  const backend = await openBackendFixture(() => new Date('2026-11-17T06:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(target).origin !== origin) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    const page = await fetch(`${origin}/app/`), html = await page.text();
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(html, /<html[^>]+lang="zh/); assert.match(html, /type="module"/);
    const resources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(path => !/^(#|data:)/.test(path));
    assert.ok(resources.length >= 2);
    for (const path of resources) assert.equal(new URL(path, `${origin}/app/`).origin, origin);
    for (const [asset, contentType] of [['styles.css', /text\/css/], ['app.mjs', /javascript/], ['api.mjs', /javascript/]] as const) {
      const response = await fetch(`${origin}/app/${asset}`), source = await response.text();
      assert.equal(response.status, 200, asset); assert.match(response.headers.get('content-type') ?? '', contentType);
      assert.ok(source.length > 100, asset); assert.doesNotMatch(source, /(?:https?:)?\/\/(?:cdn\.|unpkg\.|esm\.sh|fonts\.googleapis)/);
    }
    const { ApiClient } = await apiModule, values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const client = new ApiClient(`${origin}/api/v1`, storage), password = 'Synthetic-workbench-http-2026';
    await client.register({ email: `workbench-${mode}@example.invalid`, password, household_name: '合成工作台家庭', timezone: 'UTC' });
    const user = await client.get('/auth/me'), household = (await client.get('/households')).items[0];
    assert.equal(user.email, `workbench-${mode}@example.invalid`); assert.equal(household.name, '合成工作台家庭');
    const input = { household_id: household.id, name: '工作台合成宠物', species: 'dog' };
    const pet = await client.send('POST', '/pets', input, `workbench-pet-${mode}`);
    assert.equal((await client.send('POST', '/pets', input, `workbench-pet-${mode}`)).id, pet.id);
    assert.equal((await client.get('/pets')).items.length, 1);
    assert.equal((await client.send('PATCH', `/pets/${pet.id}`, { breed: '合成品种' })).breed, '合成品种');
    const record = await client.send('POST', '/care-records', { pet_id: pet.id, type: 'note', value: { text: '前端实际提交' }, recorded_at: db.now() });
    const recordPath = `/care-records/${record.id}`;
    await client.send('PATCH', recordPath, { notes: '已校正照护备注' });
    const bytes = Buffer.from('%PDF-1.7\nSynthetic browser client attachment\n%%EOF\n');
    const attachment = await client.upload(`${recordPath}/attachments`, new File([Uint8Array.from(bytes)], 'source.pdf', { type: 'application/pdf' }), '工作台记录.pdf');
    const downloaded = await client.blob(attachment.download_path);
    assert.equal(downloaded.filename, '工作台记录.pdf'); assert.equal(downloaded.contentType, 'application/pdf');
    assert.deepEqual(Buffer.from(await downloaded.blob.arrayBuffer()), bytes);
    const currentRecord = await client.get(recordPath), history = await client.get(`${recordPath}/history`);
    assert.equal(currentRecord.notes, '已校正照护备注'); assert.equal(currentRecord.attachments[0].id, attachment.id);
    assert.equal(history.revisions.length, 2);
    const withdrawn = await client.send('POST', `${recordPath}/withdraw`, { reason: '合成记录撤回' });
    assert.ok(withdrawn.withdrawn_at); assert.equal((await client.get(`/pets/${pet.id}/care-records`)).items.length, 0);
    assert.equal((await client.get(`/pets/${pet.id}/care-records?status=withdrawn`)).items[0].id, record.id);
    const observation = await client.get(`/pets/${pet.id}/observations/current`);
    assert.equal(observation.as_of, db.now()); assert.equal(observation.rule_version, 'activity-current-v1'); assert.equal(observation.target.steps, null);
    const device = await provisionDevice(db, { serial_no: `WORKBENCH-${mode}` });
    const claimed = await client.send('POST', '/devices/claim', { device_id: device.device_id, claim_code: device.claim_code, pet_id: pet.id });
    assert.equal(claimed.id, device.device_id);
    const policy = await client.send('PUT', `/devices/${device.device_id}/reporting-policy`, { mode: 'home_active', interval_seconds: 120 });
    assert.equal(policy.status, 'pending'); assert.equal(policy.applied, null);
    assert.equal((await client.get(`/devices/${device.device_id}/reporting-policy`)).desired.interval_seconds, 120);
    const eventId = db.id();
    await db.run('INSERT INTO safety_events(id,pet_id,device_id,type,occurred_at,details_json) VALUES (?,?,?,?,?,?)', eventId, pet.id, device.device_id, 'device.offline', db.now(), '{}');
    await app.get(NotificationService).enqueue(eventId);
    const before = await client.get(`/pets/${pet.id}/overview`);
    assert.equal(before.attention.unacknowledged_open_event_count, 1); assert.equal(before.attention.unread_notification_count, 1);
    const acknowledgement = await client.send('POST', `/safety-events/${eventId}/ack`, { note: '合成待办已查看' });
    assert.equal(acknowledgement.event_status, 'open');
    const note = (await client.get('/notifications?unread=true')).items[0];
    await client.send('PATCH', `/notifications/${note.id}/read`);
    const after = await client.get(`/pets/${pet.id}/overview`);
    assert.equal(after.attention.open_event_count, 1); assert.equal(after.attention.unacknowledged_open_event_count, 0); assert.equal(after.attention.unread_notification_count, 0);
    await client.logout(); await client.login({ email: user.email, password });
    assert.equal((await client.resume()).user.id, user.id);
    assert.equal((await client.get('/health')).mode, mode); assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
