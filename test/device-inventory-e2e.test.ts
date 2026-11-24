import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { IdentityService } from '../src/identity';
import { DevicesService, provisionDevice } from '../src/devices';
import { openBackendFixture } from './backend-fixture';

test('device inventory HTTP: current ownership pagination, unbound recovery and no family telemetry or credentials', async () => {
  process.env.DATA_MODE = 'offline';
  const fixture = await openBackendFixture(), db = fixture.db, identity = new IdentityService(db), devices = new DevicesService(db);
  const app = await createApp({ db, quiet: true });
  try {
    const owner = await identity.register({ email: 'inventory-owner@example.invalid', password: 'Inventory-only-2026' });
    const other = await identity.register({ email: 'inventory-other@example.invalid', password: 'Inventory-only-2026' });
    await app.listen(0, '127.0.0.1'); const base = `${await app.getUrl()}/api/v1`;
    async function get(query = '', token = owner.access_token, expected = 200) {
      const response = await fetch(`${base}/devices${query}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json() as any; assert.equal(response.status, expected, JSON.stringify(body));
      if (expected === 200) assert.equal(response.headers.get('cache-control'), 'no-store'); return body;
    }
    assert.deepEqual(await get(), { items: [], next_cursor: null }); await get('', '', 401);
    const owned: string[] = [];
    for (let n = 0; n < 3; n++) {
      const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: `Inventory ${n}` });
      const device = await provisionDevice(db, { serial_no: `inventory-${n}` });
      await devices.claim(owner.user.id, { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
      if (n !== 1) await devices.unbind(owner.user.id, device.device_id);
      owned.push(device.device_id);
    }
    const full = await get(); assert.equal(full.items.length, 3);
    assert.equal(full.items.filter((row: any) => row.binding_status === 'unbound').length, 2);
    assert.equal(full.items.filter((row: any) => row.binding_status === 'bound').length, 1);
    for (const row of full.items) {
      assert.deepEqual(Object.keys(row).sort(), ['id','serial_no','vendor','model','hardware_rev','created_at','credential','binding_status'].sort());
      assert.equal(row.credential.status, 'active');
    }
    assert.deepEqual((await get('', other.access_token)).items, []);
    const first = await get('?limit=1'), found = [first.items[0].id]; let cursor = first.next_cursor;
    while (cursor) { const page = await get(`?limit=1&cursor=${encodeURIComponent(cursor)}`); found.push(page.items[0].id); cursor = page.next_cursor; }
    assert.deepEqual(found, owned.sort());
    await get(`?cursor=${encodeURIComponent(first.next_cursor)}`, other.access_token, 400);
    for (const query of ['?limit=0', '?limit=201', '?status=unbound', '?cursor=', '?cursor=%25', '?limit=1&limit=2']) await get(query, undefined, 400);
    const unbound = full.items.find((row: any) => row.binding_status === 'unbound');
    const renewed = await devices.renewClaimCode(owner.user.id, unbound.id); assert.ok(renewed.claim_code);
    assert.equal(JSON.stringify(await get()).includes(renewed.claim_code), false);
    await devices.release(owner.user.id, unbound.id);
    assert.equal((await get()).items.length, 2); assert.ok(!(await get()).items.some((row: any) => row.id === unbound.id));
  } finally { await app.close(); await fixture.close(); }
});
