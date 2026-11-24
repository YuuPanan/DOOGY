import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { HttpException } from '@nestjs/common';
import { test } from 'node:test';
import { behaviorFixture } from './behavior-stage-fixture';

const status = (expected: number) => (error: unknown) => error instanceof HttpException && error.getStatus() === expected;
const record = (media: string | null = null) => ({ labels: ['  barking  '], start_at: '2026-11-24T11:58:00Z', end_at: '2026-11-24T11:59:00Z', media_id: media, notes: 'Owner annotation, not automated recognition' });

test('manual behavior preserves provenance, shared permission, exact-label history and bound cursors', async t => {
  const f = await behaviorFixture(); t.after(f.close);
  const first = await f.service.createRecord(f.owner.user.id, f.pet.id, record(f.media), 'manual-record');
  assert.deepEqual(first.labels, ['barking']); assert.equal(first.source, 'owner_annotation'); assert.equal(first.media_deleted_at, null);
  assert.deepEqual(await f.service.createRecord(f.owner.user.id, f.pet.id, record(f.media), 'manual-record'), first);
  await assert.rejects(f.service.createRecord(f.owner.user.id, f.pet.id, { ...record(), source: 'model' }));
  await assert.rejects(f.service.createRecord(f.viewer.user.id, f.pet.id, record()), status(403));
  await assert.rejects(f.service.record(f.stranger.user.id, first.id), status(404));
  await assert.rejects(f.service.createRecord(f.owner.user.id, f.pet.id, record(f.otherMedia)), status(404));
  for (const invalid of [{ labels: ['x'.repeat(101)] }, { labels: Array.from({ length: 11 }, (_, i) => `${i}`) }, { labels: [' x ', 'x'] },
    { end_at: '2026-11-25T00:00:00Z' }, { start_at: '2026-10-01T00:00:00Z' }, { start_at: '2026-11-24T12:00:00Z' }]) {
    await assert.rejects(f.service.createRecord(f.owner.user.id, f.pet.id, { ...record(), ...invalid }));
  }
  const second = await f.service.createRecord(f.caregiver.user.id, f.pet.id, { ...record(), labels: ['pacing'], start_at: '2026-11-24T11:59:00Z', end_at: '2026-11-24T12:00:00Z' });
  const query = { from: '2026-11-24T11:58:30Z', to: '2026-11-24T12:00:00Z', limit: 1 };
  const page = await f.service.listRecords(f.viewer.user.id, f.pet.id, query); assert.equal(page.items[0].id, second.id); assert.ok(page.next_cursor);
  assert.equal((await f.service.listRecords(f.viewer.user.id, f.pet.id, { ...query, cursor: page.next_cursor })).items[0].id, first.id);
  assert.deepEqual((await f.service.listRecords(f.owner.user.id, f.pet.id, { ...query, label: 'barking' })).items.map((row: any) => row.id), [first.id]);
  assert.deepEqual((await f.service.listRecords(f.owner.user.id, f.pet.id, { ...query, label: 'bark' })).items, []);
  await assert.rejects(f.service.listRecords(f.owner.user.id, f.pet.id, { ...query, cursor: page.next_cursor }), status(400));
  await assert.rejects(f.service.listRecords(f.viewer.user.id, f.pet.id, { ...query, label: 'pacing', cursor: page.next_cursor }), status(400));
});

test('offline interpretation is queued then plainly demo, with prepared evidence and no invented recognition', async t => {
  const f = await behaviorFixture(); t.after(f.close);
  const behavior = await f.service.createRecord(f.owner.user.id, f.pet.id, record(f.media));
  const input = { media_id: f.media, behavior_record_id: behavior.id, background: ['routine_changed'], notes: 'User-provided background' };
  const pending = await f.service.createInterpretation(f.caregiver.user.id, f.pet.id, input, 'demo-interpretation');
  assert.equal(pending.status, 'pending'); assert.equal(pending.attempt, 1); assert.equal(pending.result, null);
  assert.deepEqual(await f.service.createInterpretation(f.caregiver.user.id, f.pet.id, input, 'demo-interpretation'), pending);
  await assert.rejects(f.service.createInterpretation(f.viewer.user.id, f.pet.id, input), status(403));
  await assert.rejects(f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.otherMedia }), status(404));
  await assert.rejects(f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media, from: '2026-11-24T11:00:00Z' }));
  assert.equal(await f.service.work(), 1); assert.equal(await f.service.work(), 0);
  const done = await f.service.interpretation(f.viewer.user.id, pending.id);
  assert.equal(done.status, 'succeeded'); assert.equal(done.execution_source, 'offline_demo'); assert.equal(done.model_version, null);
  assert.equal(done.result.is_demo, true); assert.deepEqual(done.result.claims, []); assert.match(done.result.text, /未识别或分析音视频/);
  assert.equal(done.evidence.evidence_usage, 'prepared_not_model_analyzed'); assert.equal(done.evidence.used_by_model, false);
  assert.equal(done.evidence.media.id, f.media); assert.equal(done.evidence.window.from, '2026-11-24T11:58:00.000Z');
  assert.equal(done.evidence.window.to, '2026-11-24T11:59:00.000Z'); assert.equal(done.evidence.activity.steps, null);
  assert.equal(done.evidence.activity.source_revision, 0); assert.equal(done.evidence.activity.data_status, 'missing');
  await assert.rejects(f.service.interpretation(f.stranger.user.id, pending.id), status(404));
});

