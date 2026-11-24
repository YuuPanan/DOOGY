import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { activityWindow } from '../src/care';
import { Row } from '../src/db';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`wellness HTTP ${mode}: revisions, household isolation, DST buckets and evidence-based trends`, async () => {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  const now = new Date('2026-11-24T12:00:00Z'), backend = await openBackendFixture(() => now), db = backend.db;
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
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const register = (name: string) => api('/auth/register', 'POST', {
      email: `wellness-${name}-${mode}@example.invalid`, password: 'Synthetic-wellness-http-2026', timezone: 'UTC',
    });
    const owner = await register('owner'), viewer = await register('viewer'), stranger = await register('stranger'), caregiver = await register('caregiver'); access = owner.access_token;
    for (const [user, role] of [[viewer, 'viewer'], [caregiver, 'caregiver']] as const) {
      const invitation = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: user.user.email, role });
      await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, undefined, 200, user.access_token);
    }
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Wellness HTTP' });
    const secondPet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Different pet' });
    const goalsPath = `/pets/${pet.id}/goals`, checkPath = `/pets/${pet.id}/body-check-ins?date=2026-11-23&timezone=UTC`;
    assert.equal((await api(`${goalsPath}?date=2026-11-17`)).goals, null);
    const firstInput = { expected_version: 0, effective_date: '2026-11-18', targets: { steps: 100, active_minutes: 60, intake_kcal: 200 } };
    const first = await api(goalsPath, 'PUT', firstInput, 'first-goals'); assert.equal(first.version, 1);
    const revised = await api(goalsPath, 'PUT', { ...firstInput, expected_version: 1, targets: { steps: 200, active_minutes: 30, intake_kcal: 300 },
      plan: { name: 'Gentle routine', content_version: 'user-plan-v1', walk_minutes: 30, play_minutes: 20, training_minutes: 10 } }, 'revise-goals', 200, caregiver.access_token);
    assert.equal(revised.version, 2); assert.equal(revised.targets.active_minutes, 30);
    await api(goalsPath, 'PUT', firstInput, undefined, 409);
    assert.deepEqual(await api(goalsPath, 'PUT', firstInput, 'first-goals'), first);
    await api(goalsPath, 'PUT', { ...firstInput, targets: { steps: 101 } }, 'first-goals', 409);
    const current = await api(goalsPath, 'PUT', { effective_date: '2026-11-20', expected_version: 0, targets: { steps: 400, intake_kcal: 500 } });
    assert.equal((await api(`${goalsPath}?date=2026-11-19`)).goals.id, revised.id);
    assert.equal((await api(`${goalsPath}?date=2026-11-21`)).goals.id, current.id);
    await api(goalsPath, 'PUT', firstInput, 'first-goals', 403, viewer.access_token);
    await api(goalsPath, 'GET', undefined, undefined, 404, stranger.access_token);
    await api(goalsPath, 'PUT', firstInput, undefined, 404, stranger.access_token);
    const nutrition = await api(`/pets/${pet.id}/nutrition/daily?date=2026-11-21&timezone=UTC`);
    assert.equal(nutrition.target_kcal, 500); assert.equal(nutrition.goal_version, current.version);

    const empty = await api(checkPath); assert.equal(empty.version, 0); assert.deepEqual(empty.values, { appetite: null, energy: null, movement: null, stool: null });
    const toilet = (petId: string, kind: string, recorded_at = '2026-11-23T03:00:00Z') => api('/care-records', 'POST', { pet_id: petId, type: 'toileting', value: { kind }, recorded_at });
    const validToilet = await toilet(pet.id, 'defecation'), wrongPet = await toilet(secondPet.id, 'both'), wrongKind = await toilet(pet.id, 'urination'), wrongDay = await toilet(pet.id, 'both', '2026-11-22T03:00:00Z');
    const body = { expected_version: 0, values: { appetite: 'usual', energy: null, movement: 'comfortable', stool: null }, observed_at: '2026-11-23T03:00:00Z', toileting_record_id: validToilet.id, notes: 'Owner observation' };
    const saved = await api(checkPath, 'PUT', body, 'body-first'); assert.equal(saved.version, 1); assert.equal(saved.toileting_record_status, 'active');
    assert.deepEqual(await api(checkPath, 'PUT', body, 'body-first'), saved);
    const corrected = await api(checkPath, 'PUT', { ...body, expected_version: 1, values: { appetite: 'usual', stool: 'formed' } }, 'body-correct', 200, caregiver.access_token);
    assert.equal(corrected.version, 2); assert.equal(corrected.values.energy, null);
    await api(checkPath, 'PUT', body, undefined, 409);
    await api(checkPath, 'PUT', { ...body, expected_version: 2, values: { movement: '' } }, undefined, 400);
    for (const invalid of [wrongPet, wrongKind, wrongDay]) await api(checkPath, 'PUT', { ...body, expected_version: 2, toileting_record_id: invalid.id }, undefined, 400);
    await api(checkPath, 'PUT', { ...body, expected_version: 2, observed_at: '2026-11-24T03:00:00Z' }, undefined, 400);
    await api(checkPath, 'PUT', body, 'body-first', 403, viewer.access_token);
    await api(checkPath, 'GET', undefined, undefined, 404, stranger.access_token);
    assert.equal((await api(checkPath, 'GET', undefined, undefined, 200, viewer.access_token)).version, 2);
    await api(`/care-records/${validToilet.id}/withdraw`, 'POST', { reason: 'duplicate' });
    assert.equal((await api(checkPath)).toileting_record_status, 'withdrawn');
    await api(checkPath, 'PUT', { ...body, expected_version: 2 }, undefined, 400);

    let seq = 0; const deviceId = db.id();
    await db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', deviceId, `wellness-${mode}`, 'fixture', 'fixture', 'unused', db.now());
    const span = async (start: string, end: string, metrics: Row) => {
      const event = db.id(); seq++;
      await db.run(`INSERT INTO device_events(event_id,device_id,pet_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, event, deviceId, pet.id, 'activity.reported', end, db.now(), seq, 'fixture', '{}', '{}', db.now());
      await db.run('INSERT INTO activity_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', db.id(), event, deviceId, pet.id, start, end,
        metrics.steps ?? null, metrics.active_seconds ?? null, null, metrics.sleep_seconds ?? null, 0, metrics.source ?? 'fixture-device', '{}');
    };
    for (const [date, hours, steps] of [['2026-03-08', 23, 230], ['2026-11-01', 25, 250]] as const) {
      const window = activityWindow(date, 'America/New_York', now); await span(window.start, window.end, { steps });
      const path = `/pets/${pet.id}/activity/intervals?from=${window.start}&to=${window.end}&timezone=America/New_York&bucket=hour&limit=7`;
      let cursor: string | null = null; const items: any[] = [];
      do { const page = await api(path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')); items.push(...page.items); cursor = page.next_cursor; } while (cursor);
      assert.equal(items.length, hours); assert.equal(items.reduce((sum, item) => sum + item.steps, 0), steps);
      assert.ok(items.every(item => item.coverage_seconds === 3600 && item.estimated));
      for (let i = 1; i < items.length; i++) assert.equal(items[i - 1].period_end, items[i].period_start);
      const daily = await api(path.replace('bucket=hour', 'bucket=day')); assert.equal(daily.items.length, 1);
      assert.equal(daily.items[0].coverage_seconds, hours * 3600); assert.equal(daily.items[0].steps, steps);
      const firstPage = await api(path); assert.ok(firstPage.next_cursor);
      await api(path.replace('America/New_York', 'UTC') + `&cursor=${encodeURIComponent(firstPage.next_cursor)}`, 'GET', undefined, undefined, 400);
    }
    await span('2026-11-18T00:00:00.000Z', '2026-11-19T00:00:00.000Z', { steps: 0, active_seconds: 600 });
    await span('2026-11-19T00:00:00.000Z', '2026-11-20T00:00:00.000Z', { steps: 100, active_seconds: 600 });
    await span('2026-11-20T00:00:00.000Z', '2026-11-20T12:00:00.000Z', { steps: 50 });
    await span('2026-11-21T00:00:00.000Z', '2026-11-21T06:00:00.000Z', { steps: 50 });
    const trendPath = `/pets/${pet.id}/trends?metric=steps&from=2026-11-20&to=2026-11-22&timezone=UTC&limit=1`;
    const trendFirst = await api(trendPath); assert.equal(trendFirst.items[0].comparison.reason, 'baseline_zero');
    assert.equal(trendFirst.items[0].comparison.percent_change, null); assert.equal(trendFirst.items[0].target, 400);
    const secondPath = trendPath + `&cursor=${encodeURIComponent(trendFirst.next_cursor)}`;
    const before = (await api(secondPath)).items[0]; assert.equal(before.comparison.reason, 'insufficient_coverage'); assert.equal(before.coverage_seconds, 6 * 3600);
    await span('2026-11-21T06:00:00.000Z', '2026-11-22T00:00:00.000Z', { steps: 150 });
    await api(secondPath, 'GET', undefined, undefined, 400, viewer.access_token);
    const viewerFirst = await api(trendPath, 'GET', undefined, undefined, 200, viewer.access_token);
    const after = (await api(trendPath + `&cursor=${encodeURIComponent(viewerFirst.next_cursor)}`, 'GET', undefined, undefined, 200, viewer.access_token)).items[0];
    assert.equal(after.value, 200); assert.equal(after.comparison.comparable, true); assert.equal(after.comparison.percent_change, 100);
    assert.ok(after.source_revision > before.source_revision);
    const sleep = await api(trendPath.replace('metric=steps', 'metric=sleep_minutes')); assert.equal(sleep.items[0].value, null); assert.equal(sleep.items[0].data_status, 'missing');
    await span('2026-11-22T00:00:00.000Z', '2026-11-22T12:00:00.000Z', { steps: 100 });
    await span('2026-11-22T12:00:00.000Z', '2026-11-23T00:00:00.000Z', { sleep_seconds: 3600, source: 'sleep-provider' });
    const mixed = await api(`/pets/${pet.id}/trends?metric=steps&from=2026-11-22&to=2026-11-23&timezone=UTC`);
    assert.deepEqual(mixed.items[0].sources, ['fixture-device']); assert.equal(mixed.items[0].comparison.comparable, true);
    assert.equal(mixed.items[0].comparison.percent_change, -50);
    await api(secondPath, 'GET', undefined, undefined, 404, stranger.access_token);
    await api(trendPath.replace(pet.id, secondPet.id) + `&cursor=${encodeURIComponent(trendFirst.next_cursor)}`, 'GET', undefined, undefined, 400);
    const weight = await api('/care-records', 'POST', { pet_id: pet.id, type: 'weight', value: { weight: 22.046226218487757, unit: 'lb' }, recorded_at: '2026-11-20T03:00:00Z' });
    const weightPath = trendPath.replace('metric=steps', 'metric=weight_kg');
    const weightTrend = await api(weightPath); assert.equal(weightTrend.unit, 'kg'); assert.ok(Math.abs(weightTrend.items[0].value - 10) < 1e-10);
    assert.equal(weightTrend.items[0].records[0].value.unit, 'lb'); assert.equal(weightTrend.items[0].comparison.reason, 'baseline_missing');
    await api(`/care-records/${weight.id}/withdraw`, 'POST', { reason: 'duplicate weight' });
    assert.equal((await api(weightPath)).items[0].value, null);
    const exportedGoals = await api(`/auth/data-export/pet_goals?household_id=${owner.household.id}`);
    assert.equal(exportedGoals.items.length, 3);
    const exportedCheckIns = await api(`/auth/data-export/body_check_ins?household_id=${owner.household.id}`);
    assert.equal(exportedCheckIns.items.length, 2); assert.ok(exportedCheckIns.items.some((row: any) => row.version === 1 && row.values.appetite === 'usual'));
    assert.equal((await api('/health')).mode, mode); assert.equal(externalCalls, 0);
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/pets/{id}/goals'].put); assert.ok(schema.paths['/api/v1/pets/{id}/body-check-ins'].put);
    assert.ok(schema.paths['/api/v1/pets/{id}/activity/intervals'].get); assert.ok(schema.paths['/api/v1/pets/{id}/trends'].get);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
