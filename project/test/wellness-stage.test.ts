import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Db } from '../src/db';
import { IdentityService } from '../src/identity';
import { WellnessService } from '../src/wellness';

test('本地业务：历史目标、修订冲突、身体观察原文及跨家庭权限', async () => {
  const db = new Db(':memory:', () => new Date('2026-11-24T06:00:00Z'));
  try {
    const identity = new IdentityService(db), service = new WellnessService(db);
    const user = await identity.register({ email: 'wellness@example.invalid', password: 'Wellness-test-2026' });
    const pet = await identity.createPet(user.user.id, { household_id: user.household.id, name: 'Baku' });
    const save = (date: string, steps: number, expected_version = 0) => service.putGoals(user.user.id, pet.id,
      { effective_date: date, expected_version, targets: { steps } });
    await save('2026-11-01', 3000); await save('2026-11-24', 5000);
    assert.equal((await service.goals(user.user.id, pet.id, { date: '2026-11-23' })).goals.targets.steps, 3000);
    await assert.rejects(save('2026-11-24', 6000), /版本/);
    assert.equal((await save('2026-11-24', 6000, 1)).version, 2);
    assert.equal((await service.goals(user.user.id, pet.id, { date: '2026-10-01' })).goals, null);
    const body = { expected_version: 0, values: { appetite: '吃得比平时少', energy: null }, observed_at: db.now() };
    const first = await service.putCheckIn(user.user.id, pet.id, {}, body, 'check-in');
    assert.deepEqual(await service.putCheckIn(user.user.id, pet.id, {}, body, 'check-in'), first);
    assert.equal(first.values.movement, null); assert.equal(first.version, 1);
    await assert.rejects(service.putCheckIn(user.user.id, pet.id, {}, body), /版本/);
    const second = await service.putCheckIn(user.user.id, pet.id, {}, { ...body, expected_version: 1, values: { appetite: null } });
    assert.equal(second.values.appetite, null);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM body_check_ins'))!.n, 2);
    await assert.rejects(service.putCheckIn(user.user.id, pet.id, { date: '2026-11-23' }, body), /观察时间/);
    const outsider = await identity.register({ email: 'outsider-wellness@example.invalid', password: 'Wellness-test-2026' });
    await assert.rejects(service.goals(outsider.user.id, pet.id, {}), /无权/);
  } finally { await db.close(); }
});
