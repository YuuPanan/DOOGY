import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';

const pdf = Buffer.from('%PDF-1.7\nHTTP attachment exact bytes\n%%EOF\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1cAAAAASUVORK5CYII=', 'base64');

for (const mode of ['offline', 'api'] as const) test(`照护附件HTTP：${mode}模式真实multipart上传、元数据、原始下载、导出和家庭权限在双驱动一致`, async () => {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-17T06:00:00Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db;
  const app = await createApp({ db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token = access) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    async function attach(record: string, options: { bytes?: Buffer; name?: string; type?: string; filename?: string; key?: string; token?: string; expected?: number; missing?: boolean; extraFile?: boolean } = {}) {
      const form = new FormData();
      if (!options.missing) form.append('file', new File([Uint8Array.from(options.bytes ?? pdf)], options.name ?? 'source.pdf', { type: options.type ?? 'application/pdf' }));
      if (options.filename !== undefined) form.append('filename', options.filename);
      if (options.extraFile) form.append('extra', new File([Uint8Array.from(pdf)], 'extra.pdf', { type: 'application/pdf' }));
      const response = await fetch(`${base}/care-records/${record}/attachments`, { method: 'POST', headers: {
        authorization: `Bearer ${options.token ?? access}`, ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      }, body: form, signal: AbortSignal.timeout(5000) });
      const value = await response.json() as any;
      assert.equal(response.status, options.expected ?? 201, JSON.stringify(value)); return value;
    }
    const register = (name: string) => api('/auth/register', 'POST', { email: `attachment-http-${name}-${mode}@example.invalid`, password: 'Synthetic-attachment-http-2026' });
    const owner = await register('owner'), viewer = await register('viewer'), outsider = await register('outsider'); access = owner.access_token;
    const invitation = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, 200, viewer.access_token);
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Attachment HTTP pet' });
    const record = await api('/care-records', 'POST', { pet_id: pet.id, type: 'custom', custom_type: '体检资料', value: { observed: true }, recorded_at: db.now() });
    const path = `/care-records/${record.id}`;
    assert.deepEqual(record.attachments, []);
    now += 1000;
    const first = await attach(record.id, { filename: '  体检报告.pdf  ', key: 'http-file' });
    assert.equal(first.filename, '体检报告.pdf'); assert.equal(first.content_type, 'application/pdf'); assert.equal(first.size_bytes, pdf.length);
    assert.deepEqual(await attach(record.id, { filename: '体检报告.pdf', key: 'http-file' }), first);
    await attach(record.id, { filename: 'changed.pdf', key: 'http-file', expected: 409 });
    now += 1000;
    const image = await attach(record.id, { bytes: png, type: 'image/png', name: '宠物照片.png' });
    assert.equal(image.filename, '宠物照片.png'); assert.equal(image.content_type, 'image/png');
    const list = await api(`${path}/attachments`, 'GET', undefined, 200, viewer.access_token);
    assert.equal(list.items.length, 2); assert.deepEqual(list.items.map((row: any) => row.id).sort(), [first.id, image.id].sort());
    const current = await api(path), history = await api(`${path}/history`);
    assert.equal(current.attachments.length, 2); assert.notEqual(current.updated_at, record.updated_at);
    assert.equal(history.revisions.length, 2); assert.deepEqual(history.revisions[0].record.attachments, []);
    assert.deepEqual(history.revisions[1].record.attachments.map((row: any) => row.id), [first.id]);
    assert.equal((await api(`/pets/${pet.id}/care-records`)).items[0].attachments.length, 2);
    assert.equal((await api(`/pets/${pet.id}/overview?date=2026-11-17`)).care_records[0].attachments.length, 2);
    for (const [meta, bytes] of [[first, pdf], [image, png]] as const) {
      const response = await fetch(origin + meta.download_path, { headers: { authorization: `Bearer ${viewer.access_token}` }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), meta.content_type);
      assert.equal(response.headers.get('content-length'), String(bytes.length));
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
      assert.match(response.headers.get('content-disposition') ?? '', /attachment;/);
      assert.ok((response.headers.get('content-disposition') ?? '').includes(`filename*=UTF-8''${encodeURIComponent(meta.filename)}`));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    await api(`${path}/attachments`, 'GET', undefined, 401, '');
    await api(first.download_path.replace('/api/v1', ''), 'GET', undefined, 401, '');
    await attach(record.id, { token: viewer.access_token, expected: 403 });
    await attach(record.id, { token: outsider.access_token, expected: 404 });
    await api(`${path}/attachments`, 'GET', undefined, 404, outsider.access_token);
    await api(first.download_path.replace('/api/v1', ''), 'GET', undefined, 404, outsider.access_token);
    await attach(record.id, { missing: true, expected: 400 });
    await attach(record.id, { bytes: Buffer.alloc(0), expected: 400 });
    await attach(record.id, { bytes: Buffer.from('forged PDF'), expected: 400 });
    await attach(record.id, { type: 'text/plain', expected: 415 });
    await attach(record.id, { extraFile: true, expected: 400 });
    const query = `household_id=${owner.household.id}&limit=200`;
    const exported = await api(`/auth/data-export/care_attachments?${query}`, 'GET', undefined, 200, viewer.access_token);
    assert.equal(exported.items.length, 1); assert.ok(exported.next_cursor);
    const secondPage = await api(`/auth/data-export/care_attachments?${query}&cursor=${encodeURIComponent(exported.next_cursor)}`, 'GET', undefined, 200, viewer.access_token);
    assert.equal(secondPage.items.length, 1); assert.equal(secondPage.next_cursor, null);
    for (const row of [...exported.items, ...secondPage.items]) assert.deepEqual(Buffer.from(row.content_base64, 'base64'), row.id === first.id ? pdf : png);
    now += 1000;
    await api(`${path}/withdraw`, 'POST', { reason: 'duplicate attachment parent' });
    await attach(record.id, { filename: '体检报告.pdf', key: 'http-file', expected: 409 });
    assert.equal((await api(`${path}/attachments`)).items.length, 2);
    const retained = await fetch(origin + first.download_path, { headers: { authorization: `Bearer ${access}` } });
    assert.equal(retained.status, 200); assert.deepEqual(Buffer.from(await retained.arrayBuffer()), pdf);
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, 'DELETE');
    await api(first.download_path.replace('/api/v1', ''), 'GET', undefined, 404, viewer.access_token);
    const boundaryRecord = await api('/care-records', 'POST', { pet_id: pet.id, type: 'note', value: {}, recorded_at: db.now() });
    const maximum = Buffer.alloc(5 * 1024 * 1024); png.copy(maximum);
    const boundary = await attach(boundaryRecord.id, { bytes: maximum, type: 'image/png', name: 'boundary.png' });
    const maximumSha = createHash('sha256').update(maximum).digest('hex');
    assert.equal(boundary.size_bytes, maximum.length); assert.equal(boundary.sha256, maximumSha);
    const boundaryContent = await fetch(origin + boundary.download_path, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(boundaryContent.status, 200); assert.equal(boundaryContent.headers.get('content-length'), String(maximum.length));
    assert.equal(boundaryContent.headers.get('content-type'), 'image/png');
    const downloaded = Buffer.from(await boundaryContent.arrayBuffer());
    assert.equal(downloaded.length, maximum.length); assert.equal(createHash('sha256').update(downloaded).digest('hex'), maximumSha);
    await attach(boundaryRecord.id, { bytes: Buffer.concat([maximum, Buffer.from([0])]), type: 'image/png', name: 'oversize.png', expected: 413 });
    assert.deepEqual((await api(`/care-records/${boundaryRecord.id}/attachments`)).items.map((row: any) => row.id), [boundary.id]);
    const boundaryHistory = await api(`/care-records/${boundaryRecord.id}/history`);
    assert.equal(boundaryHistory.revisions.length, 1); assert.deepEqual(boundaryHistory.revisions[0].record.attachments, []);
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
