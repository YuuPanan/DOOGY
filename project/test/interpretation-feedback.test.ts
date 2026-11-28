import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { test } from 'node:test';
import { deletePetMedia } from '../src/source-invalidation';
import { behaviorFixture, seedBehaviorMedia } from './behavior-stage-fixture';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const opinion = { expected_attempt: 1, assessment: 'helpful', comment: '  Feedback about the explicit demonstration  ' };

test('interpretation feedback binds the actual successful attempt, normalizes input and caches only its own feedback ID', async t => {
  const f = await behaviorFixture(); t.after(f.close);
  const task = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media });
  await assert.rejects(f.service.feedback(f.owner.user.id, task.id, opinion), status(409));
  await f.service.work();
  const saved = await f.service.feedback(f.caregiver.user.id, task.id, opinion, 'feedback-once');
  assert.equal(saved.comment, opinion.comment.trim()); assert.equal(saved.feature_date, '2026-11-24'); assert.equal(saved.created_by, f.caregiver.user.id);
  assert.deepEqual(saved.evidence, { source: 'interpretation', interpretation_id: task.id, attempt: 1, evidence_id: `${task.id}:1`, media_id: f.media,
    execution_source: 'offline_demo', model_version: null, completed_at: f.db.now(), processing_version: 'offline-demo-v1', is_demo: true });
  assert.deepEqual(await f.service.feedback(f.caregiver.user.id, task.id, { ...opinion, comment: opinion.comment.trim() }, 'feedback-once'), saved);
  const cache = await f.db.get('SELECT response_json FROM idempotency_keys WHERE user_id=? AND scope=? AND key=?', f.caregiver.user.id, `POST /interpretations/${task.id}/feedback`, 'feedback-once');
  assert.deepEqual(JSON.parse(cache!.response_json), { id: saved.id });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM behavior_feedback'))!.n, 1);
  await assert.rejects(f.service.feedback(f.caregiver.user.id, task.id, { ...opinion, assessment: 'incorrect' }, 'feedback-once'), status(409));
  await assert.rejects(f.service.feedback(f.viewer.user.id, task.id, opinion), status(403));
  await assert.rejects(f.service.feedback(f.stranger.user.id, task.id, opinion), status(404));
  await assert.rejects(f.service.feedback(f.owner.user.id, task.id, { ...opinion, expected_attempt: 2 }), status(409));
  for (const extra of [{ comment: '   ' }, { comment: 'x'.repeat(4001) }, { assessment: 'accurate' }, { evidence: { source: 'interpretation' } }, { feature_date: '2000-01-01' }]) {
    await assert.rejects(f.service.feedback(f.owner.user.id, task.id, { ...opinion, ...extra }));
  }
  await f.identity.changeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id, { role: 'viewer' });
  await assert.rejects(f.service.feedback(f.caregiver.user.id, task.id, opinion, 'feedback-once'), status(403));
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id);
  await assert.rejects(f.service.feedback(f.caregiver.user.id, task.id, opinion, 'feedback-once'), status(404));
});

test('feedback rejects failed/cancelled and stale attempts, while deleted sources cannot replay a saved feedback receipt', async t => {
  const f = await behaviorFixture('api'); t.after(f.close);
  const task = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media }); await f.service.work();
  await assert.rejects(f.service.feedback(f.owner.user.id, task.id, opinion), status(409));
  const cancelled = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media }); await f.service.cancel(f.owner.user.id, cancelled.id);
  await assert.rejects(f.service.feedback(f.owner.user.id, cancelled.id, opinion), status(409));
  process.env.DATA_MODE = 'offline';
  await f.service.retry(f.owner.user.id, task.id, { expected_attempt: 1 }); await f.service.work();
  await assert.rejects(f.service.feedback(f.owner.user.id, task.id, opinion), status(409));
  const saved = await f.service.feedback(f.owner.user.id, task.id, { ...opinion, expected_attempt: 2 }, 'attempt-two');
  assert.equal(saved.evidence.attempt, 2); assert.equal(saved.evidence.evidence_id, `${task.id}:2`);
  await deletePetMedia(f.db, f.media);
  await assert.rejects(f.service.feedback(f.owner.user.id, task.id, { ...opinion, expected_attempt: 2 }, 'attempt-two'), status(409));
  const row = await f.db.get('SELECT evidence_json,comment FROM behavior_feedback WHERE id=?', saved.id);
  assert.deepEqual(JSON.parse(row!.evidence_json), {}); assert.equal(row!.comment, saved.comment);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE user_id=? AND key=?', f.owner.user.id, 'attempt-two'), undefined);
});

