import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { AssistantService } from '../src/assistant';
import { BehaviorService } from '../src/behavior';
import { deletePetMedia } from '../src/source-invalidation';
import { behaviorFixture } from './behavior-stage-fixture';

async function httpFixture(mode: 'offline' | 'api') {
  const f = await behaviorFixture(mode), app = await createApp({ db: f.db, quiet: true }), originalFetch = globalThis.fetch;
  await app.listen(0, '127.0.0.1'); const origin = await app.getUrl(); let external = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    if (url.origin !== origin) { external++; throw new Error('External calls are forbidden by this isolated test'); }
    return originalFetch(input, init);
  };
  const api = async (path: string, method = 'GET', body?: unknown, expected = method === 'POST' ? 201 : 200, token = f.owner.access_token, key?: string) => {
    const response = await fetch(`${origin}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json() as any; assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
    return { value, response };
  };
  return { ...f, api, assistant: new AssistantService(f.db), closeHttp: async () => { globalThis.fetch = originalFetch; try { assert.equal(external, 0); await app.close(); } finally { await f.close(); } } };
}

for (const mode of ['offline', 'api'] as const) test(`text-only owner observation HTTP ${mode}: persist explicit original evidence without inventing media analysis`, { timeout: 30000 }, async () => {
  const f = await httpFixture(mode);
  try {
    const record = (await f.api(`/pets/${f.pet.id}/behavior-records`, 'POST', { labels: ['pacing'], start_at: '2026-11-24T11:58:00Z', end_at: '2026-11-24T11:59:00Z', notes: 'Synthetic original owner observation, no recording.' })).value;
    const conversation = (await f.api(`/pets/${f.pet.id}/assistant-conversations`, 'POST', { title: 'Text observation context' })).value;
    const body = { question: 'What have I recorded?', context: { kind: 'behavior', behavior_record_id: record.id } };
    const message = (await f.api(`/assistant-conversations/${conversation.id}/messages`, 'POST', body, 202, undefined, 'text-message-once')).value;
    assert.equal(message.media_id, null); assert.equal(message.evidence.media, null); assert.equal(message.evidence.used_by_model, false);
    assert.deepEqual(message.evidence.reference, { kind: 'owner_annotation', id: record.id, labels: ['pacing'], start_at: record.start_at, end_at: record.end_at, notes: record.notes });
    assert.ok(message.evidence.missing_context.includes('media_not_provided'));
    assert.equal(await f.assistant.work(), 1);
    const restored = (await f.api(`/assistant-messages/${message.id}`)).value;
    assert.equal(restored.status, mode === 'offline' ? 'succeeded' : 'failed');
    if (mode === 'offline') { assert.equal(restored.result.simulated, true); assert.equal(restored.result.evidence_usage, 'prepared_not_model_analyzed'); }
    else assert.equal(restored.error_code, 'MODEL_NOT_CONFIGURED');
    assert.equal((await new AssistantService(f.db).message(f.owner.user.id, message.id)).evidence.reference.notes, record.notes);
    assert.equal((await f.api(`/assistant-conversations/${conversation.id}/messages`, 'POST', body, 202, undefined, 'text-message-once')).value.id, message.id);
    await f.api(`/assistant-messages/${message.id}`, 'GET', undefined, 404, f.viewer.access_token);
    await f.api(`/pets/${f.pet.id}/interpretations`, 'POST', { behavior_record_id: record.id }, 400);
    const attached = await f.service.createRecord(f.owner.user.id, f.pet.id, { labels: ['barking'], start_at: '2026-11-24T11:58:00Z', end_at: '2026-11-24T11:59:00Z', media_id: f.media });
    await deletePetMedia(f.db, f.media);
    await f.api(`/assistant-conversations/${conversation.id}/messages`, 'POST', { question: 'Deleted source', context: { kind: 'behavior', behavior_record_id: attached.id } }, 409);
    const afterUnrelatedDeletion = (await f.api(`/assistant-messages/${message.id}`)).value;
    assert.equal(afterUnrelatedDeletion.evidence.reference.id, record.id);
    const other = await f.assistant.createConversation(f.stranger.user.id, f.otherPet.id, {});
    await assert.rejects(f.assistant.postMessage(f.stranger.user.id, other.id, body));
  } finally { await f.closeHttp(); }
});

test('own interpretation feedback HTTP persists, pages by current attempt and rechecks source and role', { timeout: 30000 }, async () => {
  const f = await httpFixture('offline');
  try {
    const task = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media }); await f.service.work();
    const path = `/interpretations/${task.id}/feedback`, opinion = { expected_attempt: 1, assessment: 'helpful' };
    const first = (await f.api(path, 'POST', { ...opinion, comment: 'First own feedback' })).value;
    f.advance(); const latest = (await f.api(path, 'POST', { ...opinion, comment: 'Second own feedback' })).value;
    await f.api(path, 'POST', { ...opinion, comment: 'Another member private feedback' }, 201, f.caregiver.access_token);
    const page = await f.api(`${path}?expected_attempt=1&limit=1`);
    assert.equal(page.response.headers.get('cache-control'), 'no-store'); assert.equal(page.value.items[0].id, latest.id); assert.ok(page.value.next_cursor);
    const next = (await f.api(`${path}?expected_attempt=1&limit=1&cursor=${encodeURIComponent(page.value.next_cursor)}`)).value;
    assert.equal(next.items[0].id, first.id); assert.equal(next.next_cursor, null);
    assert.equal(JSON.stringify(page.value).includes('Another member private feedback'), false);
    assert.equal((await new BehaviorService(f.db).feedbackHistory(f.owner.user.id, task.id, { expected_attempt: 1 })).items.length, 2);
    await f.api(`${path}?expected_attempt=1&cursor=${encodeURIComponent(page.value.next_cursor)}`, 'GET', undefined, 400, f.caregiver.access_token);
    await f.api(path, 'GET', undefined, 400); await f.api(`${path}?expected_attempt=2`, 'GET', undefined, 409);
    await f.api(`${path}?expected_attempt=1`, 'GET', undefined, 404, f.stranger.access_token);
    await f.identity.changeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id, { role: 'viewer' });
    assert.equal((await f.api(`${path}?expected_attempt=1`, 'GET', undefined, 200, f.caregiver.access_token)).value.items.length, 1);
    await f.api(path, 'POST', { ...opinion, comment: 'Cannot write after downgrade' }, 403, f.caregiver.access_token);
    await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id);
    await f.api(`${path}?expected_attempt=1`, 'GET', undefined, 404, f.caregiver.access_token);
    await deletePetMedia(f.db, f.media); await f.api(`${path}?expected_attempt=1`, 'GET', undefined, 409);
    assert.equal((await f.db.get('SELECT comment FROM behavior_feedback WHERE id=?', first.id))!.comment, first.comment);
  } finally { await f.closeHttp(); }
});
