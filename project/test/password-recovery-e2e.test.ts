import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app';
import { PasswordRecoveryService } from '../src/password-recovery';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`密码找回HTTP ${mode}：统一受理、无材料泄漏、真实会话吊销或未配置状态，零外部调用`, async () => {
  process.env.DATA_MODE = mode;
  const backend = await openBackendFixture(() => new Date('2026-11-24T10:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? String(input) : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business call'); }
      return originalFetch(input, init);
    };
    async function api(path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token?: string) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: code=${value.code ?? 'none'}`); return { value, response };
    }
    const originalPassword = 'Synthetic-HTTP-original', newPassword = 'Synthetic-HTTP-new-password';
    const owner = (await api('/auth/register', 'POST', { email: `password-http-${mode}@example.invalid`, password: originalPassword })).value;
    const previous = (await db.get('SELECT password_hash FROM users WHERE id=?', owner.user.id))!.password_hash;
    const known = await api('/auth/password-recovery', 'POST', { email: owner.user.email }, 202);
    const missing = await api('/auth/password-recovery', 'POST', { email: `missing-${mode}@example.invalid` }, 202);
    assert.deepEqual(Object.keys(known.value).sort(), Object.keys(missing.value).sort()); assert.equal(known.value.delivery_status, missing.value.delivery_status);
    assert.match(known.response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(Object.hasOwn(known.value, 'token'), false); assert.equal(Object.hasOwn(known.value, 'token_hash'), false); assert.equal(Object.hasOwn(known.value, 'user_id'), false);
    assert.equal((await db.get('SELECT password_hash FROM users WHERE id=?', owner.user.id))!.password_hash, previous);
    await api('/auth/me', 'GET', undefined, 200, owner.access_token);
    await api('/auth/password-recovery/deliver', 'POST', { request_id: known.value.request_id }, 404);
    const recovery = new PasswordRecoveryService(db), delivery = await recovery.deliver(known.value.request_id);
    const secretRows = await db.all('SELECT token_hash FROM password_recovery_requests');
    if (mode === 'offline') {
      assert.equal(delivery.delivery_status, 'offline_demo'); assert.equal(typeof delivery.token, 'string');
      assert.equal(JSON.stringify(known.value).includes(delivery.token), false);
      assert.equal(JSON.stringify(secretRows).includes(delivery.token), false);
      const wrong = await api('/auth/password-reset', 'POST', { request_id: known.value.request_id, token: 'wrong-token', new_password: newPassword }, 400);
      assert.equal(wrong.value.code, 'INVALID_PASSWORD_RESET');
      assert.equal((await db.get('SELECT failed_attempts FROM password_recovery_requests WHERE id=?', known.value.request_id))!.failed_attempts, 1);
      await api('/auth/me', 'GET', undefined, 200, owner.access_token);
      const completed = await api('/auth/password-reset', 'POST', { request_id: known.value.request_id, token: delivery.token, new_password: newPassword }, 200);
      assert.deepEqual(completed.value, { reset: true, sessions_revoked: true, relogin_required: true });
      assert.match(completed.response.headers.get('cache-control') ?? '', /no-store/);
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', owner.user.id))!.n, 0);
      await api('/auth/me', 'GET', undefined, 401, owner.access_token);
      await api('/auth/refresh', 'POST', { refresh_token: owner.refresh_token }, 401);
      await api('/auth/login', 'POST', { email: owner.user.email, password: originalPassword }, 401);
      const loggedIn = (await api('/auth/login', 'POST', { email: owner.user.email, password: newPassword }, 200)).value; assert.equal(loggedIn.user.id, owner.user.id);
      await api('/auth/password-reset', 'POST', { request_id: known.value.request_id, token: delivery.token, new_password: 'Do-not-apply-replay' }, 400);
    } else {
      assert.equal(known.value.delivery_status, 'not_configured'); assert.equal(delivery.delivery_status, 'not_configured'); assert.equal(Object.hasOwn(delivery, 'token'), false);
      assert.ok(secretRows.every(row => row.token_hash === null));
      const failed = await api('/auth/password-reset', 'POST', { request_id: known.value.request_id, token: 'not-generated', new_password: newPassword }, 400);
      assert.equal(failed.value.code, 'INVALID_PASSWORD_RESET');
      await api('/auth/me', 'GET', undefined, 200, owner.access_token);
      assert.equal((await db.get('SELECT password_hash FROM users WHERE id=?', owner.user.id))!.password_hash, previous);
    }
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope LIKE '%password-recovery%' OR scope LIKE '%password-reset%'"))!.n, 0);
    assert.equal(externalCalls, 0);
    const spec = await fetch(origin + '/openapi.json').then(response => response.json()) as any;
    assert.ok(spec.paths['/api/v1/auth/password-recovery'].post); assert.ok(spec.paths['/api/v1/auth/password-reset'].post);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