test('interpretation summaries paginate frozen default windows, filter effective state and expose no result or evidence bodies', async t => {
  const f = await behaviorFixture(); t.after(f.close);
  const secondMedia = await seedBehaviorMedia(f.db, f.pet.id, f.owner.user.id);
  const cancelled = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media }); await f.service.cancel(f.owner.user.id, cancelled.id);
  const succeeded = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media }); await f.service.work();
  const failed = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: secondMedia });
  process.env.DATA_MODE = 'api'; await f.service.work(); process.env.DATA_MODE = 'offline';
  const ids = [cancelled.id, succeeded.id, failed.id].sort().reverse();
  const page = await f.service.listInterpretations(f.owner.user.id, f.pet.id, { limit: 1 });
  assert.equal(page.items[0].id, ids[0]); assert.ok(page.next_cursor);
  assert.ok(['pending', 'succeeded', 'failed', 'cancelled', 'processing'].includes(page.items[0].status));
  for (const name of ['result', 'evidence', 'result_json', 'evidence_json', 'background', 'background_json', 'notes']) assert.equal(name in page.items[0], false);
  assert.deepEqual((await f.service.listInterpretations(f.viewer.user.id, f.pet.id, { status: 'succeeded' })).items.map((row: any) => row.id), [succeeded.id]);
  assert.deepEqual((await f.service.listInterpretations(f.owner.user.id, f.pet.id, { media_id: secondMedia })).items.map((row: any) => row.id), [failed.id]);
  const exact = await f.service.listInterpretations(f.owner.user.id, f.pet.id, { from: f.db.now(), to: new Date(f.db.clock().getTime() + 1).toISOString() });
  assert.deepEqual(exact.items.map((row: any) => row.id), ids);
  f.advance(); const added = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media });
  const continuation = await f.service.listInterpretations(f.owner.user.id, f.pet.id, { limit: 1, cursor: page.next_cursor });
  assert.equal(continuation.from, page.from); assert.equal(continuation.to, page.to); assert.equal(continuation.items[0].id, ids[1]);
  const last = await f.service.listInterpretations(f.owner.user.id, f.pet.id, { limit: 1, cursor: continuation.next_cursor });
  assert.equal(last.items[0].id, ids[2]); assert.equal(last.next_cursor, null); assert.notEqual(last.items[0].id, added.id);
  await assert.rejects(f.service.listInterpretations(f.viewer.user.id, f.pet.id, { cursor: page.next_cursor }), status(400));
  await assert.rejects(f.service.listInterpretations(f.owner.user.id, f.pet.id, { cursor: page.next_cursor, status: 'failed' }), status(400));
  await assert.rejects(f.service.listInterpretations(f.owner.user.id, f.pet.id, { cursor: page.next_cursor, media_id: f.media }), status(400));
  await assert.rejects(f.service.listInterpretations(f.owner.user.id, f.pet.id, { cursor: page.next_cursor, from: '2026-11-23T00:00:00Z' }), status(400));
  await assert.rejects(f.service.listInterpretations(f.stranger.user.id, f.pet.id, {}), status(404));
  await assert.rejects(f.service.listInterpretations(f.owner.user.id, f.pet.id, { from: '2026-09-01T00:00:00Z', to: f.db.now() }), status(400));
  await deletePetMedia(f.db, secondMedia);
  const deleted = (await f.service.listInterpretations(f.owner.user.id, f.pet.id, { status: 'failed' })).items.find((row: any) => row.id === failed.id);
  assert.ok(deleted); assert.equal(deleted.error_code, 'MEDIA_SOURCE_DELETED'); assert.equal(deleted.has_result, false);
});
