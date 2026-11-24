import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { behaviorFixture } from './behavior-stage-fixture';

for (const mode of ['offline', 'api'] as const) test(`interpretation feedback/history HTTP ${mode}: attempt provenance, source guards and frozen summary pagination`, async () => {
  const f = await behaviorFixture(mode), app = await createApp({ db: f.db, quiet: true }), originalFetch = globalThis.fetch;
  let externalCalls = 0, cacheControl: string | null = null;
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
      cacheControl = response.headers.get('cache-control'); const value = await response.json() as any;
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    }
    const historyPath = `/pets/${f.pet.id}/interpretations`, request = { media_id: f.media };
    assert.deepEqual((await api(historyPath)).items, []); assert.equal(cacheControl, 'no-store');
    const task = await api(historyPath, 'POST', request, 'create-feedback-task', 202), path = `/interpretations/${task.id}/feedback`;
    const input = { expected_attempt: 1, assessment: 'helpful', comment: '  Feedback about the stated demo  ' };
    await api(path, 'POST', input, 'pending-denied', 409);
    assert.equal(await f.service.work(), 1);
    const done = await api(`/interpretations/${task.id}`);
    if (mode === 'offline') {
      const saved = await api(path, 'POST', input, 'feedback-once');
      assert.equal(cacheControl, 'no-store'); assert.equal(saved.evidence.source, 'interpretation'); assert.equal(saved.evidence.attempt, 1);
      assert.equal(saved.evidence.evidence_id, done.evidence.id); assert.equal(saved.evidence.is_demo, true); assert.equal(saved.evidence.model_version, null);
      assert.equal(saved.evidence.execution_source, 'offline_demo'); assert.equal(saved.comment, input.comment.trim());
      assert.deepEqual(await api(path, 'POST', { ...input, comment: input.comment.trim() }, 'feedback-once'), saved);
      await api(path, 'POST', { ...input, assessment: 'incorrect' }, 'feedback-once', 409);
      await api(path, 'POST', { ...input, expected_attempt: 2 }, undefined, 409);
      await api(path, 'POST', { ...input, evidence: { source: 'interpretation' } }, undefined, 400);
      await api(path, 'POST', { ...input, comment: '  ' }, undefined, 400);
      const exportPage = await api('/auth/data-export/feedback');
      assert.equal(exportPage.items.find((row: any) => row.id === saved.id).evidence.interpretation_id, task.id);
      const peer = await api(path, 'POST', { ...input, assessment: 'incorrect' }, 'peer-feedback', 201, f.caregiver.access_token);
      assert.equal(peer.created_by, f.caregiver.user.id);
      await f.identity.changeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id, { role: 'viewer' });
      await api(path, 'POST', { ...input, assessment: 'incorrect' }, 'peer-feedback', 403, f.caregiver.access_token);
    } else {
      assert.equal(done.status, 'failed'); assert.equal(done.error_code, 'MODEL_NOT_CONFIGURED');
      await api(path, 'POST', input, 'failed-denied', 409);
    }
    await api(path, 'POST', input, undefined, 403, f.viewer.access_token);
    await api(path, 'POST', input, undefined, 404, f.stranger.access_token);
    const forged = await api(`/pets/${f.pet.id}/feedback`, 'POST', { feature_date: '2026-11-24', assessment: 'helpful', comment: 'Forged source',
      evidence: { source: 'interpretation', interpretation_id: task.id, attempt: 1 } }, undefined, 400);
    assert.equal(forged.code, 'INTERPRETATION_FEEDBACK_REQUIRED');
    const cancelled = await api(historyPath, 'POST', request, 'cancelled-task', 202);
    await api(`/interpretations/${cancelled.id}/cancel`, 'POST', undefined, undefined, 200);
    const pending = await api(historyPath, 'POST', request, 'pending-task', 202);
    const ids = [task.id, cancelled.id, pending.id].sort().reverse();
    const first = await api(historyPath + '?limit=1'); assert.equal(first.items[0].id, ids[0]); assert.ok(first.next_cursor);
    for (const field of ['result', 'evidence', 'result_json', 'evidence_json', 'background', 'background_json', 'notes']) assert.equal(field in first.items[0], false);
    assert.deepEqual((await api(historyPath + '?status=cancelled')).items.map((row: any) => row.id), [cancelled.id]);
    assert.equal((await api(historyPath + `?media_id=${f.media}`)).items.length, 3);
    f.advance(); const nextDayIntent = await api(historyPath, 'POST', request, 'newer-intent', 202);
    const next = await api(historyPath + `?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);
    assert.equal(next.from, first.from); assert.equal(next.to, first.to); assert.equal(next.items[0].id, ids[1]);
    const last = await api(historyPath + `?limit=1&cursor=${encodeURIComponent(next.next_cursor)}`);
    assert.equal(last.items[0].id, ids[2]); assert.equal(last.next_cursor, null); assert.notEqual(last.items[0].id, nextDayIntent.id);
    await api(historyPath + `?cursor=${encodeURIComponent(first.next_cursor)}`, 'GET', undefined, undefined, 400, f.viewer.access_token);
    await api(historyPath + `?status=failed&cursor=${encodeURIComponent(first.next_cursor)}`, 'GET', undefined, undefined, 400);
    await api(historyPath + `?media_id=${f.media}&cursor=${encodeURIComponent(first.next_cursor)}`, 'GET', undefined, undefined, 400);
    await api(historyPath + '?status=unknown', 'GET', undefined, undefined, 400);
    await api(historyPath + '?from=2026-10-01T00:00:00Z&to=2026-11-24T12:00:00Z', 'GET', undefined, undefined, 400);
    const peerPage = await api(historyPath + '?limit=1', 'GET', undefined, undefined, 200, f.viewer.access_token);
    await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.viewer.user.id);
    await api(historyPath + `?cursor=${encodeURIComponent(peerPage.next_cursor)}`, 'GET', undefined, undefined, 404, f.viewer.access_token);
    await api(`/media/${f.media}`, 'DELETE');
    const invalidated = await api(historyPath + '?status=failed'); assert.equal(invalidated.items.length, 4);
    assert.ok(invalidated.items.every((row: any) => row.error_code === 'MEDIA_SOURCE_DELETED' && !row.has_result));
    if (mode === 'offline') await api(path, 'POST', input, 'feedback-once', 409);
    const spec = await (await fetch(`${origin}/openapi.json`)).json() as any;
    assert.ok(spec.paths['/api/v1/pets/{id}/interpretations'].get); assert.ok(spec.paths['/api/v1/interpretations/{id}/feedback'].post);
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); await f.close(); }
});
