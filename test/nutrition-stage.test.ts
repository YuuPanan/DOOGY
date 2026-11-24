import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CareService } from '../src/care';
import { Db } from '../src/db';
import { NutritionService } from '../src/nutrition';

async function fixture() {
  process.env.DATA_MODE = 'offline'; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  const db = new Db(':memory:', () => new Date('2026-11-24T12:00:00Z')), home = db.id();
  await db.run('INSERT INTO users(id,email,password_hash,created_at) VALUES (?,?,?,?)', 'owner', 'nutrition@example.invalid', 'unused', db.now());
  await db.run('INSERT INTO households VALUES (?,?,?,?)', home, 'Nutrition', 'owner', db.now());
  await db.run('INSERT INTO household_members VALUES (?,?,?,?)', home, 'owner', 'owner', db.now());
  await db.run('INSERT INTO pets VALUES (?,?,?,?,?,?,?,?,?)', 'pet', home, 'Meal pet', 'dog', null, null, 9, db.now(), db.now());
  return { db, care: new CareService(db), nutrition: new NutritionService(db) };
}
const input = (type: string, value: Record<string, any>, recorded_at = '2026-11-24T03:00:00Z') => ({ pet_id: 'pet', type, value, recorded_at });
const meal = (extra: Record<string, any> = {}) => ({ schema_version: 'feeding-v1', food_name: 'Labelled food', category: 'dry', amount: 100, unit: 'g', meal_type: 'meal', ...extra });

test('kg/lb preserves original input, canonical kg, idempotency, edits and withdrawal', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const old = await f.care.create('owner', input('weight', { weight_kg: 10 }, '2026-11-23T03:00:00Z'));
  assert.deepEqual(old.value, { weight_kg: 10 });
  const raw = input('weight', { weight: 22.046226218487757, unit: 'lb' });
  const record = await f.care.create('owner', raw, 'weight-pounds');
  assert.equal(record.value.unit, 'lb'); assert.equal(record.value.weight, raw.value.weight);
  assert.ok(Math.abs(record.value.weight_kg - 10) < 1e-10);
  assert.deepEqual(await f.care.create('owner', raw, 'weight-pounds'), record);
  const updated = await f.care.update('owner', record.id, { value: { weight: 12, unit: 'kg' } }, 'weight-edit');
  assert.deepEqual(updated.value, { weight: 12, unit: 'kg', weight_kg: 12 });
  assert.equal((await f.db.get('SELECT weight_kg FROM pets WHERE id=?', 'pet'))!.weight_kg, 12);
  assert.deepEqual((await f.care.history('owner', record.id)).revisions[0].record.value, record.value);
  await f.care.withdraw('owner', record.id, { reason: 'duplicate' });
  assert.equal((await f.db.get('SELECT weight_kg FROM pets WHERE id=?', 'pet'))!.weight_kg, 10);
  for (const value of [{ weight: 10 }, { unit: 'lb' }, { weight: 10, unit: 'oz' }, { weight: 10, unit: 'lb', weight_kg: 10 }, { weight: 0, unit: 'kg' }, { weight: 700, unit: 'lb' }]) {
    await assert.rejects(f.care.create('owner', input('weight', value)));
  }
});

