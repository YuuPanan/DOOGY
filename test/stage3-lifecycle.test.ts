import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { IdentityService } from '../src/identity';
import { AccountExportService } from '../src/account-export';
import { PrivacyService } from '../src/privacy';
import { RetentionService } from '../src/retention';
import { deletePetMedia, invalidateLessonDerived, invalidatePetDerived } from '../src/source-invalidation';
import { DevicesService, provisionDevice } from '../src/devices';
import { TelemetryService } from '../src/telemetry';
import { NotificationService } from '../src/notifications';
import { openBackendFixture } from './backend-fixture';
import { seedStage3Data, stage3Tables } from './stage3-fixture';

const password = 'Synthetic-stage3-lifecycle-2026';
async function fixture() {
  process.env.DATA_MODE = 'offline';
  let now = Date.parse('2026-11-24T04:00:00.000Z');
  const backend = await openBackendFixture(() => new Date(now)), db = backend.db, identity = new IdentityService(db);
  const register = (name: string) => identity.register({ email: `stage3-lifecycle-${name}@example.invalid`, password });
  const owner = await register('owner'), member = await register('member'), viewer = await register('viewer');
  for (const [account, role] of [[member, 'caregiver'], [viewer, 'viewer']] as const) {
    const invitation = await identity.invite(owner.user.id, owner.household.id, { email: account.user.email, role });
    await identity.accept(account.user.id, invitation.token);
  }
  const pet = await identity.createPet(owner.user.id, { household_id: owner.household.id, name: 'Third batch lifecycle pet' });
  const seeded = await seedStage3Data(db, member.user.id, pet.id);
  return { ...backend, db, identity, owner, member, viewer, pet, ...seeded, exporter: new AccountExportService(db), privacy: new PrivacyService(db),
    retention: new RetentionService(db), advance: (days: number) => { now += days * 86400000; } };
}

test('第三批导出：媒体共享及原字节单条分页，问答只属本人且撤权后不导出旧家庭快照', async t => {
  const f = await fixture(); t.after(f.close);
  const scope = { household_id: f.owner.household.id };
  const media = await f.exporter.page(f.viewer.user.id, 'pet_media', scope);
  assert.equal(media.items.length, 1); assert.deepEqual(Buffer.from(media.items[0].content_base64, 'base64'), f.bytes);
  assert.equal(media.items[0].validation.codec_validated, false);
  assert.deepEqual((await f.exporter.page(f.viewer.user.id, 'behavior_records', scope)).items[0].labels, ['barking']);
  assert.equal((await f.exporter.page(f.viewer.user.id, 'interpretations', scope)).items[0].result.text, 'DERIVED_MEDIA_SECRET');
  assert.equal((await f.exporter.page(f.owner.user.id, 'assistant_messages', {})).items.length, 0);
  assert.equal((await f.exporter.page(f.member.user.id, 'assistant_messages', {})).items[0].result.text, 'DERIVED_MEDIA_SECRET');
  await f.identity.revokeMember(f.owner.user.id, f.owner.household.id, f.member.user.id);
  assert.equal((await f.exporter.page(f.member.user.id, 'assistant_messages', {})).items.length, 0);
  assert.equal((await f.exporter.page(f.member.user.id, 'assistant_conversations', {})).items.length, 0);
});

