import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';
import { insertSyntheticMedia } from './media-fixture';

for (const mode of ['offline', 'api'] as const) test(`媒体基础HTTP：${mode}模式授权原字节、单段Range、分页、删除与撤权`, async () => {
  process.env.DATA_MODE = mode;
  const backend = await openBackendFixture(() => new Date('2026-11-24T08:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token = access) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json() as any; assert.equal(response.status, expected, JSON.stringify(value)); return value;
    }
    const owner = await api('/auth/register', 'POST', { email: `media-http-${mode}@example.invalid`, password: 'password123' }); access = owner.access_token;
    const viewer = await api('/auth/register', 'POST', { email: `media-http-viewer-${mode}@example.invalid`, password: 'password123' });
    const outsider = await api('/auth/register', 'POST', { email: `media-http-other-${mode}@example.invalid`, password: 'password123' });
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Synthetic HTTP media' });
    const invite = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invite.token}/accept`, 'POST', undefined, 200, viewer.access_token);
    const first = await insertSyntheticMedia(db, pet.id, owner.user.id), second = await insertSyntheticMedia(db, pet.id, owner.user.id);
    const metadata = await api(`/media/${first.id}`, 'GET', undefined, 200, viewer.access_token);
    assert.equal(metadata.content_base64, undefined); assert.equal(metadata.sha256, first.sha256); assert.equal(metadata.duration_seconds, 1);
    const firstPage = await api(`/pets/${pet.id}/media?limit=1`); assert.equal(firstPage.items.length, 1); assert.ok(firstPage.next_cursor);
    assert.equal((await api(`/pets/${pet.id}/media?limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`)).items.length, 1);
    await api(`/pets/${pet.id}/media?cursor=${encodeURIComponent(firstPage.next_cursor)}`, 'GET', undefined, 400, viewer.access_token);
    const contentPath = `${base}/media/${first.id}/content`;
    const full = await fetch(contentPath, { headers: { authorization: `Bearer ${viewer.access_token}` } });
    assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(full.headers.get('content-type'), 'audio/wav');
    assert.equal(full.headers.get('content-length'), String(first.size_bytes)); assert.match(full.headers.get('cache-control') ?? '', /no-store/); assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    const original = Buffer.from(await full.arrayBuffer()); assert.deepEqual(original, first.bytes); assert.equal(createHash('sha256').update(original).digest('hex'), first.sha256);
    for (const [range, start, end] of [['bytes=0-9', 0, 9], ['bytes=10-', 10, first.size_bytes - 1], ['bytes=-10', first.size_bytes - 10, first.size_bytes - 1], [`bytes=${first.size_bytes - 5}-${first.size_bytes + 100}`, first.size_bytes - 5, first.size_bytes - 1]] as const) {
      const response = await fetch(contentPath, { headers: { authorization: `Bearer ${access}`, range } });
      assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${first.size_bytes}`);
      assert.equal(response.headers.get('content-length'), String(end - start + 1)); assert.deepEqual(Buffer.from(await response.arrayBuffer()), first.bytes.subarray(start, end + 1));
    }
    for (const range of [`bytes=${first.size_bytes}-`, 'bytes=0-1,4-5', 'bytes=-0', 'bytes=bad']) {
      const response = await fetch(contentPath, { headers: { authorization: `Bearer ${access}`, range } });
      assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${first.size_bytes}`); assert.equal((await response.json() as any).code, 'UNSATISFIABLE_MEDIA_RANGE');
    }
    const head = await fetch(contentPath, { method: 'HEAD', headers: { authorization: `Bearer ${access}` } }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(first.size_bytes)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    await api(`/media/${first.id}`, 'GET', undefined, 401, '');
    await api(`/media/${first.id}/content`, 'GET', undefined, 401, '');
    await api(`/media/${first.id}/content`, 'GET', undefined, 404, outsider.access_token);
    await api(`/media/${first.id}`, 'DELETE', undefined, 403, viewer.access_token);
    assert.equal((await api(`/media/${second.id}`, 'DELETE')).deleted, true);
    await api(`/media/${second.id}/content`, 'GET', undefined, 404);
    assert.equal((await api(`/pets/${pet.id}/media`)).items.length, 1);
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, 'DELETE');
    await api(`/media/${first.id}/content`, 'GET', undefined, 404, viewer.access_token);
    await api(`/pets/${pet.id}/media`, 'GET', undefined, 404, viewer.access_token);
  } finally { await app.close(); await backend.close(); }
});
