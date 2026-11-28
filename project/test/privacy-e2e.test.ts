import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';

test('隐私HTTP：家庭转移、共享删除和账号注销在SQLite/PostgreSQL保持一致', async () => {
  process.env.DATA_MODE = 'offline';
  const backend = await openBackendFixture(() => new Date('2026-11-17T06:00:00Z'));
  const app = await createApp({ db: backend.db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/api/v1`;
    async function api(path: string, options: { method?: string; body?: unknown; token?: string; status?: number } = {}) {
      const response = await fetch(base + path, { method: options.method ?? 'GET', headers: { 'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(5000) });
      const value = await response.json() as any;
      assert.equal(response.status, options.status ?? (options.method === 'POST' ? 201 : 200), JSON.stringify(value));
      return value;
    }
    const password = 'Synthetic-privacy-http-2026';
    const register = (name: string) => api('/auth/register', { method: 'POST', body: { email: `${name}@example.invalid`, password } });
    const owner = await register('privacy-http-owner'), caregiver = await register('privacy-http-caregiver'), unrelated = await register('privacy-http-unrelated');
    const invite = await api(`/households/${owner.household.id}/invitations`, { method: 'POST', token: owner.access_token, body: { email: caregiver.user.email, role: 'caregiver' } });
    await api(`/invitations/${invite.token}/accept`, { method: 'POST', token: caregiver.access_token, status: 200 });
    const pet = await api('/pets', { method: 'POST', token: owner.access_token, body: { household_id: owner.household.id, name: 'HTTP shared deletion pet' } });
    const otherPet = await api('/pets', { method: 'POST', token: unrelated.access_token, body: { household_id: unrelated.household.id, name: 'HTTP unrelated pet' } });
    await api('/auth/account-deletion', { status: 401 });
    await api('/auth/account-deletion', { token: owner.access_token });
    await api(`/pets/${pet.id}/deletion-preview`, { token: owner.access_token });
    await api(`/households/${owner.household.id}/deletion-preview`, { token: owner.access_token });
    await api(`/pets/${pet.id}`, { method: 'DELETE', token: caregiver.access_token, body: { password, confirmation: pet.id }, status: 403 });
    await api('/auth/account', { method: 'DELETE', token: owner.access_token, body: { password, confirmation: 'DELETE' }, status: 409 });
    await api(`/households/${owner.household.id}/owner`, { method: 'POST', token: owner.access_token,
      body: { password, new_owner_user_id: caregiver.user.id } });
    await api(`/pets/${pet.id}`, { method: 'DELETE', token: caregiver.access_token, body: { password: 'Wrong-password-http', confirmation: pet.id }, status: 401 });
    await api(`/pets/${pet.id}`, { method: 'DELETE', token: caregiver.access_token, body: { password, confirmation: otherPet.id }, status: 400 });
    await api(`/pets/${pet.id}`, { method: 'DELETE', token: caregiver.access_token, body: { password, confirmation: pet.id } });
    await api(`/pets/${pet.id}`, { token: caregiver.access_token, status: 404 });
    await api(`/pets/${otherPet.id}`, { token: unrelated.access_token });
    await api('/auth/account', { method: 'DELETE', token: owner.access_token, body: { password, confirmation: 'DELETE' } });
    await api('/auth/me', { token: owner.access_token, status: 401 });
    await api('/auth/refresh', { method: 'POST', body: { refresh_token: owner.refresh_token }, status: 401 });
    await api('/auth/login', { method: 'POST', body: { email: owner.user.email, password }, status: 401 });
    const households = await api('/households', { token: caregiver.access_token });
    assert.ok(households.items.some((item: any) => item.id === owner.household.id && item.role === 'owner'));
    await api(`/households/${owner.household.id}`, { method: 'DELETE', token: caregiver.access_token, body: { password, confirmation: owner.household.id } });
    assert.equal(await backend.db.get('SELECT id FROM households WHERE id=?', owner.household.id), undefined);
    await api(`/pets/${otherPet.id}`, { token: unrelated.access_token });
    const schema = await (await fetch(`${await app.getUrl()}/openapi.json`)).json() as any;
    for (const path of ['/api/v1/auth/account-deletion', '/api/v1/auth/account', '/api/v1/pets/{id}/deletion-preview',
      '/api/v1/households/{id}/deletion-preview', '/api/v1/households/{id}/owner']) assert.ok(schema.paths[path], path);
  } finally { await app.close(); await backend.close(); }
});
