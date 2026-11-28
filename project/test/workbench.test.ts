import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/app';
import { Db } from '../src/db';

const apiModule = new Function('url', 'return import(url)')(pathToFileURL(resolve('web/api.mjs')).href);
const sessionKey = 'doogy.workbench.session';
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
async function fixture() {
  process.env.DATA_MODE = 'offline';
  let now = Date.parse('2026-11-17T06:00:00Z');
  const db = new Db(':memory:', () => new Date(now)), app = await createApp({ db, quiet: true });
  await app.listen(0, '127.0.0.1');
  const { ApiClient, ApiError } = await apiModule, origin = await app.getUrl(), storage = memoryStorage();
  return { db, app, ApiClient, ApiError, origin, storage, client: new ApiClient(`${origin}/api/v1`, storage),
    advance: (ms: number) => { now += ms; }, close: async () => { await app.close(); await db.close(); } };
}
const credentials = { email: 'workbench-client@example.invalid', password: 'Synthetic-workbench-client-2026' };

test('工作台客户端：注册、会话恢复、登录和退出实际调用服务器并清理浏览器会话', async () => {
  const f = await fixture();
  try {
    await f.client.register({ ...credentials, household_name: '客户端测试家庭', timezone: 'UTC' });
    const user = await f.client.get('/auth/me'), household = (await f.client.get('/households')).items[0];
    assert.equal(f.client.authenticated, true);
    const saved = JSON.parse(f.storage.getItem(sessionKey)!);
    assert.equal(saved.access_token, f.client.session.access_token); assert.equal(saved.refresh_token, f.client.session.refresh_token);
    assert.equal(JSON.stringify(saved).includes(credentials.password), false);
    const restored = new f.ApiClient(`${f.origin}/api/v1`, f.storage), resumed = await restored.resume();
    assert.equal(resumed.user.id, user.id); assert.equal(resumed.households[0].id, household.id);
    await restored.logout();
    assert.equal(restored.authenticated, false); assert.equal(f.storage.getItem(sessionKey), null);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sessions'))!.n, 0);
    assert.equal(await restored.resume(), null);
    await restored.login(credentials);
    assert.equal((await restored.get('/auth/me')).id, user.id); assert.equal(restored.authenticated, true);
  } finally { await f.close(); }
});

test('工作台客户端：同时遇到访问令牌过期只刷新一次并用旋转后的令牌重试', async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  let refreshes = 0;
  try {
    await f.client.register(credentials);
    const user = await f.client.get('/auth/me'), household = (await f.client.get('/households')).items[0], saved = { ...f.client.session };
    f.advance(31 * 60_000);
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/auth/refresh')) refreshes++;
      return originalFetch(input, init);
    };
    const [me, households, pets] = await Promise.all([f.client.get('/auth/me'), f.client.get('/households'), f.client.get('/pets')]);
    assert.equal(me.id, user.id); assert.equal(households.items[0].id, household.id); assert.deepEqual(pets.items, []);
    assert.equal(refreshes, 1); assert.notEqual(f.client.session.access_token, saved.access_token);
    assert.notEqual(f.client.session.refresh_token, saved.refresh_token);
    assert.equal(JSON.parse(f.storage.getItem(sessionKey)!).access_token, f.client.session.access_token);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sessions'))!.n, 1);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('工作台客户端：保留服务端错误信息，刷新令牌过期后清除本地登录', async () => {
  const f = await fixture();
  try {
    await f.client.register(credentials);
    await assert.rejects(f.client.send('POST', '/pets', { name: '' }), (error: any) => {
      assert.ok(error instanceof f.ApiError); assert.equal(error.status, 400); assert.equal(error.code, 'VALIDATION_ERROR');
      assert.ok(error.requestId); assert.ok(error.message); return true;
    });
    f.advance(31 * 86400_000);
    await assert.rejects(f.client.get('/auth/me'), (error: any) => {
      assert.ok(error instanceof f.ApiError); assert.equal(error.status, 401); assert.equal(error.code, 'INVALID_REFRESH_TOKEN'); return true;
    });
    assert.equal(f.client.authenticated, false); assert.equal(f.client.session, null); assert.equal(f.storage.getItem(sessionKey), null);
    await assert.rejects(f.client.login({ ...credentials, password: 'incorrect-password' }), (error: any) => error.status === 401 && error.code === 'INVALID_CREDENTIALS');
    assert.equal(f.client.authenticated, false);
  } finally { await f.close(); }
});

test('工作台客户端：写入成功但响应丢失时不会自动重发，网络失败的退出也清除会话', async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  let writes = 0;
  try {
    await f.client.register(credentials);
    const household = (await f.client.get('/households')).items[0];
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/pets') && init?.method === 'POST') {
        writes++; const response = await originalFetch(input, init); await response.arrayBuffer(); throw new TypeError('synthetic connection lost after commit');
      }
      return originalFetch(input, init);
    };
    await assert.rejects(f.client.send('POST', '/pets', { household_id: household.id, name: '只创建一次' }), (error: any) => error.status === 0 && error.code === 'NETWORK_ERROR');
    assert.equal(writes, 1); assert.equal((await f.client.get('/pets')).items.length, 1);
    globalThis.fetch = async () => { throw new TypeError('synthetic offline logout'); };
    await assert.rejects(f.client.logout(), (error: any) => error.status === 0 && error.code === 'NETWORK_ERROR');
    assert.equal(f.client.authenticated, false); assert.equal(f.storage.getItem(sessionKey), null);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});
