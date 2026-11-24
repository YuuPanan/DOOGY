import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { openBackendFixture } from './backend-fixture';

for (const mode of ['offline', 'api'] as const) test(`活动观察反馈HTTP：${mode}模式只关联实际生成的观察并按本人导出`, async () => {
  process.env.DATA_MODE = mode;
  const backend = await openBackendFixture(() => new Date('2026-11-18T12:00:00Z')), db = backend.db;
  const app = await createApp({ db, quiet: true });
  try {
    await app.listen(0, '127.0.0.1');
    const base = `${await app.getUrl()}/api/v1`;
    let access = '';
    async function api(path: string, method = 'GET', body?: unknown, status = method === 'POST' ? 201 : 200, token = access, deviceToken?: string, key?: string) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(deviceToken ? { 'x-device-token': deviceToken } : {}),
        ...(key ? { 'idempotency-key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const result = await response.json() as any;
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
      return result;
    }
    const register = (name: string) => api('/auth/register', 'POST', { email: `observation-feedback-${name}@example.invalid`, password: 'Synthetic-activity-feedback-2026', timezone: 'UTC' });
    const owner = await register('owner'), caregiver = await register('caregiver'), viewer = await register('viewer');
    access = owner.access_token;
    const householdId = owner.household.id;
    for (const [member, role] of [[caregiver, 'caregiver'], [viewer, 'viewer']]) {
      const invitation = await api(`/households/${householdId}/invitations`, 'POST', { email: member.user.email, role });
      await api(`/invitations/${invitation.token}/accept`, 'POST', undefined, 200, member.access_token);
    }
    const createPet = (name: string) => api('/pets', 'POST', { household_id: householdId, name });
    const pet = await createPet('观察反馈用合成宠物'), otherPet = await createPet('同家庭其他宠物');
    const device = await provisionDevice(db, { serial_no: `OBSERVATION-FEEDBACK-${mode}` });
    await api('/devices/claim', 'POST', { device_id: device.device_id, pet_id: pet.id, claim_code: device.claim_code });
    let seq = 0;
    async function span(start_at: string, end_at: string, steps: number, active_seconds?: number) {
      const eventId = randomUUID();
      await api('/ingest/events', 'POST', { schema_version: '1.0', event_id: eventId, device_id: device.device_id,
        boot_id: 'observation-feedback', seq: seq++, device_ts: end_at, event_type: 'activity.reported',
        payload: { start_at, end_at, steps, active_seconds, estimated: false } }, 202, '', device.device_token);
      assert.equal(await app.get(TelemetryService).work(), 1);
      assert.equal((await api(`/ingest/events/${eventId}`)).process_status, 'processed');
    }
    for (const day of ['2026-11-11', '2026-11-13', '2026-11-15']) {
      await span(`${day}T00:00:00Z`, `${day}T12:00:00Z`, 1000, 1200);
    }
    const date = '2026-11-17';
    await span(`${date}T00:00:00Z`, `${date}T12:00:00Z`, 500, 1200);
    const observationPath = `/pets/${pet.id}/observations?date=${date}`;
    const snapshot = await api(observationPath, 'GET', undefined, 200, viewer.access_token);
    assert.equal(snapshot.status, 'ready');
    assert.deepEqual(snapshot.observations.map((item: any) => item.metric), ['steps']);
    const [evidenceId] = snapshot.observations[0].evidence_ids;
    const feedbackPath = `/pets/${pet.id}/feedback`;
    const linked = { feature_date: date, assessment: 'helpful', comment: '描述可用于回看当天上报记录', observation: { id: snapshot.id, evidence_id: evidenceId } };
    assert.equal((await api(feedbackPath, 'POST', linked, 403, viewer.access_token)).code, 'READ_ONLY');
    const invalid = async (path: string, body: typeof linked) => {
      assert.equal((await api(path, 'POST', body, 404)).code, 'OBSERVATION_EVIDENCE_NOT_FOUND');
    };
    await invalid(`/pets/${otherPet.id}/feedback`, linked);
    await invalid(feedbackPath, { ...linked, feature_date: '2026-11-16' });
    const nonObservation = snapshot.comparisons.find((item: any) => item.metric === 'active_minutes');
    assert.ok(nonObservation.evidence_id, '相同活动分钟数可比较，但不构成一条变化观察');
    await invalid(feedbackPath, { ...linked, observation: { id: snapshot.id, evidence_id: nonObservation.evidence_id } });
    await api(feedbackPath, 'POST', { ...linked, comment: '  ' }, 400);

    const missing = await api(`/pets/${pet.id}/observations?date=2026-11-16`);
    assert.equal(missing.status, 'insufficient_data');
    assert.deepEqual(missing.observations, []);
    await invalid(feedbackPath, { ...linked, feature_date: missing.local_date, observation: { id: missing.id, evidence_id: `${missing.id}:steps` } });

    await span(`${date}T12:00:00Z`, '2026-11-18T00:00:00Z', 500);
    const refreshed = await api(observationPath);
    assert.notEqual(refreshed.id, snapshot.id);
    assert.deepEqual(refreshed.observations, []);
    const key = randomUUID();
    const helpful = await api(feedbackPath, 'POST', { ...linked, evidence: { observation_id: 'client override' } }, 201, access, undefined, key);
    assert.deepEqual(await api(feedbackPath, 'POST', linked, 201, access, undefined, key), helpful);
    const expectedEvidence = { source: 'activity_observation', observation_id: snapshot.id, evidence_id: evidenceId,
      metric: 'steps', rule_version: snapshot.rule_version, timezone: snapshot.timezone, generated_at: snapshot.generated_at };
    assert.deepEqual(helpful.evidence, expectedEvidence);
    const incorrect = await api(feedbackPath, 'POST', { ...linked, assessment: 'incorrect', comment: '照护者补充当天的记录背景' }, 201, caregiver.access_token);
    assert.deepEqual(incorrect.evidence, expectedEvidence);
    const legacy = await api(feedbackPath, 'POST', { feature_date: date, assessment: 'other', comment: '通用反馈', evidence: { note: 'legacy' } });
    assert.deepEqual(legacy.evidence, { note: 'legacy' });

    const ownerExport = await api('/auth/data-export/feedback');
    assert.equal(ownerExport.items.length, 2);
    assert.deepEqual(ownerExport.items.find((item: any) => item.id === helpful.id).evidence, expectedEvidence);
    const caregiverExport = await api('/auth/data-export/feedback', 'GET', undefined, 200, caregiver.access_token);
    assert.deepEqual(caregiverExport.items.map((item: any) => item.id), [incorrect.id]);
    assert.deepEqual((await api('/auth/data-export/feedback', 'GET', undefined, 200, viewer.access_token)).items, []);
    assert.equal((await api('/health')).mode, mode);
  } finally { await app.close(); await backend.close(); }
});