test('第三批媒体删除：清间接任务快照和全用户回执，保留手工标签、问题及补充原文', async t => {
  const f = await fixture(); t.after(f.close);
  await f.db.idempotent(f.owner.user.id, 'old-interpretation-copy', 'copy', {}, () => ({ id: f.interpretation, text: 'DERIVED_MEDIA_SECRET' }));
  await f.db.idempotent(f.member.user.id, 'old-message-copy', 'copy', {}, () => ({ id: f.message, text: 'DERIVED_MEDIA_SECRET' }));
  const deleted = await deletePetMedia(f.db, f.media);
  assert.equal(deleted.affected.assistant_messages, 1); assert.equal(deleted.affected.interpretations, 1);
  assert.equal(await f.db.get('SELECT id FROM pet_media WHERE id=?', f.media), undefined);
  const behavior = (await f.db.get('SELECT * FROM behavior_records WHERE id=?', f.behavior))!;
  assert.equal(behavior.media_id, null); assert.ok(behavior.media_deleted_at); assert.equal(behavior.notes, 'Manual behavior notes');
  const interpretation = (await f.db.get('SELECT * FROM interpretations WHERE id=?', f.interpretation))!;
  assert.equal(interpretation.status, 'failed'); assert.equal(interpretation.error_code, 'MEDIA_SOURCE_DELETED');
  assert.equal(interpretation.result_json, null); assert.equal(interpretation.evidence_json, '{}');
  assert.deepEqual(JSON.parse(interpretation.background_json), { routine: 'changed' });
  const message = (await f.db.get('SELECT * FROM assistant_messages WHERE id=?', f.message))!;
  assert.equal(message.question, 'Keep my original question'); assert.equal(message.context_json, '{}');
  assert.equal(message.result_json, null); assert.equal(message.evidence_json, '{}'); assert.equal(message.status, 'failed');
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope IN ('old-interpretation-copy','old-message-copy')"))!.n, 0);
  assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM privacy_deletions WHERE kind='pet_media' AND resource_id=?", f.media))!.n, 1);
  assert.equal((await deletePetMedia(f.db, f.media)).deleted, false);
});

test('第三批注销/共享删除：私人会话删除，待处理解释取消，分享作者匿名，宠物删除清全部五表', async t => {
  const f = await fixture(); t.after(f.close);
  await f.db.run("UPDATE interpretations SET status='processing',result_json=NULL WHERE id=?", f.interpretation);
  await f.privacy.closeAccount(f.member.user.id, { password, confirmation: 'DELETE' });
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM assistant_conversations'))!.n, 0);
  assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM assistant_messages'))!.n, 0);
  for (const table of ['pet_media','behavior_records','interpretations']) assert.equal((await f.db.get(`SELECT created_by FROM ${table} WHERE id=?`, table === 'pet_media' ? f.media : table === 'behavior_records' ? f.behavior : f.interpretation))!.created_by, null);
  assert.equal((await f.db.get('SELECT status FROM interpretations WHERE id=?', f.interpretation))!.status, 'cancelled');
  const preview = await f.privacy.petPreview(f.owner.user.id, f.pet.id);
  assert.equal(preview.counts.pet_media, 1); assert.equal(preview.counts.interpretations, 1);
  await f.privacy.deletePet(f.owner.user.id, f.pet.id, { password, confirmation: f.pet.id });
  for (const table of stage3Tables) assert.equal((await f.db.get(`SELECT COUNT(*) AS n FROM ${table}`))!.n, 0);
});

test('第三批证据失效：预览零写，活动到期清派生快照但保留媒体和原始手记', async t => {
  const f = await fixture(); t.after(f.close);
  const before = (await f.db.get('SELECT result_json FROM assistant_messages WHERE id=?', f.message))!.result_json;
  assert.equal((await invalidatePetDerived(f.db, f.pet.id, 'ACTIVITY_SOURCE_EXPIRED', true)).assistant_messages, 1);
  assert.equal((await f.db.get('SELECT result_json FROM assistant_messages WHERE id=?', f.message))!.result_json, before);
  const device = await provisionDevice(f.db, { serial_no: 'THIRD-BATCH-RETENTION' }), devices = new DevicesService(f.db);
  await devices.claim(f.owner.user.id, { ...device, pet_id: f.pet.id });
  const telemetry = new TelemetryService(f.db, devices, new NotificationService(f.db));
  await telemetry.ingest({ schema_version: '1.0', event_id: f.db.id(), device_id: device.device_id, boot_id: 'stage3-retention', seq: 1,
    event_type: 'activity.reported', device_ts: f.db.now(), payload: { start_at: f.db.now(), end_at: new Date(Date.parse(f.db.now()) + 60000).toISOString(), steps: 10 } }, device.device_token);
  await telemetry.work(); f.advance(3);
  await f.retention.update(f.owner.user.id, f.owner.household.id, { password, enabled: true, activity_days: 1 });
  const preview = (await f.retention.preview(f.owner.user.id, f.owner.household.id)).households[0];
  assert.equal(preview.related_counts.assistant_messages_invalidated, 1); assert.equal(preview.retained_counts.pet_media, 1);
  await f.retention.execute(f.owner.user.id, f.owner.household.id, { password });
  assert.equal((await f.db.get('SELECT error_code FROM assistant_messages WHERE id=?', f.message))!.error_code, 'ACTIVITY_SOURCE_EXPIRED');
  assert.equal((await f.db.get('SELECT result_json FROM interpretations WHERE id=?', f.interpretation))!.result_json, null);
  assert.ok(await f.db.get('SELECT id FROM pet_media WHERE id=?', f.media));
});

