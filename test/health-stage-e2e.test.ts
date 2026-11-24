import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { Row } from '../src/db';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`health assessment HTTP ${mode}: saved history, evidence revisions and personal read authorization`, async () => {
  process.env.DATA_MODE = mode; process.env.IDEMPOTENCY_TTL_HOURS = '24';
  let now = Date.parse('2026-11-24T12:00:00.000Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db;
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
    const register = (name: string) => api('/auth/register', 'POST', { email: `health-${name}-${mode}@example.invalid`, password: 'Synthetic-health-http-2026', timezone: 'UTC' });
    const owner = await register('owner'), viewer = await register('viewer'), outsider = await register('outsider'); access = owner.access_token;
    const invitation = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, undefined, 200, viewer.access_token);
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Health history fixture' });
    const otherPet = await api('/pets', 'POST', { household_id: owner.household.id, name: 'Other history fixture' });
    const from = '2026-11-24T11:59:59.000Z', to = '2026-11-24T12:01:00.000Z';
    const listPath = `/pets/${pet.id}/health-observations?from=${from}&to=${to}&timezone=UTC`;
    assert.deepEqual((await api(listPath)).items, []);
    const device = db.id(); let seq = 0;
    await db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', device, `health-${mode}`, 'fixture', 'fixture', 'unused', db.now());
    const span = async (date: string, metrics: Row) => {
      const id = db.id(), event = db.id(), start = `${date}T00:00:00.000Z`, end = `${date}T12:00:00.000Z`; seq++;
      await db.run(`INSERT INTO device_events(event_id,device_id,pet_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, event, device, pet.id, 'activity.reported', end, db.now(), seq, 'health-fixture', '{}', '{}', db.now());
      await db.run('INSERT INTO activity_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, event, device, pet.id, start, end,
        metrics.steps ?? null, metrics.active_seconds ?? null, null, metrics.sleep_seconds ?? null, 0, 'fixture-device', '{}');
      return id;
    };
    for (const day of ['2026-11-11', '2026-11-13', '2026-11-15']) await span(day, { steps: 1000, active_seconds: 1200 });
    const targetSample = await span('2026-11-17', { steps: 500, active_seconds: 1200 });
    // Adding source data does not silently generate an assessment history.
    assert.deepEqual((await api(listPath)).items, []);
    const observationPath = `/pets/${pet.id}/observations?date=2026-11-17&timezone=UTC`;
    const snapshot = await api(observationPath, 'GET', undefined, undefined, 200, viewer.access_token);
    assert.equal(snapshot.status, 'ready'); assert.deepEqual(snapshot.observations.map((item: any) => item.metric), ['steps']);
    now += 1000;
    const missing = await api(`/pets/${pet.id}/observations?date=2026-11-16&timezone=UTC`);
    assert.equal(missing.status, 'insufficient_data');
    const inProgress = await api(`/pets/${pet.id}/observations?date=2026-11-24&timezone=UTC`);
    assert.equal(inProgress.status, 'day_in_progress');
    const current = await api(`/pets/${pet.id}/observations/current?timezone=UTC`);
    const firstList = await api(listPath); assert.equal(firstList.items.length, 2);
    const item = firstList.items.find((row: any) => row.id === snapshot.id), missingItem = firstList.items.find((row: any) => row.id === missing.id);
    assert.equal(item.kind, 'activity_assessment'); assert.equal(item.finding_count, 1); assert.equal(item.read_at, null); assert.equal(item.superseded, false);
    assert.deepEqual(item.assessment, snapshot); assert.equal(missingItem.finding_count, 0); assert.deepEqual(missingItem.assessment, missing);
    await api(`/health-observations/${current.id}`, 'GET', undefined, undefined, 404);
    await api(`/health-observations/${inProgress.id}`, 'GET', undefined, undefined, 404);
    const detailPath = `/health-observations/${snapshot.id}`, readPath = `${detailPath}/read`;
    assert.deepEqual((await api(detailPath)).assessment, snapshot);
    await api(listPath, 'GET', undefined, undefined, 404, outsider.access_token);
    await api(detailPath, 'GET', undefined, undefined, 404, outsider.access_token);
    await api(readPath, 'PATCH', undefined, undefined, 404, outsider.access_token);
    now += 1000;
    const viewerRead = await api(readPath, 'PATCH', undefined, 'viewer-read', 200, viewer.access_token);
    assert.ok(viewerRead.read_at); assert.equal((await api(detailPath)).read_at, null);
    now += 1000;
    assert.equal((await api(readPath, 'PATCH', undefined, 'viewer-read', 200, viewer.access_token)).read_at, viewerRead.read_at);
    assert.equal((await api(readPath, 'PATCH', undefined, undefined, 200, viewer.access_token)).read_at, viewerRead.read_at);
    assert.deepEqual((await api(listPath + '&read_status=read', 'GET', undefined, undefined, 200, viewer.access_token)).items.map((row: any) => row.id), [snapshot.id]);
    assert.deepEqual((await api(listPath + '&read_status=unread', 'GET', undefined, undefined, 200, viewer.access_token)).items.map((row: any) => row.id), [missing.id]);
    assert.equal((await api(listPath + '&read_status=unread')).items.length, 2);
    const ownerRead = await api(readPath, 'PATCH', undefined, 'owner-read'); assert.ok(ownerRead.read_at);

    now += 1000;
    await span('2026-11-01', { steps: 999 });
    assert.equal((await api(observationPath)).id, snapshot.id, 'unrelated date must not create another evidence revision');
    await db.run('UPDATE activity_samples SET sleep_seconds=? WHERE id=?', 1800, targetSample);
    assert.equal((await api(observationPath)).id, snapshot.id, 'sleep-only change must not reset a steps/activity assessment');
    assert.equal((await api(detailPath)).read_at, ownerRead.read_at); assert.equal((await api(listPath)).items.length, 2);
    now += 1000;
    await db.run('UPDATE activity_samples SET steps=? WHERE id=?', 1000, targetSample);
    const changed = await api(observationPath); assert.notEqual(changed.id, snapshot.id); assert.deepEqual(changed.observations, []);
    const changedDetail = await api(`/health-observations/${changed.id}`);
    assert.equal(changedDetail.read_at, null); assert.equal(changedDetail.superseded, false); assert.equal(changedDetail.finding_count, 0);
    const oldDetail = await api(detailPath); assert.equal(oldDetail.superseded, true); assert.deepEqual(oldDetail.assessment, snapshot); assert.equal(oldDetail.read_at, ownerRead.read_at);
    assert.equal((await api(listPath)).items.length, 3);
    now += 1000;
    await db.run('UPDATE activity_samples SET steps=? WHERE id=?', 500, targetSample);
    const restored = await api(observationPath);
    assert.notEqual(restored.id, snapshot.id, 'returning to earlier input must preserve the newer correction as its own evidence revision');
    assert.notEqual(restored.id, changed.id); assert.deepEqual(restored.observations.map((row: any) => row.metric), ['steps']);
    const restoredDetail = await api(`/health-observations/${restored.id}`);
    assert.equal(restoredDetail.read_at, null); assert.equal(restoredDetail.superseded, false);
    assert.equal((await api(detailPath)).superseded, true); assert.equal((await api(`/health-observations/${changed.id}`)).superseded, true);
    assert.deepEqual((await api(detailPath)).assessment.evidence, snapshot.evidence);
    assert.deepEqual((await api(`/health-observations/${changed.id}`)).assessment.evidence, changed.evidence);
    now += 1000;
    await span('2026-10-31', { steps: 321 });
    await db.run('UPDATE activity_samples SET sleep_seconds=? WHERE id=?', 2400, targetSample);
    assert.equal((await api(observationPath)).id, restored.id, 'unchanged current input must keep the newest revision, including after returning to earlier values');
    assert.equal((await api(`/health-observations/${restored.id}`)).read_at, null);
    assert.equal((await api(listPath)).items.length, 4);
    assert.deepEqual((await api(listPath.replace('timezone=UTC', 'timezone=Asia%2FShanghai'))).items, []);
    await api(listPath.replace('timezone=UTC', 'timezone=Not%2FA_Zone'), 'GET', undefined, undefined, 400);
    await api(listPath + '&read_status=other', 'GET', undefined, undefined, 400);
    await api(`/pets/${pet.id}/health-observations?from=2026-10-01T00:00:00Z&to=2026-11-24T00:00:00Z`, 'GET', undefined, undefined, 400);
    await api(`/pets/${pet.id}/health-observations?from=${to}&to=${from}`, 'GET', undefined, undefined, 400);
    const exact = await api(`/pets/${pet.id}/health-observations?from=${snapshot.generated_at}&to=${missing.generated_at}&timezone=UTC`);
    assert.deepEqual(exact.items.map((row: any) => row.id), [snapshot.id]);
    const pagedPath = listPath + '&limit=1', pageIds: string[] = []; let cursor: string | null = null;
    do { const page = await api(pagedPath + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')); pageIds.push(...page.items.map((row: any) => row.id)); cursor = page.next_cursor; } while (cursor);
    assert.deepEqual(pageIds, [restored.id, changed.id, missing.id, snapshot.id]); assert.equal(new Set(pageIds).size, 4);
    const firstPage = await api(pagedPath), encoded = encodeURIComponent(firstPage.next_cursor);
    await api(`${pagedPath}&cursor=${encoded}`, 'GET', undefined, undefined, 400, viewer.access_token);
    await api(`${pagedPath.replace(pet.id, otherPet.id)}&cursor=${encoded}`, 'GET', undefined, undefined, 400);
    await api(`${pagedPath}&read_status=unread&cursor=${encoded}`, 'GET', undefined, undefined, 400);
    await api(`${pagedPath.replace('timezone=UTC', 'timezone=Etc%2FUTC')}&cursor=${encoded}`, 'GET', undefined, undefined, 400);

    const viewerExport = await api('/auth/data-export/health_observation_reads', 'GET', undefined, undefined, 200, viewer.access_token);
    assert.deepEqual(viewerExport.items.map((row: any) => row.observation_id), [snapshot.id]);
    assert.equal(viewerExport.items[0].read_at, viewerRead.read_at);
    await api(`/households/${owner.household.id}/members/${viewer.user.id}`, 'DELETE');
    await api(listPath, 'GET', undefined, undefined, 404, viewer.access_token);
    await api(detailPath, 'GET', undefined, undefined, 404, viewer.access_token);
    await api(readPath, 'PATCH', undefined, 'viewer-read', 404, viewer.access_token);
    assert.deepEqual((await api('/auth/data-export/health_observation_reads', 'GET', undefined, undefined, 200, viewer.access_token)).items, []);
    assert.equal((await api('/health')).mode, mode); assert.equal(externalCalls, 0);
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/pets/{id}/health-observations'].get);
    assert.ok(schema.paths['/api/v1/health-observations/{id}'].get); assert.ok(schema.paths['/api/v1/health-observations/{id}/read'].patch);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
