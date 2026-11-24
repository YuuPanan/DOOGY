import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1cAAAAASUVORK5CYII=', 'base64');

for (const mode of ['offline', 'api'] as const) test(`第一批账号HTTP：${mode}模式保存、重新登录、multipart头像、版本冲突与家庭撤权`, async () => {
  process.env.DATA_MODE = mode;
  const backend = await openBackendFixture(() => new Date('2026-11-24T03:00:00Z'));
  const app = await createApp({ db: backend.db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token = access, key?: string) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, JSON.stringify(value)); return value;
    }
    const owner = await api('/auth/register', 'POST', { email: `profile-http-${mode}@example.invalid`, password: 'password123', display_name: 'Original' });
    access = owner.access_token;
    assert.equal((await api('/auth/me')).display_name, 'Original');
    const changed = await api('/auth/me', 'PATCH', { display_name: 'Updated', consent: { terms_version: 'reviewed-terms', privacy_version: 'reviewed-privacy', source: 'web-profile' }, expected_version: 1 }, 200, access, 'profile');
    assert.equal(changed.profile_version, 2); assert.equal(changed.consent.accepted_at, backend.db.now());
    assert.deepEqual(await api('/auth/me', 'PATCH', { display_name: 'Updated', consent: { terms_version: 'reviewed-terms', privacy_version: 'reviewed-privacy', source: 'web-profile' }, expected_version: 1 }, 200, access, 'profile'), changed);
    await api('/auth/me', 'PATCH', { display_name: 'Stale', expected_version: 1 }, 409);
    const login = await api('/auth/login', 'POST', { email: owner.user.email, password: 'password123' }, 200);
    assert.equal(login.user.display_name, 'Updated'); access = login.access_token;
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Baku' });
    const weighted = await api(`/pets/${pet.id}`, 'PATCH', { weight_kg: 4.5 }, 200, access, 'profile-weight');
    assert.deepEqual(await api(`/pets/${pet.id}`, 'PATCH', { weight_kg: 4.5 }, 200, access, 'profile-weight'), weighted);
    assert.equal((await api(`/pets/${pet.id}/care-records?type=weight`)).items.length, 1);
    await api(`/pets/${pet.id}`, 'PATCH', { weight_kg: 5 }, 409, access, 'profile-weight');
    await api(`/pets/${pet.id}`, 'PATCH', { weight_kg: null }, 409);
    const skipped = await api('/auth/onboarding', 'PATCH', { pet_id: pet.id, collar_choice: 'skipped', completed: true, expected_version: 0 }, 200, access, 'skip');
    assert.equal(skipped.next_step, 'done'); assert.equal(skipped.device_report.status, 'unbound');
    assert.equal((await api('/auth/onboarding')).version, 1);
    await api('/auth/onboarding', 'PATCH', { collar_choice: 'completed', expected_version: 1 }, 409);
    const viewer = await api('/auth/register', 'POST', { email: `profile-viewer-${mode}@example.invalid`, password: 'password123' });
    const invite = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invite.token}/accept`, 'POST', undefined, 200, viewer.access_token);
    const viewerChoice = { pet_id: pet.id, collar_choice: 'skipped', completed: true, expected_version: 0 };
    await api('/auth/onboarding', 'PATCH', viewerChoice, 200, viewer.access_token, 'viewer-onboarding');
    async function avatar(version: number, expected = 200, token = access, key?: string) {
      const form = new FormData(); form.append('file', new File([Uint8Array.from(png)], 'avatar.png', { type: 'image/png' })); form.append('expected_version', String(version));
      const response = await fetch(`${base}/pets/${pet.id}/avatar`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) }, body: form });
      const value = await response.json() as any;
      if (expected === 0) return { status: response.status, value };
      assert.equal(response.status, expected, JSON.stringify(value)); return value;
    }
    const first = await avatar(0, 200, access, 'avatar'); assert.equal(first.version, 1);
    assert.deepEqual(await avatar(0, 200, access, 'avatar'), first);
    const file = await fetch(origin + first.content_path, { headers: { authorization: `Bearer ${viewer.access_token}` } });
    assert.equal(file.status, 200); assert.match(file.headers.get('cache-control') ?? '', /no-store/); assert.equal(file.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
    await avatar(1, 403, viewer.access_token);
    const simultaneous = await Promise.all([avatar(1, 0), avatar(1, 0)]);
    assert.deepEqual(simultaneous.map(result => result.status).sort(), [200, 409]);
    assert.equal(simultaneous.find(result => result.status === 200).value.version, 2);
    await api(first.content_path.replace('/api/v1', ''), 'GET', undefined, 404);
    assert.equal((await api(`/pets/${pet.id}`)).avatar.version, 2);
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, 'DELETE');
    await api('/auth/onboarding', 'PATCH', viewerChoice, 404, viewer.access_token, 'viewer-onboarding');
    await api(`/pets/${pet.id}/avatar/content`, 'GET', undefined, 404, viewer.access_token);
    const spec = await fetch(origin + '/openapi.json').then(response => response.json()) as any;
    assert.ok(spec.paths['/api/v1/auth/me'].patch); assert.ok(spec.paths['/api/v1/pets/{id}/avatar'].put);
  } finally { await app.close(); await backend.close(); }
});
