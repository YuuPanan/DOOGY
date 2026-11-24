import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

test('账号导出HTTP：授权清单、分页业务数据、秘密隔离和撤权在双驱动下保持一致', async () => {
  process.env.DATA_MODE = 'offline';
  const backend = await openBackendFixture(() => new Date('2026-11-17T06:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/api/v1`;
    async function api(path: string, options: { method?: string; body?: unknown; token?: string; status?: number; deviceToken?: string; exported?: boolean } = {}) {
      const response = await fetch(base + path, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.deviceToken ? { 'x-device-token': options.deviceToken } : {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(5000) });
      const value = await response.json() as any;
      assert.equal(response.status, options.status ?? (options.method === 'POST' ? 201 : 200), JSON.stringify(value));
      if (options.exported) assert.match(response.headers.get('cache-control') ?? '', /no-store/);
      return value;
    }
    const register = (name: string) => api('/auth/register', { method: 'POST', body: { email: `${name}@example.invalid`, password: 'Synthetic-export-http-2026' } });
    const owner = await register('export-http-owner'), viewer = await register('export-http-viewer'), outsider = await register('export-http-outsider');
    const invite = await api(`/households/${owner.household.id}/invitations`, { method: 'POST', token: owner.access_token, body: { email: viewer.user.email, role: 'viewer' } });
    await api(`/invitations/${invite.token}/accept`, { method: 'POST', token: viewer.access_token, status: 200 });
    const pet = await api('/pets', { method: 'POST', token: owner.access_token, body: { household_id: owner.household.id, name: 'Export HTTP pet' } });
    await api('/pets', { method: 'POST', token: owner.access_token, body: { household_id: owner.household.id, name: 'Second export HTTP pet' } });
    const device = await provisionDevice(db, { serial_no: 'EXPORT-HTTP' });
    await api('/devices/claim', { method: 'POST', token: owner.access_token, body: { ...device, pet_id: pet.id } });
    await api('/ingest/events', { method: 'POST', deviceToken: device.device_token, status: 202, body: {
      schema_version: '1.0', event_id: randomUUID(), device_id: device.device_id, device_ts: db.now(), seq: 1, boot_id: 'export-http', event_type: 'location.reported',
      payload: { lat: 31.23, lon: 121.47, accuracy_m: 5, source: 'gnss', signal: { private: 'HTTP-RAW-EXPORT-PRIVATE' } } } });
    await app.get(TelemetryService).work();
    await api('/care-records', { method: 'POST', token: owner.access_token, body: { pet_id: pet.id, type: 'note', source: 'owner', recorded_at: db.now(), value: { text: 'HTTP export note' } } });
    await api('/auth/data-export', { status: 401 });
    const manifest = await api('/auth/data-export', { token: viewer.access_token, exported: true });
    assert.equal(manifest.format, 'doogy-account-export-v1'); assert.equal(manifest.user.id, viewer.user.id);
    assert.ok(manifest.households.some((row: any) => row.id === owner.household.id));
    const query = `household_id=${owner.household.id}&limit=1&snapshot_at=${encodeURIComponent(manifest.generated_at)}`;
    const page = await api(`/auth/data-export/pets?${query}`, { token: viewer.access_token, exported: true });
    assert.equal(page.items.length, 1); assert.ok(page.next_cursor);
    const second = await api(`/auth/data-export/pets?${query}&cursor=${encodeURIComponent(page.next_cursor)}`, { token: viewer.access_token, exported: true });
    assert.equal(second.items.length, 1); assert.notEqual(second.items[0].id, page.items[0].id);
    const locations = await api(`/auth/data-export/locations?household_id=${owner.household.id}`, { token: owner.access_token, exported: true });
    assert.equal(locations.items[0].lat, 31.23); assert.deepEqual(locations.items[0].quality_flags, []);
    const records = await api(`/auth/data-export/care_records?household_id=${owner.household.id}`, { token: owner.access_token, exported: true });
    assert.equal(records.items[0].value.text, 'HTTP export note');
    const metadata = await api(`/auth/data-export/devices?household_id=${owner.household.id}`, { token: owner.access_token, exported: true });
    const encoded = JSON.stringify({ manifest, page, second, locations, records, metadata });
    for (const value of [owner.access_token, viewer.refresh_token, device.device_token, device.claim_code, 'HTTP-RAW-EXPORT-PRIVATE', 'secret_hash', 'password_hash', 'envelope_json']) assert.ok(!encoded.includes(value), 'Private value leaked into HTTP export');
    await api(`/auth/data-export/pets?${query}`, { token: outsider.access_token, status: 404 });
    await api(`/auth/data-export/location_shares?household_id=${owner.household.id}`, { token: viewer.access_token, status: 403 });
    const schema = await (await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
    for (const path of ['/api/v1/auth/data-export', '/api/v1/auth/data-export/{section}']) assert.ok(schema.paths[path]);
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, { method: 'DELETE', token: owner.access_token });
    await api(`/auth/data-export/pets?${query}&cursor=${encodeURIComponent(page.next_cursor)}`, { token: viewer.access_token, status: 404 });
  } finally { await app.close(); await backend.close(); }
});

const importModule = new Function('url', 'return import(url)');
const syntheticPdf = Buffer.from('%PDF-1.7\nSynthetic self-service export document\n%%EOF\n');

for (const mode of ['offline', 'api'] as const) test(`Web 数据导出HTTP：${mode}模式跨家庭分页、校验文件与中途撤权`, async () => {
  process.env.DATA_MODE = mode;
  let now = Date.parse('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const { ApiClient } = await importModule(pathToFileURL(resolve('web/api.mjs')).href);
    const { buildAccountExport } = await importModule(pathToFileURL(resolve('web/account-export.mjs')).href);
    const owner = new ApiClient(`${origin}/api/v1`, null), viewer = new ApiClient(`${origin}/api/v1`, null);
    const password = 'Synthetic-export-web-2026';
    await owner.register({ email: 'export-web-owner@example.invalid', password, household_name: '共享家庭' });
    const viewerProfile = await viewer.register({ email: 'export-web-viewer@example.invalid', password, household_name: '只读成员自己的家庭' });
    const household = (await owner.get('/households')).items[0], personalHousehold = viewerProfile.households[0];
    const invitation = await owner.send('POST', `/households/${household.id}/invitations`, { email: viewerProfile.user.email, role: 'viewer' });
    await viewer.send('POST', `/invitations/${invitation.token}/accept`);
    const pet = await owner.send('POST', '/pets', { household_id: household.id, name: '合成导出宠物' });
    const record = await owner.send('POST', '/care-records', { pet_id: pet.id, type: 'note', value: { text: '合成附件记录' }, recorded_at: db.now() });
    const attachments = [];
    for (const name of ['附件甲.pdf', '附件乙.pdf']) {
      const file = new File([Uint8Array.from(syntheticPdf)], name, { type: 'application/pdf' });
      attachments.push(await owner.upload(`/care-records/${record.id}/attachments`, file));
    }

    const manifest = await viewer.get('/auth/data-export');
    assert.deepEqual(manifest.households.map((item: any) => item.id).sort(), [household.id, personalHousehold.id].sort());
    const shared = manifest.households.find((item: any) => item.id === household.id);
    assert.equal(shared.role, 'viewer');
    assert.ok(!shared.sections.includes('location_shares'));
    now += 1000;
    const laterPet = await owner.send('POST', '/pets', { household_id: household.id, name: '清单时间之后创建' });
    const isSharedAttachmentPage = (path: URL) => path.pathname === '/auth/data-export/care_attachments' && path.searchParams.get('household_id') === household.id;
    const attachmentCursors: (string | null)[] = [];
    const progress: { completed: number; total: number; rows: number }[] = [];
    const result = await buildAccountExport({ get: async (path: string) => {
      const url = new URL(path, origin);
      assert.equal(url.searchParams.get('snapshot_at'), manifest.generated_at);
      if (isSharedAttachmentPage(url)) attachmentCursors.push(url.searchParams.get('cursor'));
      return viewer.get(path);
    } }, manifest, { onProgress: (value: typeof progress[number]) => progress.push(value) });
    assert.equal(result.blob.type, 'application/x-ndjson');
    assert.match(result.filename, /^[a-z0-9_-]+\.ndjson$/i);
    assert.equal(attachmentCursors.length, 2);
    assert.equal(attachmentCursors[0], null);
    assert.ok(attachmentCursors[1]);
    const text = await result.blob.text();
    assert.ok(text.endsWith('\n'));
    const lines: string[] = text.slice(0, -1).split('\n');
    assert.deepEqual(JSON.parse(lines[0]), { type: 'manifest', ...manifest });
    const records = lines.slice(1, -1).map(line => JSON.parse(line));
    assert.ok(records.every(row => row.type === 'record'));
    const exportedFiles = records.filter(row => row.section === 'care_attachments');
    assert.deepEqual(exportedFiles.map(row => row.data.id).sort(), attachments.map(row => row.id).sort());
    for (const file of exportedFiles) {
      assert.equal(file.household_id, household.id);
      assert.deepEqual(Buffer.from(file.data.content_base64, 'base64'), syntheticPdf);
    }
    assert.ok(!records.some(row => row.section === 'pets' && row.data.id === laterPet.id));
    assert.ok(!records.some(row => row.section === 'location_shares' && row.household_id === household.id));
    assert.ok(!text.includes(viewer.session.refresh_token));
    const complete = JSON.parse(lines.at(-1)!);
    assert.equal(complete.type, 'complete');
    assert.ok(Number.isFinite(Date.parse(complete.completed_at)));
    assert.equal(complete.rows, records.length);
    assert.equal(result.rows, complete.rows);
    assert.equal(complete.content_sha256, createHash('sha256').update(`${lines.slice(0, -1).join('\n')}\n`).digest('hex'));
    const scopes = [{ id: null, sections: manifest.personal_sections }, ...manifest.households];
    const counts = scopes.flatMap(scope => scope.sections.map((section: string) => ({ section, household_id: scope.id,
      records: records.filter(row => row.section === section && row.household_id === scope.id).length })));
    assert.ok(counts.some(count => count.records === 0));
    assert.deepEqual(complete.counts, counts);
    assert.equal(result.sections, counts.length);
    assert.deepEqual(progress.at(-1), { completed: counts.length, total: counts.length, rows: records.length });

    await assert.rejects(buildAccountExport({ get: async (path: string) => {
      const page = await viewer.get(path);
      if (isSharedAttachmentPage(new URL(path, origin))) {
        assert.ok(page.next_cursor);
        await owner.send('DELETE', `/households/${household.id}/members/${viewerProfile.user.id}`);
      }
      return page;
    } }, manifest), { status: 404 });
    await assert.rejects(buildAccountExport({ get: () => assert.fail('取消后不读取分区') }, manifest, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  } finally { await app.close(); await backend.close(); }
});