test('label-only nutrition counts each record once, unknown stays unknown and edits/withdrawals recalculate', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const label = { kcal: 400, per_amount: 100, unit: 'g', source: 'package label 2026-11' };
  const main = await f.care.create('owner', input('feeding', meal({ amount: 0.2, unit: 'kg', label_energy: label })), 'main-meal');
  await f.care.create('owner', input('feeding', meal({ amount: 0.2, unit: 'kg', label_energy: label })), 'main-meal');
  const snack = await f.care.create('owner', input('feeding', meal({ amount: 10, meal_type: 'snack', label_energy: label })));
  await f.care.create('owner', input('feeding', meal({ food_name: 'No label' })));
  await f.care.create('owner', input('feeding', { food: 'Legacy', grams: 12, kcal: 999 }));
  const initial = await f.nutrition.daily('owner', 'pet', { date: '2026-11-24', timezone: 'UTC' });
  assert.equal(initial.known_kcal, 840); assert.equal(initial.unknown_energy_count, 2); assert.equal(initial.record_count, 4);
  assert.equal(initial.completeness, 'partial'); assert.equal(initial.target_kcal, null);
  assert.equal(initial.items.find((row: any) => row.id === main.id).energy.calculation_version, 'label-energy-v1');
  assert.equal(initial.items.find((row: any) => row.id === snack.id).value.meal_type, 'snack');
  await f.care.update('owner', main.id, { value: meal({ amount: 50, label_energy: label }) });
  await f.care.withdraw('owner', snack.id, { reason: 'duplicate' });
  const revised = await f.nutrition.daily('owner', 'pet', { date: '2026-11-24', timezone: 'UTC' });
  assert.equal(revised.known_kcal, 200); assert.equal(revised.record_count, 3); assert.equal(revised.unknown_energy_count, 2);
  const empty = await f.nutrition.daily('owner', 'pet', { date: '2026-11-23', timezone: 'UTC' });
  assert.equal(empty.known_kcal, null); assert.equal(empty.completeness, 'missing');
});

test('feeding-v1 validates label density and dimensions without breaking legacy JSON', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  for (const extra of [
    { amount: -1 }, { amount: 0 }, { meal_type: 'breakfast' }, { food_name: '' }, { unit: 'cup' },
    { label_energy: { kcal: -1, per_amount: 100, unit: 'g', source: 'label' } },
    { label_energy: { kcal: 1, per_amount: 0, unit: 'g', source: 'label' } },
    { label_energy: { kcal: 100, per_amount: 100, unit: 'ml', source: 'label' } },
    { label_energy: { kcal: 100, per_amount: 100, unit: 'g' } },
    { label_energy: { kcal: 100, per_amount: 1e-300, unit: 'g', source: 'label' } },
  ]) await assert.rejects(f.care.create('owner', input('feeding', meal(extra))));
  const zero = await f.care.create('owner', input('feeding', meal({ label_energy: { kcal: 0, per_amount: 100, unit: 'g', source: 'label' } })));
  assert.equal(zero.value.label_energy.kcal, 0);
  const legacyValue = { food: 'old data', amount: 'one bowl', unit: 'cup', custom: { future: true } };
  assert.deepEqual((await f.care.create('owner', input('feeding', legacyValue))).value, legacyValue);
  const daily = await f.nutrition.daily('owner', 'pet', { date: '2026-11-24', timezone: 'UTC' });
  assert.equal(daily.known_kcal, 0); assert.equal(daily.unknown_energy_count, 1);
});

test('nutrition uses actual DST local dates and preserves unknown energy instead of fabricating zero', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const value = meal({ amount: 1, unit: 'portion', label_energy: { kcal: 20, per_amount: 1, unit: 'portion', source: 'label' } });
  await f.care.create('owner', input('feeding', value, '2026-03-08T04:59:59Z'));
  await f.care.create('owner', input('feeding', value, '2026-03-08T05:00:00Z'));
  await f.care.create('owner', input('feeding', value, '2026-03-09T03:59:59Z'));
  await f.care.create('owner', input('feeding', value, '2026-03-09T04:00:00Z'));
  const day = await f.nutrition.daily('owner', 'pet', { date: '2026-03-08', timezone: 'America/New_York' });
  assert.equal(day.known_kcal, 40); assert.equal(day.record_count, 2); assert.equal(day.completeness, 'complete');
  assert.equal(Date.parse(day.period_end) - Date.parse(day.period_start), 23 * 3600_000);
  await f.care.create('owner', input('feeding', {}));
  const unknown = await f.nutrition.daily('owner', 'pet', { date: '2026-11-24', timezone: 'UTC' });
  assert.equal(unknown.known_kcal, null); assert.equal(unknown.unknown_energy_count, 1);
});
