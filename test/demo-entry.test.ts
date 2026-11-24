import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { seedMvpDemo } from '../scripts/mvp-demo';
import { createApp } from '../src/app';
import { Db } from '../src/db';

const apiModule = new Function('url', 'return import(url)')(pathToFileURL(resolve('web/api.mjs')).href);

for (const demo of [false, true]) test(`登录入口：${demo ? '独立演示环境公布的两类合成账号可登录并查看功能' : '普通环境不提供演示账号，也不会自动播种用户数据库'}`, async () => {
  const previousMode = process.env.DATA_MODE, previousDemo = process.env.DOOGY_DEMO;
  process.env.DATA_MODE = 'offline';
  if (demo) process.env.DOOGY_DEMO = '1'; else delete process.env.DOOGY_DEMO;
  const db = new Db(':memory:', () => new Date('2026-11-17T06:00:00Z'));
  const originalFetch = globalThis.fetch;
  let app: Awaited<ReturnType<typeof createApp>> | undefined, origin = '', externalCalls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!origin || new URL(target).origin !== origin) {
        externalCalls++; throw new Error('Unexpected external request during offline demo');
      }
      return originalFetch(input, init);
    };
    const seeded = demo ? await seedMvpDemo(db) : null;
    app = await createApp({ db, quiet: true });
    await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
    const response = await fetch(`${origin}/api/v1/health`), health = await response.json() as any;
    assert.equal(response.status, 200); assert.equal(health.demo, demo); assert.equal(health.mode, 'offline');
    const { ApiClient } = await apiModule;
    if (seeded) {
      assert.deepEqual(health.demo_accounts, { owner: seeded.owner, viewer: seeded.viewer });
      for (const role of ['owner', 'viewer'] as const) {
        const client = new ApiClient(`${origin}/api/v1`, null), account = health.demo_accounts[role];
        const session = await client.login(account);
        assert.equal(session.user.email, account.email);
        assert.equal(session.households.find((item: any) => item.id === seeded.household_id).role, role);
        const pets = (await client.get('/pets')).items;
        assert.equal(pets.length, 2);
        const overview: any = await client.get(`/pets/${seeded.pet_id}/overview`);
        assert.equal(overview.pet.name, '豆豆（合成演示）');
        assert.equal(overview.device.reporting.execution_source, 'simulator');
        assert.equal((await client.get(`/pets/${seeded.pet_id}/care-records`)).items.length, 5);
        assert.equal((await client.get(`/pets/${seeded.pet_id}/locations`)).items.length, 9);
        assert.equal((await client.get(`/pets/${seeded.pet_id}/safety-events`)).items.length, 3);
        await client.logout();
      }
    } else {
      assert.equal(Object.hasOwn(health, 'demo_accounts'), false);
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM users'))!.count, 0);
      const client = new ApiClient(`${origin}/api/v1`, null);
      await assert.rejects(client.login({ email: 'owner@doogy-demo.example.invalid', password: 'Doogy-MVP-demo-2026!' }), (error: any) => error.status === 401 && error.code === 'INVALID_CREDENTIALS');
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM users'))!.count, 0);
    }
    assert.equal(externalCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMode === undefined) delete process.env.DATA_MODE; else process.env.DATA_MODE = previousMode;
    if (previousDemo === undefined) delete process.env.DOOGY_DEMO; else process.env.DOOGY_DEMO = previousDemo;
    try { if (app) await app.close(); } finally { await db.close(); }
  }
});
