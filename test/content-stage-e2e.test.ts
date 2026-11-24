import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import { importContent } from '../src/content';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`内容与学习HTTP：${mode}模式目录、本人进度、版本升级和撤回，零外部业务调用`, async () => {
  process.env.DATA_MODE = mode;
  const backend = await openBackendFixture(() => new Date('2026-11-24T05:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true });
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business call'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token = access, key?: string) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json() as any; assert.equal(response.status, expected, JSON.stringify(value)); return value;
    }
    await api('/lessons', 'GET', undefined, 401);
    const user = await api('/auth/register', 'POST', { email: `content-${mode}@example.invalid`, password: 'password123' }); access = user.access_token;
    const other = await api('/auth/register', 'POST', { email: `content-other-${mode}@example.invalid`, password: 'password123' });
    assert.equal((await api('/lessons')).items.length, 0);
    assert.equal((await api('/learning-progress')).counts.available_count, 0);
    const entry = { id: db.id(), kind: 'lesson', content_version: 1, expected_revision: 0, status: 'published', content: {
      title: 'Synthetic HTTP lesson', category: 'test-only', body: 'Synthetic isolated fixture; not real published advice.', applicability: 'Automated tests only',
      sources: [{ title: 'Synthetic source', reference: 'isolated test fixture only' }], review: { status: 'reviewed', reviewer: 'Synthetic test reviewer, no real approval', reviewed_at: db.now() },
      lesson: { video: { url: 'https://example.invalid/synthetic-video.mp4' }, steps: [{ id: 'one', title: 'Synthetic first step' }] },
    } };
    const second = { ...entry, id: db.id(), content: { ...entry.content, title: 'Another synthetic lesson' } };
    const draft = { ...entry, id: db.id(), status: 'draft', content: { ...entry.content, title: 'Pending synthetic draft', review: { status: 'pending' } } };
    await importContent(db, { items: [entry, second, draft] });
    const list = await api('/lessons?limit=1'); assert.equal(list.items.length, 1); assert.ok(list.next_cursor);
    assert.equal((await api('/lessons?limit=1&cursor=' + encodeURIComponent(list.next_cursor))).items.length, 1);
    assert.equal((await api('/content?kind=lesson&category=test-only&q=HTTP')).items[0].id, entry.id);
    await api('/content?cursor=' + encodeURIComponent(list.next_cursor), 'GET', undefined, 400, other.access_token);
    await api(`/lessons/${draft.id}`, 'GET', undefined, 404);
    const detail = await api(`/lessons/${entry.id}`); assert.equal(detail.progress.version, 0); assert.equal(detail.lesson.video.url, entry.content.lesson.video.url);
    const input = { content_version: 1, completed_step_ids: [], learned: true, expected_version: 0 };
    const progress = await api(`/lessons/${entry.id}/progress`, 'PUT', input, 200, access, 'learn');
    assert.equal(progress.learned, true); assert.deepEqual(progress.completed_step_ids, []);
    assert.deepEqual(await api(`/lessons/${entry.id}/progress`, 'PUT', input, 200, access, 'learn'), progress);
    await api(`/lessons/${entry.id}/progress`, 'PUT', { ...input, learned: false }, 409, access, 'learn');
    await api(`/lessons/${entry.id}/progress`, 'PUT', { ...input, user_id: other.user.id }, 400);
    await api(`/lessons/${entry.id}/progress`, 'PUT', { ...input, completed_step_ids: ['invalid'], expected_version: 1 }, 400);
    const mine = await api('/learning-progress'); assert.equal(mine.counts.available_count, 2); assert.equal(mine.counts.learned_count, 1);
    assert.equal((await api('/learning-progress', 'GET', undefined, 200, other.access_token)).items.length, 0);
    const login = await api('/auth/login', 'POST', { email: user.user.email, password: 'password123' }, 200); access = login.access_token;
    assert.equal((await api(`/lessons/${entry.id}`)).progress.learned, true);
    const v2 = { ...entry, content_version: 2, expected_revision: 1, content: { ...entry.content, title: 'Synthetic HTTP lesson v2' } };
    await importContent(db, { items: [v2] });
    assert.equal((await api('/learning-progress')).counts.learned_count, 0);
    assert.equal((await api('/learning-progress')).items[0].content_status, 'updated');
    await api(`/lessons/${entry.id}/progress`, 'PUT', input, 409, access, 'learn');
    const simultaneous = await Promise.all([0, 1].map(async () => {
      const response = await fetch(`${base}/lessons/${entry.id}/progress`, { method: 'PUT', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...input, content_version: 2 }) });
      await response.arrayBuffer(); return response.status;
    }));
    assert.deepEqual(simultaneous.sort(), [200, 409]);
    await importContent(db, { items: [{ ...v2, expected_revision: 2, status: 'withdrawn' }] });
    await api(`/lessons/${entry.id}`, 'GET', undefined, 404);
    await api(`/lessons/${entry.id}?version=1`, 'GET', undefined, 404);
    await api(`/lessons/${entry.id}/progress`, 'PUT', { ...input, content_version: 2, expected_version: 1 }, 404);
    const unavailable = await api('/learning-progress'); assert.equal(unavailable.counts.available_count, 1); assert.equal(unavailable.counts.learned_count, 0);
    assert.ok(unavailable.items.every((row: any) => row.title === null && row.body === undefined && row.content_status === 'unavailable'));
    await importContent(db, { items: [{ ...entry, content_version: 3, expected_revision: 3, content: { ...entry.content, title: 'Synthetic HTTP lesson v3' } }] });
    await api(`/lessons/${entry.id}?version=1`, 'GET', undefined, 404);
    await api(`/lessons/${entry.id}?version=2`, 'GET', undefined, 404);
    assert.equal((await api(`/lessons/${entry.id}`)).content_version, 3);
    const reviewedDraft = { ...entry, id: db.id(), status: 'draft' };
    await importContent(db, { items: [reviewedDraft] });
    await importContent(db, { items: [{ ...reviewedDraft, content_version: 2, expected_revision: 1, status: 'published' }] });
    await api(`/lessons/${reviewedDraft.id}?version=1`, 'GET', undefined, 404);
    assert.equal(externalCalls, 0);
    const spec = await fetch(origin + '/openapi.json').then(response => response.json()) as any;
    assert.ok(spec.paths['/api/v1/lessons/{id}/progress'].put); assert.ok(spec.paths['/api/v1/content'].get);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