test('第三批按实际证据失效：撤回只影响引用该餐食的营养问答，活动到期保留课程与体况问答', async t => {
  const f = await fixture(); t.after(f.close);
  const recordA = f.db.id(), recordB = f.db.id();
  const message = async (kind: string, source_record_ids: string[] = []) => {
    const id = f.db.id();
    await f.db.run(`INSERT INTO assistant_messages(id,conversation_id,question,context_json,evidence_json,status,captured_mode,attempt,result_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, f.conversation, `Original ${kind} question`, JSON.stringify({ kind }), JSON.stringify({ kind, source_record_ids }),
      'succeeded', 'offline', 1, '{"text":"KEEP_UNRELATED"}', f.db.now(), f.db.now());
    return id;
  };
  const lesson = await message('lesson'), body = await message('body_check_in'), mealA = await message('nutrition', [recordA]), mealB = await message('nutrition', [recordB]);
  const linkedBody = await message('body_check_in', [recordA]), legacyBody = await message('body_check_in');
  await f.db.run('UPDATE assistant_messages SET evidence_json=? WHERE id=?', JSON.stringify({ kind: 'body_check_in', check_in: { toileting_record_id: recordA } }), legacyBody);
  const preview = await invalidatePetDerived(f.db, f.pet.id, 'CARE_SOURCE_WITHDRAWN', true, recordA);
  assert.equal(preview.interpretations, 0); assert.equal(preview.assistant_messages, 3);
  await invalidatePetDerived(f.db, f.pet.id, 'CARE_SOURCE_WITHDRAWN', false, recordA);
  assert.equal((await f.db.get('SELECT result_json FROM assistant_messages WHERE id=?', mealA))!.result_json, null);
  for (const id of [linkedBody, legacyBody]) assert.equal((await f.db.get('SELECT result_json FROM assistant_messages WHERE id=?', id))!.result_json, null);
  assert.equal((await f.db.get('SELECT status FROM interpretations WHERE id=?', f.interpretation))!.status, 'succeeded');
  await invalidatePetDerived(f.db, f.pet.id, 'ACTIVITY_SOURCE_EXPIRED');
  for (const id of [lesson, body, mealB]) assert.equal((await f.db.get('SELECT result_json FROM assistant_messages WHERE id=?', id))!.result_json, '{"text":"KEEP_UNRELATED"}');
  const noOp = await invalidatePetDerived(f.db, f.pet.id, 'UNRECOGNIZED_SOURCE');
  assert.equal(noOp.assistant_messages, 0); assert.equal(noOp.interpretations, 0);
  const lessonId = f.db.id();
  await f.db.run('INSERT INTO content_items VALUES (?,?,?,?,?,?)', lessonId, 'lesson', 1, 'withdrawn', 1, f.db.now());
  await f.db.run('UPDATE assistant_messages SET lesson_id=? WHERE id=?', lessonId, lesson);
  await f.db.idempotent(f.member.user.id, 'old-lesson-copy', 'copy', {}, () => ({ id: lesson, text: 'KEEP_UNRELATED' }));
  await invalidateLessonDerived(f.db, lessonId);
  assert.equal((await f.db.get('SELECT error_code,result_json FROM assistant_messages WHERE id=?', lesson))!.error_code, 'CONTENT_UNAVAILABLE');
  assert.equal((await f.db.get('SELECT result_json FROM assistant_messages WHERE id=?', lesson))!.result_json, null);
  assert.equal(await f.db.get('SELECT key FROM idempotency_keys WHERE scope=?', 'old-lesson-copy'), undefined);
});
