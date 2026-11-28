import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { BehaviorService } from '../src/behavior';
import { behaviorFixture } from './behavior-stage-fixture';

for (const mode of ['offline', 'api'] as const) test(`behavior HTTP ${mode}: manual facts, queued demonstration/failure, cancellation and deleted sources`, async () => {
  const f = await behaviorFixture(mode), app = await createApp({ db: f.db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0;
  try {
    await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(), base = `${origin}/api/v1`;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith(`${origin}/`)) { externalCalls++; throw new Error('Unexpected external business request'); }
      return originalFetch(input, init);
    };
    async function api(path: string, method = 'GET', body?: unknown, key?: string, expected = method === 'POST' ? 201 : 200, token = f.owner.access_token) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
        authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const recordPath = `/pets/${f.pet.id}/behavior-records`, body = { labels: ['barking'], media_id: f.media,
      start_at: '2026-11-24T11:58:00Z', end_at: '2026-11-24T11:59:00Z', notes: 'Manually annotated fixture, not recognized audio' };
    const recorded = await api(recordPath, 'POST', body, 'record-once');
    assert.equal(recorded.source, 'owner_annotation');
    assert.deepEqual(await api(recordPath, 'POST', body, 'record-once'), recorded);
    assert.deepEqual((await api(`/behavior-records/${recorded.id}`, 'GET', undefined, undefined, 200, f.viewer.access_token)).labels, ['barking']);
    await api(recordPath, 'POST', body, undefined, 403, f.viewer.access_token);
    await api(`/behavior-records/${recorded.id}`, 'GET', undefined, undefined, 404, f.stranger.access_token);
    const listPath = `${recordPath}?from=2026-11-24T11:57:00Z&to=2026-11-24T12:00:00Z&label=barking`;
    assert.deepEqual((await api(listPath)).items.map((row: any) => row.id), [recorded.id]);
    const interpretationPath = `/pets/${f.pet.id}/interpretations`, request = { media_id: f.media, behavior_record_id: recorded.id, background: ['not_sure_yet'], notes: 'User context only' };
    const pending = await api(interpretationPath, 'POST', request, 'interpret-once', 202);
    assert.equal(pending.status, 'pending'); assert.equal(pending.captured_mode, mode);
    assert.deepEqual(await api(interpretationPath, 'POST', request, 'interpret-once', 202), pending);
    await api(interpretationPath, 'POST', request, undefined, 403, f.viewer.access_token);
    await api(interpretationPath, 'POST', { ...request, media_id: f.otherMedia }, undefined, 404);
    await api(`/interpretations/${pending.id}`, 'GET', undefined, undefined, 404, f.stranger.access_token);
    const device = f.db.id(), event = f.db.id();
    await f.db.run('INSERT INTO devices(id,serial_no,vendor,model,secret_hash,created_at) VALUES (?,?,?,?,?,?)', device, `behavior-http-${mode}`, 'fixture', 'fixture', 'unused', f.db.now());
    await f.db.run(`INSERT INTO device_events(event_id,device_id,pet_id,type,device_ts,received_at,seq,boot_id,payload_json,envelope_json,next_attempt_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, event, device, f.pet.id, 'activity.reported', '2026-11-24T11:59:00.000Z', f.db.now(), 1, 'behavior-http', '{}', '{}', f.db.now());
    await f.db.run('INSERT INTO activity_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', f.db.id(), event, device, f.pet.id,
      '2026-11-24T11:58:00.000Z', '2026-11-24T11:59:00.000Z', 42, 30, null, null, 0, 'synthetic-fixture', '{}');
    const service = app.get(BehaviorService); assert.equal(await service.work(), 1);
    const done = await api(`/interpretations/${pending.id}`, 'GET', undefined, undefined, 200, f.viewer.access_token);
    if (mode === 'offline') {
      assert.equal(done.status, 'succeeded'); assert.equal(done.execution_source, 'offline_demo'); assert.equal(done.model_version, null);
      assert.equal(done.result.is_demo, true); assert.deepEqual(done.result.claims, []); assert.equal(done.evidence.used_by_model, false);
      assert.equal(done.evidence.evidence_usage, 'prepared_not_model_analyzed'); assert.equal(done.evidence.activity.steps, 42);
      assert.ok(done.evidence.activity.source_revision >= 1); assert.deepEqual(done.evidence.activity.sources, ['synthetic-fixture']);
    } else { assert.equal(done.status, 'failed'); assert.equal(done.error_code, 'MODEL_NOT_CONFIGURED'); assert.equal(done.result, null); }
    const another = await api(interpretationPath, 'POST', request, 'cancel-created', 202);
    const cancelled = await api(`/interpretations/${another.id}/cancel`, 'POST', undefined, 'cancel-once', 200); assert.equal(cancelled.status, 'cancelled');
    assert.equal(await service.work(), 0);
    const retried = await api(`/interpretations/${another.id}/retry`, 'POST', { expected_attempt: 1 }, 'retry-once', 202);
    assert.equal(retried.id, another.id); assert.equal(retried.attempt, 2);
    await api(`/interpretations/${another.id}/retry`, 'POST', { expected_attempt: 1 }, undefined, 409);
    await api(`/interpretations/${another.id}/cancel`, 'POST', undefined, undefined, 403, f.viewer.access_token);
    assert.equal(await service.work(), 1);
    await api(`/media/${f.media}`, 'DELETE');
    const erased = await api(`/interpretations/${pending.id}`); assert.equal(erased.result, null); assert.deepEqual(erased.evidence, {});
    assert.equal(erased.error_code, 'MEDIA_SOURCE_DELETED');
    const manual = await api(`/behavior-records/${recorded.id}`); assert.deepEqual(manual.labels, ['barking']); assert.equal(manual.media_id, null); assert.ok(manual.media_deleted_at);
    await api(interpretationPath, 'POST', request, 'interpret-once', 404);
    await api(`/interpretations/${another.id}/retry`, 'POST', { expected_attempt: 1 }, 'retry-once', 409);
    const schema = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(schema.paths['/api/v1/pets/{id}/behavior-records'].post);
    assert.ok(schema.paths['/api/v1/pets/{id}/interpretations'].post); assert.ok(schema.paths['/api/v1/interpretations/{id}/retry'].post);
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await f.close(); }
});
