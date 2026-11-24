import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`今日观察HTTP：${mode}模式同时间进度比较与迟到数据在双驱动一致`, async () => {
  process.env.DATA_MODE = mode;
  let now = new Date('2026-11-18T12:00:00Z');
  const backend = await openBackendFixture(() => now), db = backend.db, app = await createApp({ db, quiet: true });
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    let access = '';
    async function api(route: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token = access, deviceToken?: string) {
      const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(deviceToken ? { 'x-device-token': deviceToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const result = await response.json() as any; assert.equal(response.status, expected, JSON.stringify(result)); return result;
    }
    const register = (name: string) => api('/auth/register', 'POST', { email: `current-${name}-${mode}@example.invalid`, password: 'Synthetic-current-http-2026', timezone: 'UTC' });
    const owner = await register('owner'), viewer = await register('viewer'); access = owner.access_token;
    const invitation = await api(`/households/${owner.household.id}/invitations`, 'POST', { email: viewer.user.email, role: 'viewer' });
    await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, 200, viewer.access_token);
    const pet = await api('/pets', 'POST', { household_id: owner.household.id, name: '今日活动合成宠物' });
    const device = await provisionDevice(db, { serial_no: `CURRENT-E2E-${mode}` });
    await api('/devices/claim', 'POST', { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    let seq = 0;
    async function span(start_at: string, end_at: string, steps: number, active_seconds: number) {
      const event_id = randomUUID();
      await api('/ingest/events', 'POST', { schema_version: '1.0', event_id, device_id: device.device_id,
        boot_id: 'current-http', seq: seq++, device_ts: end_at, event_type: 'activity.reported',
        payload: { start_at, end_at, steps, active_seconds, estimated: false } }, 202, '', device.device_token);
      assert.equal(await app.get(TelemetryService).work(), 1);
      assert.equal((await api(`/ingest/events/${event_id}`)).process_status, 'processed');
    }
    for (const date of ['2026-11-11', '2026-11-13', '2026-11-16']) {
      await span(`${date}T00:00:00Z`, `${date}T12:00:00Z`, 1000, 1200);
      await span(`${date}T12:00:00Z`, `${date}T23:00:00Z`, 9000, 6000);
    }
    await span('2026-11-18T00:00:00Z', '2026-11-18T06:00:00Z', 600, 600);
    const path = `/pets/${pet.id}/observations/current`;
    await api(path, 'GET', undefined, 401, '');
    const completed = await api(`/pets/${pet.id}/observations`);
    assert.equal(completed.local_date, '2026-11-17');
    assert.equal(completed.rule_version, 'activity-observation-v1');
    assert.equal((await api(`/pets/${pet.id}/activity/daily?date=2026-11-16`)).steps, 10000);
    const summaries = await db.all('SELECT * FROM daily_summaries ORDER BY local_date,timezone');
    const observations = await db.all('SELECT * FROM activity_observations ORDER BY id');
    const first = await api(path, 'GET', undefined, 200, viewer.access_token);
    assert.equal(first.rule_version, 'activity-current-v1');
    assert.equal(first.local_date, '2026-11-18');
    assert.equal(first.as_of, db.now());
    assert.equal(first.target.period_end, first.as_of);
    assert.equal(first.target.steps, 600);
    assert.equal(first.comparisons[0].coverage_fraction, 0.5);
    assert.equal(first.comparisons[0].baseline_days, 3);
    assert.equal(first.comparisons[0].baseline_median, 1000);
    assert.equal(first.comparisons[0].delta_percent, -40);
    assert.deepEqual((await api(path)).target, first.target);
    await span('2026-11-18T06:00:00Z', '2026-11-18T12:00:00Z', 400, 600);
    const late = await api(path);
    assert.equal(late.as_of, first.as_of);
    assert.equal(late.target.steps, 1000);
    assert.ok(late.target.source_revision > first.target.source_revision);
    assert.equal(late.comparisons[0].delta_percent, 0);
    assert.deepEqual(late.observations, []);
    now = new Date('2026-11-18T13:00:00Z');
    access = (await api('/auth/login', 'POST', { email: owner.user.email, password: 'Synthetic-current-http-2026' }, 200, '')).access_token;
    const advanced = await api(path);
    assert.equal(advanced.elapsed_seconds, 13 * 3600);
    assert.equal(advanced.comparisons[0].baseline_median, 1818.18);
    assert.deepEqual(await db.all('SELECT * FROM daily_summaries ORDER BY local_date,timezone'), summaries);
    assert.deepEqual(await db.all('SELECT * FROM activity_observations ORDER BY id'), observations);
    await api(`${path}?timezone=Invalid/Zone`, 'GET', undefined, 400);
    await api(`${path}?date=2026-11-17`, 'GET', undefined, 400);
    await api(`${path}?as_of=2026-11-18T00:00:00Z`, 'GET', undefined, 400);
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/pets/{id}/observations/current'].get);
    assert.equal((await api('/health')).mode, mode);
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await backend.close(); }
});
