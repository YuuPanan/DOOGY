import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`nutrition HTTP ${mode}: pounds, label energy, authorization, revision and export`, async () => {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  const backend = await openBackendFixture(() => new Date('2026-11-24T12:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, key?: string, expected = method === 'POST' ? 201 : 200, token = access) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const register = (name: string) => api('/auth/register', 'POST', {
      email: `nutrition-${name}-${mode}@example.invalid`, password: 'Synthetic-nutrition-http-2026', timezone: 'UTC',
    });
    const owner = await register('owner'), viewer = await register('viewer'), outsider = await register('outsider'); access = owner.access_token;
    const invitation = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, undefined, 200, viewer.access_token);
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Nutrition HTTP' });
    const care = (type: string, value: unknown) => ({ pet_id: pet.id, type, value, recorded_at: '2026-11-24T03:00:00Z' });
    const pounds = await api('/care-records', 'POST', care('weight', { weight: 22.046226218487757, unit: 'lb' }), 'pounds');
    assert.ok(Math.abs((await api(`/pets/${pet.id}`)).weight_kg - 10) < 1e-10);
    assert.equal((await api(`/care-records/${pounds.id}`)).value.unit, 'lb');
    const meal = { schema_version: 'feeding-v1', food_name: 'Main food', category: 'dry', amount: 100, unit: 'g', meal_type: 'meal',
      label_energy: { kcal: 400, per_amount: 100, unit: 'g', source: 'package label' } };
    const record = await api('/care-records', 'POST', care('feeding', meal), 'meal');
    assert.deepEqual(await api('/care-records', 'POST', care('feeding', meal), 'meal'), record);
    await api('/care-records', 'POST', care('feeding', { food: 'old unknown calories', grams: 30 }));
    const path = `/pets/${pet.id}/nutrition/daily?date=2026-11-24&timezone=UTC`;
    const daily = await api(path, 'GET', undefined, undefined, 200, viewer.access_token);
    assert.equal(daily.known_kcal, 400); assert.equal(daily.unknown_energy_count, 1); assert.equal(daily.record_count, 2);
    assert.equal(daily.completeness_scope, 'recorded_feeding_only');
    await api(path, 'GET', undefined, undefined, 404, outsider.access_token);
    await api('/care-records', 'POST', care('feeding', meal), undefined, 403, viewer.access_token);
    await api(`/care-records/${record.id}`, 'PATCH', { value: { ...meal, amount: 50 } }, 'edit-meal');
    assert.equal((await api(path)).known_kcal, 200);
    const login = await api('/auth/login', 'POST', { email: owner.user.email, password: 'Synthetic-nutrition-http-2026' }, undefined, 200);
    assert.equal((await api(path, 'GET', undefined, undefined, 200, login.access_token)).known_kcal, 200);
    const exported = await api(`/auth/data-export/care_records?household_id=${owner.household.id}`);
    assert.equal(exported.items.find((row: any) => row.id === pounds.id).value.unit, 'lb');
    assert.equal(exported.items.find((row: any) => row.id === record.id).value.label_energy.source, 'package label');
    await api(`/care-records/${record.id}/withdraw`, 'POST', { reason: 'duplicate meal' });
    const withdrawn = await api(path); assert.equal(withdrawn.known_kcal, null); assert.equal(withdrawn.unknown_energy_count, 1);
    await api('/care-records', 'POST', care('feeding', { ...meal, label_energy: { ...meal.label_energy, unit: 'ml' } }), undefined, 400);
    assert.equal((await api('/health')).mode, mode); assert.equal(externalCalls, 0);
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/pets/{id}/nutrition/daily'].get);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