test('API missing-model failure is permanent until explicit same-ID retry; old attempts and cancellation do not reset a new attempt', async t => {
  const f = await behaviorFixture('api'); t.after(f.close);
  const pending = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media });
  assert.equal(await f.service.work(), 1);
  const failed = await f.service.interpretation(f.owner.user.id, pending.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error_code, 'MODEL_NOT_CONFIGURED'); assert.equal(failed.result, null);
  assert.equal(await f.service.work(), 0);
  const retry = await f.service.retry(f.owner.user.id, pending.id, { expected_attempt: 1 }, 'retry-once');
  assert.equal(retry.id, pending.id); assert.equal(retry.attempt, 2); assert.equal(retry.status, 'pending');
  await assert.rejects(f.service.retry(f.owner.user.id, pending.id, { expected_attempt: 1 }), status(409));
  const cancelled = await f.service.cancel(f.owner.user.id, pending.id, 'cancel-once');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(await f.service.work(), 0);
  assert.equal((await f.service.cancel(f.owner.user.id, pending.id)).status, 'cancelled');
  const next = await f.service.retry(f.owner.user.id, pending.id, { expected_attempt: 2 }); assert.equal(next.attempt, 3);
  assert.deepEqual(await f.service.retry(f.owner.user.id, pending.id, { expected_attempt: 1 }, 'retry-once'), retry);
  assert.equal((await f.service.interpretation(f.owner.user.id, pending.id)).attempt, 3);
  assert.deepEqual(await f.service.cancel(f.owner.user.id, pending.id, 'cancel-once'), cancelled);
  assert.equal((await f.service.interpretation(f.owner.user.id, pending.id)).status, 'pending');
});

test('mode changes and revoked requesters fail before processing, and retry cannot bypass current access or deleted media', async t => {
  const f = await behaviorFixture(); t.after(f.close);
  const task = await f.service.createInterpretation(f.owner.user.id, f.pet.id, { media_id: f.media });
  process.env.DATA_MODE = 'api'; await f.service.work();
  assert.equal((await f.service.interpretation(f.owner.user.id, task.id)).error_code, 'DATA_MODE_CHANGED');
  process.env.DATA_MODE = 'offline';
  const revoked = await f.service.createInterpretation(f.caregiver.user.id, f.pet.id, { media_id: f.media }, 'revoked-create');
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.caregiver.user.id);
  await f.service.work(); assert.equal((await f.service.interpretation(f.owner.user.id, revoked.id)).error_code, 'ACTOR_ACCESS_REVOKED');
  await assert.rejects(f.service.createInterpretation(f.caregiver.user.id, f.pet.id, { media_id: f.media }, 'revoked-create'), status(404));
  await f.service.retry(f.owner.user.id, revoked.id, { expected_attempt: 1 }, 'new-owner-request'); await f.service.work();
  assert.equal((await f.service.interpretation(f.owner.user.id, revoked.id)).status, 'succeeded');
  await f.db.run('DELETE FROM pet_media WHERE id=?', f.media);
  const redacted = await f.service.interpretation(f.owner.user.id, revoked.id);
  assert.equal(redacted.status, 'failed'); assert.equal(redacted.result, null); assert.deepEqual(redacted.evidence, {});
  await assert.rejects(f.service.retry(f.owner.user.id, revoked.id, { expected_attempt: 1 }, 'new-owner-request'), status(409));
});
