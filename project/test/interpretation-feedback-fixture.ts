import { strict as assert } from 'node:assert';
import { Db } from '../src/db';
import { BehaviorService } from '../src/behavior';

export async function seedInterpretationFeedback(db: Db, user: string, pet: string, media: string) {
  const behavior = new BehaviorService(db);
  const pending = await behavior.createInterpretation(user, pet, { media_id: media });
  await behavior.work();
  const completed = await behavior.interpretation(user, pending.id);
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.execution_source, 'offline_demo');
  const feedback = await behavior.feedback(user, completed.id, { expected_attempt: completed.attempt, assessment: 'helpful',
    comment: 'Synthetic feedback on a fixed offline demonstration; no media recognition was performed.' }, 'preserved-interpretation-feedback');
  return { task_id: completed.id, attempt: completed.attempt, feedback_id: feedback.id, media_id: media, evidence_id: completed.evidence.id };
}

export async function assertInterpretationFeedbackPreserved(source: Db, recovered: Db, user: string, pet: string,
  expected: Awaited<ReturnType<typeof seedInterpretationFeedback>>) {
  const original = await source.get('SELECT * FROM behavior_feedback WHERE id=?', expected.feedback_id);
  const feedback = await recovered.get('SELECT * FROM behavior_feedback WHERE id=?', expected.feedback_id);
  assert.ok(original); assert.ok(feedback); assert.deepEqual({ ...feedback }, { ...original });
  const evidence = JSON.parse(feedback.evidence_json);
  assert.equal(feedback.created_by, user); assert.equal(feedback.pet_id, pet); assert.equal(feedback.assessment, 'helpful');
  assert.equal(evidence.source, 'interpretation'); assert.equal(evidence.interpretation_id, expected.task_id);
  assert.equal(evidence.attempt, expected.attempt); assert.equal(evidence.evidence_id, expected.evidence_id); assert.equal(evidence.media_id, expected.media_id);
  assert.equal(evidence.execution_source, 'offline_demo'); assert.equal(evidence.model_version, null); assert.equal(evidence.is_demo, true);
  const task = await new BehaviorService(recovered).interpretation(user, expected.task_id);
  assert.equal(task.status, 'succeeded'); assert.equal(task.attempt, expected.attempt); assert.equal(task.evidence.id, expected.evidence_id);
  const range = { from: new Date(Date.parse(task.created_at) - 60000).toISOString(), to: new Date(Date.parse(task.created_at) + 1).toISOString(),
    status: 'succeeded', media_id: expected.media_id, limit: 1 };
  const seen = new Set<string>(); let cursor: string | undefined, pages = 0;
  do {
    const page = await new BehaviorService(recovered).listInterpretations(user, pet, { ...range, cursor });
    for (const item of page.items) {
      assert.ok(!seen.has(item.id)); seen.add(item.id);
      assert.equal(Object.hasOwn(item, 'result'), false); assert.equal(Object.hasOwn(item, 'evidence'), false);
    }
    cursor = page.next_cursor ?? undefined; pages++;
    assert.ok(pages < 20, 'Interpretation history did not finish paging');
  } while (cursor);
  assert.ok(seen.has(expected.task_id)); assert.ok(pages >= 2);
}
