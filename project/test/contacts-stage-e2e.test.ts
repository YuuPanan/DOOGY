import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`家庭联系人HTTP ${mode}：保存、主联系人、报告来源、版本、权限及删除，零外部调用`, async () => {
  process.env.DATA_MODE = mode;
  const backend = await openBackendFixture(() => new Date('2026-11-24T10:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external call'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token = access, key?: string) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json() as any; assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const owner = await api('/auth/register', 'POST', { email: `contacts-http-${mode}@example.invalid`, password: 'password123' }); access = owner.access_token;
    const viewer = await api('/auth/register', 'POST', { email: `contacts-http-viewer-${mode}@example.invalid`, password: 'password123' });
    const outsider = await api('/auth/register', 'POST', { email: `contacts-http-other-${mode}@example.invalid`, password: 'password123' });
    const path = `/households/${owner.household.id}/contacts`;
    await api(path, 'GET', undefined, 401, '');
    const invite = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invite.token}/accept`, 'POST', undefined, 200, viewer.access_token);
    const body = { name: 'Family contact', phone: '+44 (0) 20-1234', consent: { status: 'reported_granted', note: 'Member reports permission' } };
    const first = await api(path, 'POST', body, 201, access, 'contact-create');
    assert.deepEqual(await api(path, 'POST', body, 201, access, 'contact-create'), first);
    assert.equal(first.is_primary, false); assert.equal(first.consent.verified, false); assert.equal(first.consent.source, 'household_member_reported');
    assert.equal(first.consent.reported_by, owner.user.id); assert.equal(first.consent.reported_at, db.now());
    await api(path, 'POST', { name: 'No method' }, 400);
    await api(path, 'POST', body, 403, viewer.access_token);
    await api(path, 'GET', undefined, 404, outsider.access_token);
    const second = await api(path, 'POST', { name: 'Primary email', email: 'PRIMARY@Example.com', is_primary: true });
    assert.equal(second.email, 'primary@example.com'); assert.equal(second.phone, null);
    const switched = await api(`/contacts/${first.id}`, 'PATCH', { expected_version: 1, is_primary: true }, 200, access, 'primary');
    assert.equal(switched.primary_contact_id, first.id);
    const page = await api(path + '?limit=1'); assert.equal(page.items.length, 1); assert.ok(page.next_cursor); assert.equal(page.primary_contact_id, first.id);
    assert.equal((await api(path + '?limit=1&cursor=' + encodeURIComponent(page.next_cursor))).items.length, 1);
    await api(path + '?cursor=' + encodeURIComponent(page.next_cursor), 'GET', undefined, 400, viewer.access_token);
    const secondState = (await api(path)).items.find((row: any) => row.id === second.id); assert.equal(secondState.version, 2); assert.equal(secondState.is_primary, false);
    await api(`/contacts/${second.id}`, 'DELETE', { expected_version: 1 }, 409);
    const reset = await api(`/contacts/${first.id}`, 'PATCH', { expected_version: 2, phone: '987654' }, 200, access, 'change-phone');
    assert.equal(reset.consent.status, 'unknown'); assert.equal(reset.consent.reported_at, null);
    assert.deepEqual(await api(`/contacts/${first.id}`, 'PATCH', { expected_version: 2, phone: '987654' }, 200, access, 'change-phone'), reset);
    await api(`/contacts/${first.id}`, 'PATCH', { expected_version: 2, phone: '111111' }, 409, access, 'change-phone');
    await api(`/contacts/${first.id}`, 'PATCH', { expected_version: 3, name: 'viewer edit' }, 403, viewer.access_token);
    await api(`/contacts/${first.id}`, 'PATCH', { expected_version: 3, name: 'cross household' }, 404, outsider.access_token);
    const login = await api('/auth/login', 'POST', { email: owner.user.email, password: 'password123' }, 200); access = login.access_token;
    assert.equal((await api(path)).items.find((row: any) => row.id === first.id).phone, '987654');
    await api(`/contacts/${first.id}`, 'DELETE', undefined, 400);
    const deleted = await api(`/contacts/${first.id}`, 'DELETE', { expected_version: 3 }); assert.equal(deleted.deleted, true); assert.equal(deleted.primary_contact_id, null);
    await api(`/contacts/${first.id}`, 'DELETE', { expected_version: 3 }, 404);
    const retained = await api(path); assert.equal(retained.items.length, 1); assert.equal(retained.items[0].is_primary, false);
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, 'DELETE');
    await api(path, 'GET', undefined, 404, viewer.access_token);
    assert.equal(externalCalls, 0);
    const spec = await fetch(origin + '/openapi.json').then(response => response.json()) as any;
    assert.ok(spec.paths['/api/v1/households/{id}/contacts'].post); assert.ok(spec.paths['/api/v1/contacts/{id}'].delete);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
